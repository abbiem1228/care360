const express = require('express');
const webhookRouter  = express.Router();
const checkoutRouter = express.Router();
const Stripe  = require('stripe');
const supabase = require('../db/client');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

// Maps a plan + billing period to the actual Stripe price to charge.
// Nothing else in the app needs to know these IDs.
//
// Bundle is tiered the same way CARE 360 itself already is (Starter,
// Growth), rather than one flat option: Starter Bundle and Growth
// Bundle are their own real Stripe products, each with their own
// monthly/annual price. Element Profile's own Starter/Growth prices
// exist in Stripe too (see .env), but aren't listed here yet, since
// nothing in this app sells Element Profile on its own today; that
// purchase page is separate, not-yet-built work (see
// docs/element-profile-merge-plan.md).
const PRICE_MAP = {
  starter: {
    monthly: process.env.STRIPE_PRICE_STARTER_MONTHLY,
    annual:  process.env.STRIPE_PRICE_STARTER_ANNUAL
  },
  growth: {
    monthly: process.env.STRIPE_PRICE_GROWTH_MONTHLY,
    annual:  process.env.STRIPE_PRICE_GROWTH_ANNUAL
  },
  bundle: {
    starter: {
      monthly: process.env.STRIPE_PRICE_BUNDLE_STARTER_MONTHLY,
      annual:  process.env.STRIPE_PRICE_BUNDLE_STARTER_ANNUAL
    },
    growth: {
      monthly: process.env.STRIPE_PRICE_BUNDLE_GROWTH_MONTHLY,
      annual:  process.env.STRIPE_PRICE_BUNDLE_GROWTH_ANNUAL
    }
  }
};

// Reverse of PRICE_MAP: a Stripe price ID back to what it entitles.
// Starter and Growth both map to 'care360', matching what checkout
// already grants. Both bundle tiers map to 'bundle', the one case the
// subscription.updated webhook handler actually needs this for, since
// that price change is the only one that grants a product the account
// didn't already have.
const PRICE_TO_PRODUCTS = {};
if (PRICE_MAP.starter.monthly) PRICE_TO_PRODUCTS[PRICE_MAP.starter.monthly] = 'care360';
if (PRICE_MAP.starter.annual)  PRICE_TO_PRODUCTS[PRICE_MAP.starter.annual]  = 'care360';
if (PRICE_MAP.growth.monthly)  PRICE_TO_PRODUCTS[PRICE_MAP.growth.monthly]  = 'care360';
if (PRICE_MAP.growth.annual)   PRICE_TO_PRODUCTS[PRICE_MAP.growth.annual]   = 'care360';
for (const tier of ['starter', 'growth']) {
  if (PRICE_MAP.bundle[tier].monthly) PRICE_TO_PRODUCTS[PRICE_MAP.bundle[tier].monthly] = 'bundle';
  if (PRICE_MAP.bundle[tier].annual)  PRICE_TO_PRODUCTS[PRICE_MAP.bundle[tier].annual]  = 'bundle';
}

// A price ID back to its tier (starter/growth). Only CARE 360's own
// prices are listed here today, for the same reason PRICE_MAP has no
// element_profile entry yet: nothing sells Element Profile on its own
// yet, so no subscription can currently be on one of those prices.
// The upgrade-to-bundle route uses this to pick the matching bundle
// tier, never guessing at a tier the account isn't actually on.
const PRICE_TO_TIER = {};
if (PRICE_MAP.starter.monthly) PRICE_TO_TIER[PRICE_MAP.starter.monthly] = 'starter';
if (PRICE_MAP.starter.annual)  PRICE_TO_TIER[PRICE_MAP.starter.annual]  = 'starter';
if (PRICE_MAP.growth.monthly)  PRICE_TO_TIER[PRICE_MAP.growth.monthly]  = 'growth';
if (PRICE_MAP.growth.annual)   PRICE_TO_TIER[PRICE_MAP.growth.annual]   = 'growth';

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
      allow_promotion_codes: true,
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

// ── Manage subscription (Stripe Customer Portal) ───────────────
// One click into Stripe's own hosted portal, where a customer can
// cancel, update their payment method, or view invoices. Nothing
// here needs building or maintaining ourselves, Stripe owns the
// whole experience once they land on it.

checkoutRouter.get('/portal', requireAuth, async (req, res) => {
  if (!req.account || !req.account.stripe_customer_id) {
    return res.status(400).send('No billing account found. <a href="/plans">See plans</a>');
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: req.account.stripe_customer_id,
      return_url: `${APP_URL}/admin`
    });
    res.redirect(session.url);
  } catch (e) {
    console.error('Portal session failed:', e.message);
    res.status(500).send('Could not open billing management right now. Please try again.');
  }
});

// ── Upgrade to the Bundle ────────────────────────────────────
// The only in-dashboard way an account ever gains its second product.
// Changes the price on the account's existing subscription to the
// bundle price matching its current billing interval, never the
// opposite interval (see docs/element-profile-merge-plan.md for why:
// crossing intervals reshapes the whole billing period and produces a
// much larger prorated charge). This route only triggers the change.
// It writes nothing to Supabase, same discipline as checkout: the
// customer.subscription.updated webhook below is what actually updates
// account_subscriptions and the entitlement flags, once Stripe
// confirms the change really happened.

checkoutRouter.post('/upgrade-to-bundle', requireAuth, async (req, res) => {
  if (!req.accountId) {
    return res.redirect('/signin');
  }

  // Fails fast, before touching Supabase or Stripe at all: if the
  // bundle prices for either tier aren't configured in this
  // environment (e.g. STRIPE_PRICE_BUNDLE_* not yet set here), this is
  // not a customer's mistake and not a server error to hide behind a
  // generic message. Say so plainly.
  const bundleConfigured =
    PRICE_MAP.bundle.starter.monthly && PRICE_MAP.bundle.starter.annual &&
    PRICE_MAP.bundle.growth.monthly  && PRICE_MAP.bundle.growth.annual;

  if (!bundleConfigured) {
    console.error('Upgrade to bundle: bundle prices are not configured in this environment');
    return res.status(400).send('Bundle upgrades aren\'t available yet. <a href="/admin">Back to dashboard</a>');
  }

  try {
    const { data: activeSubs, error } = await supabase
      .from('account_subscriptions')
      .select('stripe_subscription_id')
      .eq('account_id', req.accountId)
      .eq('status', 'active');

    if (error) throw error;

    if (!activeSubs || activeSubs.length !== 1) {
      console.error(`Upgrade to bundle: expected exactly one active subscription for account ${req.accountId}, found ${activeSubs ? activeSubs.length : 0}`);
      return res.status(400).send('Could not find a single active subscription to upgrade. <a href="/admin">Back to dashboard</a>');
    }

    const subscription     = await stripe.subscriptions.retrieve(activeSubs[0].stripe_subscription_id);
    const currentPriceId   = subscription.items.data[0].price.id;
    const currentInterval  = subscription.items.data[0].price.recurring.interval;
    const currentTier      = PRICE_TO_TIER[currentPriceId];

    if (!currentTier) {
      console.error(`Upgrade to bundle: unrecognized current price ${currentPriceId} for account ${req.accountId}, cannot determine tier`);
      return res.status(400).send('Could not determine your current plan. <a href="/admin">Back to dashboard</a>');
    }

    const bundlePriceId = currentInterval === 'year' ? PRICE_MAP.bundle[currentTier].annual : PRICE_MAP.bundle[currentTier].monthly;

    if (!bundlePriceId) {
      console.error(`Upgrade to bundle: no bundle price configured for tier ${currentTier}, interval ${currentInterval}`);
      return res.status(400).send('Bundle upgrades aren\'t available yet. <a href="/admin">Back to dashboard</a>');
    }

    await stripe.subscriptions.update(subscription.id, {
      items: [{ id: subscription.items.data[0].id, price: bundlePriceId }],
      proration_behavior: 'create_prorations'
    });

    res.redirect('/billing/checkout/success');
  } catch (e) {
    console.error('Upgrade to bundle failed:', e.message);
    res.status(500).send('Something went wrong starting the upgrade. <a href="/admin">Back to dashboard</a>');
  }
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
      // Not sent by checkout yet (that's the next piece of work, not
      // this one), so this defaults to 'care360' since that is the
      // only product real checkout sessions represent today. Once
      // checkout creation starts sending this, it flows through
      // unchanged, no second edit needed here.
      const products  = (session.metadata && session.metadata.products) || 'care360';

      if (accountId && plan) {
        // stripe_subscription_id no longer written here: an account
        // can hold more than one active subscription (see
        // account_subscriptions, schema/007), so a single column on
        // accounts can't represent that. plan/status/stripe_customer_id
        // stay here unchanged; those are still meaningfully singular
        // per account today.
        await supabase.from('accounts').update({
          plan,
          status: 'active',
          stripe_customer_id: session.customer
        }).eq('id', accountId);

        if (session.subscription) {
          await supabase.from('account_subscriptions').insert({
            account_id: accountId,
            stripe_subscription_id: session.subscription,
            products,
            status: 'active'
          });
        }
        console.log(`Account ${accountId} upgraded to ${plan}`);
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const { data: subscriptionRow } = await supabase
        .from('account_subscriptions')
        .update({ status: 'canceled', updated_at: new Date().toISOString() })
        .eq('stripe_subscription_id', sub.id)
        .select()
        .maybeSingle();

      // accounts.status still gets updated too, unchanged from today's
      // behavior, looked up via the new table instead of the old
      // column. It has the same one-value-for-possibly-several-
      // subscriptions shape of gap as stripe_subscription_id did, just
      // not fixed as part of this change.
      if (subscriptionRow) {
        await supabase.from('accounts').update({ status: 'canceled' }).eq('id', subscriptionRow.account_id);
      }
      console.log(`Subscription ${sub.id} canceled`);
    }

    if (event.type === 'customer.subscription.updated') {
      const sub        = event.data.object;
      const newPriceId = sub.items.data[0].price.id;
      const products    = PRICE_TO_PRODUCTS[newPriceId];

      // An unrecognized price isn't this app's concern (Stripe fires
      // this event for plenty of changes that aren't a price swap we
      // originated), so only act when the new price is one we know.
      if (products) {
        const { data: subscriptionRow } = await supabase
          .from('account_subscriptions')
          .update({ products, status: 'active', updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', sub.id)
          .select()
          .maybeSingle();

        if (subscriptionRow) {
          // Additive only, same as every other entitlement write in this
          // app: an upgrade only ever turns a flag on, never off.
          const entitlements = { has_care360: true };
          if (products === 'bundle') entitlements.has_element_profile = true;

          const { data: account } = await supabase
            .from('accounts')
            .update(entitlements)
            .eq('id', subscriptionRow.account_id)
            .select()
            .maybeSingle();

          // First time this account has gained Element Profile access this
          // way: it needs the organizations row it never had, so upgrading
          // is more than just an entitlement flag flip.
          if (products === 'bundle' && account) {
            const { data: existingOrg } = await supabase
              .from('organizations')
              .select('id')
              .eq('account_id', account.id)
              .maybeSingle();

            if (!existingOrg) {
              await supabase.from('organizations').insert({
                account_id: account.id,
                name: account.name
              });
            }
          }
        }
        console.log(`Subscription ${sub.id} price changed, now entitles: ${products}`);
      }
    }

    if (event.type === 'invoice.payment_failed') {
      const inv = event.data.object;
      if (inv.subscription) {
        const { data: subscriptionRow } = await supabase
          .from('account_subscriptions')
          .update({ status: 'past_due', updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', inv.subscription)
          .select()
          .maybeSingle();

        if (subscriptionRow) {
          await supabase.from('accounts').update({ status: 'past_due' }).eq('id', subscriptionRow.account_id);
        }
        console.log(`Subscription ${inv.subscription} marked past due`);
      }
    }
  } catch (e) {
    console.error('Webhook handling failed:', e.message);
  }

  res.json({ received: true });
});

module.exports = { checkoutRouter, webhookRouter };
