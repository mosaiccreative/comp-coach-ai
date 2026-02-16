const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { ClerkExpressRequireAuth } = require('@clerk/clerk-sdk-node');
const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Middleware
app.use(cors());
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'CompCoach.ai API',
    clerk: process.env.CLERK_SECRET_KEY ? 'configured' : 'missing',
    stripe: process.env.STRIPE_SECRET_KEY ? 'configured' : 'missing',
    supabase: process.env.SUPABASE_URL ? 'configured' : 'missing',
    anthropic: process.env.ANTHROPIC_API_KEY ? 'configured' : 'missing'
  });
});

// Get user subscription
app.get('/api/subscription', ClerkExpressRequireAuth(), async (req, res) => {
  try {
    const userId = req.auth.userId;
    
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('clerk_user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Supabase error:', error);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!user) {
      const { data: newUser, error: createError } = await supabase
        .from('users')
        .insert({
          clerk_user_id: userId,
          subscription_tier: 'free',
          subscription_status: 'active',
          usage_count: 0
        })
        .select()
        .single();

      if (createError) {
        console.error('Error creating user:', createError);
        return res.status(500).json({ error: 'Failed to create user' });
      }

      return res.json({
        tier: 'free',
        status: 'active',
        usage_count: 0
      });
    }

    res.json({
      tier: user.subscription_tier,
      status: user.subscription_status,
      usage_count: user.usage_count || 0,
      stripe_customer_id: user.stripe_customer_id
    });

  } catch (error) {
    console.error('Subscription check error:', error);
    res.status(500).json({ error: 'Failed to check subscription' });
  }
});

// Create checkout session
app.post('/api/create-checkout', ClerkExpressRequireAuth(), async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { priceId, tier } = req.body;

    let { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('clerk_user_id', userId)
      .single();

    if (!user) {
      const { data: newUser } = await supabase
        .from('users')
        .insert({
          clerk_user_id: userId,
          subscription_tier: 'free',
          subscription_status: 'active'
        })
        .select()
        .single();
      user = newUser;
    }

    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        metadata: { clerk_user_id: userId }
      });
      customerId = customer.id;

      await supabase
        .from('users')
        .update({ stripe_customer_id: customerId })
        .eq('clerk_user_id', userId);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{
        price: priceId,
        quantity: 1
      }],
      mode: 'subscription',
      success_url: `${process.env.APP_URL || 'http://localhost:3000'}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL || 'http://localhost:3000'}`,
      metadata: {
        clerk_user_id: userId,
        tier: tier
      }
    });

    res.json({ url: session.url });

  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Stripe webhook
app.post('/api/stripe-webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
    const subscription = event.data.object;
    const customerId = subscription.customer;
    
    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('stripe_customer_id', customerId)
      .single();

    if (user) {
      const priceId = subscription.items.data[0].price.id;
      let tier = 'free';
      
      if (priceId === process.env.STRIPE_PRICE_PRO) tier = 'individual';
      if (priceId === process.env.STRIPE_PRICE_PREMIUM) tier = 'premium';

      await supabase
        .from('users')
        .update({
          subscription_tier: tier,
          subscription_status: subscription.status,
          stripe_subscription_id: subscription.id
        })
        .eq('stripe_customer_id', customerId);
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const customerId = subscription.customer;

    await supabase
      .from('users')
      .update({
        subscription_tier: 'free',
        subscription_status: 'canceled'
      })
      .eq('stripe_customer_id', customerId);
  }

  res.json({ received: true });
});

// AI chat endpoint
app.post('/api/chat', ClerkExpressRequireAuth(), async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { model, max_tokens, system, messages } = req.body;

    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('clerk_user_id', userId)
      .single();

    if (!user) {
      return res.status(403).json({ error: 'User not found' });
    }

    const limits = {
      free: 3,
      individual: 999999,
      premium: 999999
    };

    const userLimit = limits[user.subscription_tier] || 3;
    
    if (user.usage_count >= userLimit) {
      return res.status(403).json({ 
        error: 'Usage limit reached. Please upgrade your plan.',
        limit_reached: true
      });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'Server configuration error: API key not set' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model || 'claude-sonnet-4-20250514',
        max_tokens: max_tokens || 1000,
        system,
        messages
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Anthropic API error:', errorData);
      return res.status(response.status).json({ 
        error: errorData.error?.message || 'Failed to get response from AI' 
      });
    }

    const data = await response.json();

    await supabase
      .from('users')
      .update({ usage_count: (user.usage_count || 0) + 1 })
      .eq('clerk_user_id', userId);

    res.json(data);

  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ error: 'Internal server error. Please try again.' });
  }
});

app.listen(PORT, () => {
  console.log(`CompCoach.ai running on port ${PORT}`);
});
