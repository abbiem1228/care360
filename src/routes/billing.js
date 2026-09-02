const express = require('express');
const webhookRouter  = express.Router();
const checkoutRouter = express.Router();
const Stripe  = require('stripe');
const supabase = require('../db/client');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

// Maps a plan + billing period to the actual Stripe price to charge.
// Nothing else in the app needs to know these IDs.
const PRICE_MAP = {
  starter: {
    monthly: process.env.STRIPE_PRICE_STARTER_MONTHLY,
    annual:  process.env.STRIPE_PRICE_STARTER_ANNUAL
  },
  growth: {
    monthly: process.env.STRIPE_PRICE_GROWTH_MONTHLY,
    annual:  process.env.STRIPE_PRICE_GROWTH_ANNUAL
  }
};

function requireAuth(req, res, next) {
  if (req.isAdmin) return next();
  res.redirect('/signin');
}

// ── Start checkout ───────────────────────────────────────────
// Called when a signed in user clicks Upgrade to Starter/Growth.
// GET, not POST, so the plans page can link straight to it.
// This router is mounted AFTER the session middleware, so req.isAdmin
// and req.accountId are already set by the time this runs.

checkoutRouter.get('/checkout', requireAuth, async (req, res) => {
  const plan    = req.query.plan;
  const billing = req.query.billing === 'annual' ? 'annual' : 'monthly';
  const priceId = PRICE_MAP[plan] && PRICE_MAP[plan][billing];

  if (!priceId) {
    return res.status(400).send('Unknown plan. <a href="/plans">Back to plans</a>');
  }

  if (!req.accountId) {
    return res.redirect('/signin');
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${APP_URL}/billing/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${APP_URL}/plans`,
      customer_email: req.session ? req.session.email : undefined,
      client_reference_id: req.accountId,
      metadata: { account_id: req.accountId, plan }
    });

    res.redirect(session.url);
  } catch (e) {
    console.error('Checkout session failed:', e.message);
    res.status(500).send('Something went wrong starting checkout. <a href="/plans">Back to plans</a>');
  }
});

// ── Return from Stripe ───────────────────────────────────────
// The webhook is what actually flips the plan. This page just gives
// the person something to look at while that happens, since the
// webhook can arrive a few seconds after the redirect.

checkoutRouter.get('/checkout/success', requireAuth, (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"/>
  <meta http-equiv="refresh" content="3;url=/admin"/>
  <style>body{font-family:Arial,sans-serif;background:#F7F4EF;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#fff;border-radius:10px;padding:48px;max-width:440px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.08);border-top:4px solid #7C8863}
  h2{color:#30383B;font-size:20px;margin-bottom:10px}p{color:#595959;font-size:14px;line-height:1.6}</style></head>
  <body><div class="card"><h2>Thank you</h2><p>Your subscription is being set up. This takes a few seconds. You will be taken to your dashboard automatically.</p></div></body></html>`);
});

// ── Stripe webhook ───────────────────────────────────────────
// This is the only place that actually changes an account's plan.
// Never trust the browser redirect alone, since a closed tab or a
// flaky connection would leave the account stuck on trial despite
// a successful charge.
//
// This router is mounted BEFORE express.json() in server.js, and the
// route itself uses express.raw() so it sees the completely untouched
// request body. Stripe's signature check fails if anything upstream
// has already parsed the body, which is why this route must never be
// moved to sit after express.json() runs.

webhookRouter.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('Webhook signature check failed:', e.message);
    return res.status(400).send('Signature verification failed');
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session   = event.data.object;
      const accountId = session.client_reference_id;
      const plan      = session.metadata && session.metadata.plan;

      if (accountId && plan) {
        await supabase.from('accounts').update({
          plan,
          status: 'active',
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription
        }).eq('id', accountId);
        console.log(`Account ${accountId} upgraded to ${plan}`);
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      await supabase.from('accounts').update({ status: 'canceled' }).eq('stripe_subscription_id', sub.id);
      console.log(`Subscription ${sub.id} canceled`);
    }

    if (event.type === 'invoice.payment_failed') {
      const inv = event.data.object;
      if (inv.subscription) {
        await supabase.from('accounts').update({ status: 'past_due' }).eq('stripe_subscription_id', inv.subscription);
        console.log(`Subscription ${inv.subscription} marked past due`);
      }
    }
  } catch (e) {
    console.error('Webhook handling failed:', e.message);
  }

  res.json({ received: true });
});

module.exports = { checkoutRouter, webhookRouter };
