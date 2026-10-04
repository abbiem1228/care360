const express = require('express');
const webhookRouter  = express.Router();
const checkoutRouter = express.Router();
const Stripe  = require('stripe');
const supabase = require('../db/client');
const {
  CARE360_TERMS_URL, CARE360_PRIVACY_URL, ELEMENT_TERMS_URL, ELEMENT_PRIVACY_URL
} = require('./account');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

// Maps a product + tier + billing period to the actual Stripe price to
// charge. Nothing else in the app needs to know these IDs. All three
// products are tiered the same consistent way (Starter, Growth): each
// is its own real Stripe product family, each tier with its own
// monthly/annual price.
const PRICE_MAP = {
  care360: {
    starter: {
      monthly: process.env.STRIPE_PRICE_STARTER_MONTHLY,
      annual:  process.env.STRIPE_PRICE_STARTER_ANNUAL
    },
    growth: {
      monthly: process.env.STRIPE_PRICE_GROWTH_MONTHLY,
      annual:  process.env.STRIPE_PRICE_GROWTH_ANNUAL
    }
  },
  element_profile: {
    starter: {
      monthly: process.env.STRIPE_PRICE_ELEMENT_STARTER_MONTHLY,
      annual:  process.env.STRIPE_PRICE_ELEMENT_STARTER_ANNUAL
    },
    growth: {
      monthly: process.env.STRIPE_PRICE_ELEMENT_GROWTH_MONTHLY,
      annual:  process.env.STRIPE_PRICE_ELEMENT_GROWTH_ANNUAL
    }
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

const ALL_PRODUCTS = ['care360', 'element_profile', 'bundle'];
const ALL_TIERS     = ['starter', 'growth'];

// Reverse of PRICE_MAP: a Stripe price ID back to what it entitles.
// Used by syncSubscription, the one place that goes from a Stripe
// subscription to what the account actually has now.
const PRICE_TO_PRODUCTS = {};
for (const products of ALL_PRODUCTS) {
  for (const tier of ALL_TIERS) {
    if (PRICE_MAP[products][tier].monthly) PRICE_TO_PRODUCTS[PRICE_MAP[products][tier].monthly] = products;
    if (PRICE_MAP[products][tier].annual)  PRICE_TO_PRODUCTS[PRICE_MAP[products][tier].annual]  = products;
  }
}

// A price ID back to its tier (starter/growth), for all three
// products. syncSubscription records it on each subscription row, and
// the upgrade-to-bundle route reads a single-product subscription's
// current tier from it (it never sees a bundle price, since an account
// already on the Bundle has nothing left to add).
const PRICE_TO_TIER = {};
for (const products of ALL_PRODUCTS) {
  for (const tier of ALL_TIERS) {
    if (PRICE_MAP[products][tier].monthly) PRICE_TO_TIER[PRICE_MAP[products][tier].monthly] = tier;
    if (PRICE_MAP[products][tier].annual)  PRICE_TO_TIER[PRICE_MAP[products][tier].annual]  = tier;
  }
}

function requireAuth(req, res, next) {
  if (req.isAdmin) return next();
  res.redirect('/signin');
}

// Same product-aware logic as the signup checkbox (src/routes/account.js):
// a Bundle purchase is agreeing to two distinct products' real terms, so
// the consent message names and links both, not one document covering
// both. Stripe's own consent_collection.terms_of_service checkbox is
// what's actually shown on Stripe's page; this message is only the text
// next to it, so it also states plainly which document(s) the checkbox
// covers for whichever purchase this session actually is.
function termsConsentMessage(products) {
  if (products === 'element_profile') {
    return `I agree to Element Profile's [Terms of Service](${ELEMENT_TERMS_URL}) and [Privacy Policy](${ELEMENT_PRIVACY_URL}).`;
  }
  if (products === 'bundle') {
    return `I agree to CARE 360's [Terms of Service](${CARE360_TERMS_URL}) and [Privacy Policy](${CARE360_PRIVACY_URL}), and to Element Profile's [Terms of Service](${ELEMENT_TERMS_URL}) and [Privacy Policy](${ELEMENT_PRIVACY_URL}).`;
  }
  return `I agree to CARE 360's [Terms of Service](${CARE360_TERMS_URL}) and [Privacy Policy](${CARE360_PRIVACY_URL}).`;
}

// ── Start checkout ───────────────────────────────────────────
// Called when a signed in user picks a plan from /plans: tier is
// strictly which tier (starter/growth), products is strictly which
// product(s) that tier buys (care360/element_profile/bundle). Neither
// one implies the other.
// GET, not POST, so the plans page can link straight to it.
// This router is mounted AFTER the session middleware, so req.isAdmin
// and req.accountId are already set by the time this runs.

checkoutRouter.get('/checkout', requireAuth, async (req, res) => {
  const tier     = req.query.tier;
  const products = req.query.products;
  const billing  = req.query.billing === 'annual' ? 'annual' : 'monthly';
  const priceId  = PRICE_MAP[products] && PRICE_MAP[products][tier] && PRICE_MAP[products][tier][billing];

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
      // Carried onto the subscription itself, so every later webhook
      // can find its account even if it arrives before
      // checkout.session.completed does.
      subscription_data: { metadata: { account_id: req.accountId } },
      success_url: `${APP_URL}/billing/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${APP_URL}/plans`,
      // Reuse the account's existing Stripe customer, so every product
      // it buys sits under one customer and one Manage billing portal.
      // A brand new account has none yet, so Stripe creates one.
      ...(req.account && req.account.stripe_customer_id
        ? { customer: req.account.stripe_customer_id }
        : { customer_email: req.session ? req.session.email : undefined }),
      client_reference_id: req.accountId,
      metadata: { account_id: req.accountId, tier, products },
      consent_collection: { terms_of_service: 'required' },
      custom_text: { terms_of_service_acceptance: { message: termsConsentMessage(products) } }
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

// Where Stripe's portal may send someone back to. Only this app and
// Element Profile, matched by exact origin, so ?return= can never send
// a customer anywhere else. Anything missing or not allowed falls back
// to this app's own dashboard, same as before.
const ELEMENT_PROFILE_URL = process.env.ELEMENT_PROFILE_URL || 'https://element.ingoodcocollective.com';
const PORTAL_RETURN_ORIGINS = [APP_URL, ELEMENT_PROFILE_URL].map(u => new URL(u).origin);

function portalReturnUrl(raw) {
  if (typeof raw === 'string') {
    try {
      const u = new URL(raw);
      if (PORTAL_RETURN_ORIGINS.includes(u.origin)) return u.toString();
    } catch (e) { /* not a URL, fall through */ }
  }
  return `${APP_URL}/admin`;
}

checkoutRouter.get('/portal', requireAuth, async (req, res) => {
  if (!req.account || !req.account.stripe_customer_id) {
    return res.status(400).send('No billing account found. <a href="/plans">See plans</a>');
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: req.account.stripe_customer_id,
      return_url: portalReturnUrl(req.query.return)
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

// Shown when an account already holds CARE 360 and Element Profile as
// two separate subscriptions. Merging them into one Bundle subscription
// is done by hand for now.
const SWITCH_TO_BUNDLE_MESSAGE = 'You have CARE 360 and Element Profile as separate subscriptions. To switch them to a Bundle, email <a href="mailto:info@ingoodcocollective.com?subject=Switch%20to%20a%20Bundle">info@ingoodcocollective.com</a> and we\'ll take care of it. <a href="/admin">Back to dashboard</a>';

async function liveSubscriptionCount(accountId) {
  const { data, error } = await supabase
    .from('account_subscriptions')
    .select('stripe_subscription_id')
    .eq('account_id', accountId)
    .in('status', LIVE_STATUSES);
  if (error) throw error;
  return data.length;
}

// The one new product an "Upgrade to Bundle" click actually adds, for
// whichever account is asking: an account only ever sees this option
// (src/routes/admin.js's bundleReminder) when it genuinely has exactly
// one of the two products already, so exactly one is missing.
function missingProduct(account) {
  if (account && account.has_care360 && !account.has_element_profile) return 'element_profile';
  if (account && account.has_element_profile && !account.has_care360) return 'care360';
  return null;
}

function upgradeConfirmPage(products, error) {
  const isElement = products === 'element_profile';
  const productName = isElement ? 'Element Profile' : 'CARE 360';
  const termsUrl    = isElement ? ELEMENT_TERMS_URL   : CARE360_TERMS_URL;
  const privacyUrl  = isElement ? ELEMENT_PRIVACY_URL : CARE360_PRIVACY_URL;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Add ${productName} — CARE 360</title>
  <style>
    body{font-family:Arial,sans-serif;background:#F7F4EF;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
    .card{background:#fff;border-radius:10px;padding:40px;max-width:460px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,0.08);border-top:4px solid #A9633D}
    h2{color:#30383B;font-size:20px;margin:0 0 10px}
    p{color:#595959;font-size:14px;line-height:1.6;margin:0 0 20px}
    .err{background:#FFF7F6;border:1px solid #FDDDD9;color:#A94442;border-radius:6px;padding:10px 14px;font-size:13px;margin-bottom:18px}
    .terms-label{display:flex;align-items:flex-start;gap:8px;font-size:13.5px;color:#30383B;margin-bottom:22px}
    .terms-label input{margin-top:3px}
    .terms-label a{color:#A9633D}
    .actions{display:flex;gap:10px}
    button{font-family:inherit;font-weight:600;font-size:14px;cursor:pointer;border-radius:6px;border:none;padding:11px 20px}
    .primary{background:#30383B;color:#fff;flex:1}
    .ghost{background:#EDE8DF;color:#30383B;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}
  </style></head>
  <body><div class="card">
    <h2>Add ${productName} to your account</h2>
    <p>Your subscription will switch to the Bundle price for your current tier and billing interval, prorated for the rest of this period. This also means agreeing to ${productName}'s own terms, since you haven't had ${productName} on this account before.</p>
    ${error ? `<div class="err">${error}</div>` : ''}
    <form method="POST" action="/billing/upgrade-to-bundle">
      <label class="terms-label">
        <input type="checkbox" name="agree_terms" required/>
        <span>I agree to ${productName}'s <a href="${termsUrl}" target="_blank" rel="noopener">Terms of Service</a> and <a href="${privacyUrl}" target="_blank" rel="noopener">Privacy Policy</a></span>
      </label>
      <div class="actions">
        <button class="primary" type="submit">Add ${productName}</button>
        <a class="ghost" href="/admin">Cancel</a>
      </div>
    </form>
  </div></body></html>`;
}

checkoutRouter.get('/upgrade-to-bundle', requireAuth, async (req, res) => {
  const products = missingProduct(req.account);
  if (!products && req.accountId && await liveSubscriptionCount(req.accountId) > 1) {
    return res.send(SWITCH_TO_BUNDLE_MESSAGE);
  }
  if (!products) {
    return res.status(400).send('Your account already has both products, or we could not tell which one you\'re adding. <a href="/admin">Back to dashboard</a>');
  }
  res.send(upgradeConfirmPage(products));
});

checkoutRouter.post('/upgrade-to-bundle', requireAuth, async (req, res) => {
  if (!req.accountId) {
    return res.redirect('/signin');
  }

  // Same server-side gate as every other real purchase path in this
  // app: the confirmation page's checkbox is required in the browser,
  // but this never trusts that alone, the same discipline as the
  // signup checkboxes above.
  const products = missingProduct(req.account);
  if (!products) {
    return res.status(400).send('Your account already has both products, or we could not tell which one you\'re adding. <a href="/admin">Back to dashboard</a>');
  }
  if (req.body.agree_terms !== 'on') {
    return res.send(upgradeConfirmPage(products, `Please agree to ${products === 'element_profile' ? 'Element Profile' : 'CARE 360'}'s Terms of Service and Privacy Policy to add it to your account.`));
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

    if (activeSubs && activeSubs.length > 1) {
      return res.send(SWITCH_TO_BUNDLE_MESSAGE);
    }

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
      const tier      = session.metadata && session.metadata.tier;

      if (accountId && tier) {
        // stripe_customer_id links the account to Stripe. Plan, product
        // flags and status are not written here: syncSubscription below
        // derives them from Stripe's real state, the same way every
        // other subscription event does.
        await supabase.from('accounts').update({
          stripe_customer_id: session.customer
        }).eq('id', accountId);

        if (session.subscription) {
          await syncSubscription(session.subscription, accountId);
        }
        console.log(`Account ${accountId} completed checkout at ${tier}`);
      }
    }

    if (event.type === 'customer.subscription.created' ||
        event.type === 'customer.subscription.updated' ||
        event.type === 'customer.subscription.deleted') {
      await syncSubscription(event.data.object.id);
    }

    if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
      const subId = invoiceSubscriptionId(event.data.object);
      if (subId) await syncSubscription(subId);
    }
  } catch (e) {
    // A non-2xx makes Stripe retry this event later. Safe, since every
    // handler above re-reads Stripe's current state rather than
    // applying the event's own snapshot.
    console.error('Webhook handling failed:', event.type, e.message);
    return res.status(500).send('Webhook handling failed');
  }

  res.json({ received: true });
});

// ── Subscription sync ────────────────────────────────────────
// Every subscription-related event funnels through here. Rather than
// trusting the event's own snapshot, it re-reads the subscription from
// Stripe, so the database always ends up matching Stripe's current
// state no matter which order events arrive in, or how many times one
// is retried. A late payment_failed after a successful retry, for
// example, re-reads "active" and changes nothing.

// Statuses under which a subscription still entitles its product(s).
// past_due keeps access during Stripe's retry window, so a customer
// can fix their card through Manage billing; unpaid, canceled and
// incomplete_expired do not.
const LIVE_STATUSES = ['active', 'trialing', 'past_due'];

// Newer Stripe API versions moved invoice.subscription under
// invoice.parent.subscription_details. Handles both shapes.
function invoiceSubscriptionId(inv) {
  if (typeof inv.subscription === 'string') return inv.subscription;
  if (inv.subscription && inv.subscription.id) return inv.subscription.id;
  const details = inv.parent && inv.parent.subscription_details;
  return details ? details.subscription : null;
}

async function syncSubscription(subscriptionId, accountIdHint) {
  const sub = await stripe.subscriptions.retrieve(subscriptionId);

  const { data: existing } = await supabase
    .from('account_subscriptions')
    .select('*')
    .eq('stripe_subscription_id', sub.id)
    .maybeSingle();

  let accountId = (existing && existing.account_id) ||
                  accountIdHint ||
                  (sub.metadata && sub.metadata.account_id) ||
                  null;

  if (!accountId && sub.customer) {
    const { data: acct } = await supabase
      .from('accounts')
      .select('id')
      .eq('stripe_customer_id', sub.customer)
      .maybeSingle();
    if (acct) accountId = acct.id;
  }

  if (!accountId) {
    // Nothing to attach it to yet. checkout.session.completed carries
    // the account id and calls this again, so nothing is lost.
    console.log(`Subscription ${sub.id}: no account found yet, skipping`);
    return;
  }

  // Products come from the current price. An unrecognized price (one
  // this environment has no env var for, e.g. an archived old price)
  // keeps whatever products the row already had.
  const priceId  = sub.items.data[0] && sub.items.data[0].price.id;
  const products = PRICE_TO_PRODUCTS[priceId] || (existing && existing.products);
  const tier     = PRICE_TO_TIER[priceId] || (existing && existing.tier) || null;

  if (!products) {
    console.error(`Subscription ${sub.id}: unrecognized price ${priceId} and no existing row, skipping`);
    return;
  }

  const { error } = await supabase
    .from('account_subscriptions')
    .upsert({
      account_id: accountId,
      stripe_subscription_id: sub.id,
      products,
      tier,
      status: sub.status,
      updated_at: new Date().toISOString()
    }, { onConflict: 'stripe_subscription_id' });
  if (error) throw error;

  await recomputeAccount(accountId);
  console.log(`Subscription ${sub.id} synced: ${products}, ${tier}, ${sub.status}`);
}

// Plans set by hand, never derived from subscriptions.
const MANUAL_PLANS = ['enterprise', 'community'];
const TIER_RANK    = { starter: 1, growth: 2 };

// Derives the account's per-product flags, plan and overall status from
// all of its subscriptions together, so one product ending or going
// past due never touches the other. Only accounts that have ever had a
// subscription reach here, so trial accounts are never affected.
async function recomputeAccount(accountId) {
  const { data: subs, error } = await supabase
    .from('account_subscriptions')
    .select('products, tier, status')
    .eq('account_id', accountId);
  if (error) throw error;

  const { data: current, error: acctErr } = await supabase
    .from('accounts')
    .select('plan, comp_care360, comp_element_profile')
    .eq('id', accountId)
    .single();
  if (acctErr) throw acctErr;

  const covers = (s, product) => s.products === product || s.products === 'bundle';
  const live   = subs.filter(s => LIVE_STATUSES.includes(s.status));

  // A product is on while a live subscription covers it, or while it's
  // comped (granted by hand in Supabase). Comps are the only thing that
  // keeps a product on without a subscription behind it.
  const has_care360         = live.some(s => covers(s, 'care360'))         || current.comp_care360;
  const has_element_profile = live.some(s => covers(s, 'element_profile')) || current.comp_element_profile;

  // plan is the highest tier among live subscriptions. With nothing
  // live it's left as it was (status carries canceled/unpaid, and trial
  // only ever means never paid). Manual plans are never relabeled.
  const updates = { has_care360, has_element_profile };
  const liveTiers = live.map(s => s.tier).filter(t => TIER_RANK[t]);
  if (liveTiers.length && !MANUAL_PLANS.includes(current.plan)) {
    updates.plan = liveTiers.reduce((a, b) => (TIER_RANK[b] > TIER_RANK[a] ? b : a));
  }

  // active if anything is fully paid up, past_due if the only live
  // subscriptions are past due. With nothing live left: unpaid if Stripe
  // gave up retrying a payment (paying it restores access), otherwise
  // canceled.
  let status = 'canceled';
  if (live.some(s => s.status === 'active' || s.status === 'trialing')) status = 'active';
  else if (live.length) status = 'past_due';
  else if (subs.some(s => s.status === 'unpaid')) status = 'unpaid';
  // A comped product is never canceled or unpaid, so an account with any
  // comp stays active. Per-product access is read from each product's
  // own flag and subscription rows, not from this account-level status.
  if (current.comp_care360 || current.comp_element_profile) status = 'active';
  updates.status = status;

  const { data: account } = await supabase
    .from('accounts')
    .update(updates)
    .eq('id', accountId)
    .select()
    .maybeSingle();

  // First time this account has Element Profile access: it needs the
  // organizations row it never had. Never removed when access ends, so
  // nothing is lost if they resubscribe.
  if (has_element_profile && account) {
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

module.exports = { checkoutRouter, webhookRouter };
