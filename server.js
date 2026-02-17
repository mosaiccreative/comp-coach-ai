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

// Get latest compensation news
app.get('/api/news', async (req, res) => {
  try {
    if (!process.env.NEWSAPI_KEY) {
      return res.status(500).json({ error: 'NewsAPI key not configured' });
    }

    // Very specific query - focus on employment compensation only
    const response = await fetch(
      `https://newsapi.org/v2/everything?q=("salary negotiation" OR "tech salaries" OR "pay equity" OR "wage gap" OR "salary transparency" OR "remote work pay" OR "compensation trends" OR "layoffs severance" OR "minimum wage" OR "living wage")&language=en&sortBy=publishedAt&pageSize=50&apiKey=${process.env.NEWSAPI_KEY}`
    );

    if (!response.ok) {
      console.error('NewsAPI error:', response.status);
      return res.status(500).json({ error: 'Failed to fetch news' });
    }

    const data = await response.json();

    // Helper function to get relative time
    const getRelativeTime = (dateString) => {
      const now = new Date();
      const published = new Date(dateString);
      const diffMs = now - published;
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      const diffDays = Math.floor(diffHours / 24);

      if (diffHours < 1) return 'Just now';
      if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
      if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
      return `${Math.floor(diffDays / 7)} week${Math.floor(diffDays / 7) > 1 ? 's' : ''} ago`;
    };

    // Helper to categorize article
    const categorize = (title) => {
      const lower = title.toLowerCase();
      if (lower.includes('equity') || lower.includes('stock') || lower.includes('rsu') || lower.includes('stock option')) return 'Equity';
      if (lower.includes('remote') || lower.includes('hybrid') || lower.includes('wfh')) return 'Remote Work';
      if (lower.includes('negotiat')) return 'Negotiation';
      if (lower.includes('gender') || lower.includes('pay gap') || lower.includes('pay equity')) return 'Pay Equity';
      if (lower.includes('layoff') || lower.includes('severance')) return 'Layoffs';
      return 'Market Trends';
    };

    // Strict filtering logic
    const isRelevant = (article) => {
      if (!article.title || !article.description || !article.url) return false;
      
      const title = article.title.toLowerCase();
      const desc = article.description.toLowerCase();
      const source = article.source.name.toLowerCase();
      const combined = `${title} ${desc}`;
      
      // HARD EXCLUDE - these automatically disqualify the article
      const excludeKeywords = [
        // Sports
        'nfl', 'nba', 'mlb', 'nhl', 'mls', 'fifa', 'espn', 'athlete', 'quarterback', 'pitcher', 'playoffs',
        // Corporate filings (not news)
        'inducement grant', 'nasdaq listing rule', '8-k', 'sec filing', 'form 10', 'announces appointment',
        // Legal/Insurance
        'workers compensation insurance', 'workers comp claim', 'settlement', 'lawsuit', 'court award',
        // Job postings (not news)
        'seeks', 'hiring for', 'job opening', 'apply now', 'careers page',
        // Crypto/Finance (not employment)
        'crypto', 'bitcoin', 'mining reward', 'staking reward',
        // Government payments (not employment)
        'stimulus', 'relief payment', 'tax refund', 'benefits claim'
      ];
      
      if (excludeKeywords.some(keyword => combined.includes(keyword))) return false;
      
      // REQUIRED - must have at least ONE of these employment-related terms
      const employmentTerms = [
        'salary', 'salaries', 'wage', 'wages', 'pay', 'paid', 'compensation',
        'employee', 'employees', 'worker', 'workers', 'staff',
        'job', 'jobs', 'career', 'hiring', 'layoff', 'layoffs'
      ];
      
      const hasEmploymentTerm = employmentTerms.some(term => combined.includes(term));
      if (!hasEmploymentTerm) return false;
      
      // CONTEXT - if it mentions compensation, it should be about employment, not other contexts
      if (combined.includes('compensation')) {
        // Make sure it's employment compensation, not legal/insurance
        const employmentContext = [
          'employee compensation', 'executive compensation', 'tech compensation',
          'salary', 'wage', 'pay equity', 'total comp', 'stock', 'equity',
          'bonus', 'benefits package', 'rsu', 'stock option'
        ];
        if (!employmentContext.some(ctx => combined.includes(ctx))) return false;
      }
      
      // TRUSTED SOURCES - prioritize business/tech/HR news sources
      const trustedSources = [
        'techcrunch', 'bloomberg', 'wsj', 'wall street journal', 'forbes', 'fortune',
        'business insider', 'cnbc', 'reuters', 'financial times', 'ft.com',
        'harvard business review', 'hbr', 'mit', 'wired', 'verge', 'ars technica',
        'shrm', 'hr dive', 'linkedin', 'glassdoor', 'indeed'
      ];
      
      const isTrustedSource = trustedSources.some(s => source.includes(s));
      
      // If not from trusted source, require stronger employment signals
      if (!isTrustedSource) {
        const strongSignals = [
          'salary negotiation', 'tech salaries', 'pay equity', 'wage gap',
          'compensation trends', 'remote work pay', 'layoff', 'severance',
          'minimum wage', 'living wage', 'salary transparency'
        ];
        if (!strongSignals.some(signal => combined.includes(signal))) return false;
      }
      
      return true;
    };

    // Gradient options
    const gradients = [
      'from-blue-400 to-cyan-500',
      'from-purple-400 to-pink-500',
      'from-emerald-400 to-teal-500',
      'from-orange-400 to-red-500',
      'from-indigo-400 to-violet-500',
      'from-rose-400 to-pink-500'
    ];

    // Format articles for frontend
    const news = data.articles
      .filter(isRelevant)
      .slice(0, 6)
      .map((article, idx) => ({
        title: article.title,
        excerpt: article.description,
        source: article.source.name,
        url: article.url,
        time: getRelativeTime(article.publishedAt),
        category: categorize(article.title),
        gradient: gradients[idx % gradients.length]
      }));

    res.json(news);

  } catch (error) {
    console.error('News fetch error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Waitlist signup (public endpoint - no auth required)
app.post('/api/waitlist', async (req, res) => {
  try {
    const { email, name, tier } = req.body;

    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }

    // Check if email already exists
    const { data: existing } = await supabase
      .from('waitlist')
      .select('id')
      .eq('email', email.toLowerCase())
      .single();

    if (existing) {
      return res.json({ success: true, message: 'Already on waitlist!' });
    }

    // Add to waitlist
    const { data, error} = await supabase
      .from('waitlist')
      .insert({
        email: email.toLowerCase(),
        name: name || null,
        tier_interest: tier || 'pro',
        source: 'website',
        status: 'pending'
      })
      .select()
      .single();

    if (error) {
      console.error('Waitlist error:', error);
      return res.status(500).json({ error: 'Failed to join waitlist' });
    }

    res.json({ success: true, message: 'Added to waitlist!' });

  } catch (error) {
    console.error('Waitlist signup error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
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
          subscription_tier: 'premium', // Beta mode: everyone gets premium free
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
        tier: 'premium',
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

// Create billing portal session
app.post('/api/create-portal-session', ClerkExpressRequireAuth(), async (req, res) => {
  try {
    const userId = req.auth.userId;

    const { data: user } = await supabase
      .from('users')
      .select('stripe_customer_id')
      .eq('clerk_user_id', userId)
      .single();

    if (!user?.stripe_customer_id) {
      return res.status(400).json({ error: 'No billing account found. Subscribe to a plan first.' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: process.env.APP_URL || 'http://localhost:3000'
    });

    res.json({ url: session.url });

  } catch (error) {
    console.error('Portal session error:', error);
    res.status(500).json({ error: 'Failed to create billing portal session' });
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
