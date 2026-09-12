const express = require('express');
const router  = express.Router();

// Prices live here and nowhere else. Change them in one place.
// Annual is ten months for twelve, so two months free, matching the
// real Stripe prices exactly (see PRICE_MAP in routes/billing.js).
const PRODUCTS = {
  care360: {
    label: 'CARE 360',
    tagline: 'Unlimited 360 surveys for your organization, with the full AI report, automatic reminders and the action plan template on every plan.',
    tiers: {
      starter: {
        name: 'Starter',
        blurb: 'For organizations up to 250 employees.',
        monthly: 149,
        annual: 1490,
        features: [
          'Unlimited leaders and surveys',
          'Unlimited raters',
          'The full AI report and PDF',
          'Automatic reminders and deadlines',
          'Leadership Action Plan template',
          'Email support'
        ],
        style: 'featured'
      },
      growth: {
        name: 'Growth',
        blurb: 'For organizations up to 750 employees.',
        monthly: 299,
        annual: 2990,
        features: [
          'Everything in Starter',
          'Higher usage for larger teams',
          'Priority support',
          'Onboarding walkthrough'
        ],
        style: 'plain'
      }
    }
  },
  element_profile: {
    label: 'Element Profile',
    tagline: 'The full behavioral talent assessment suite: the six Elements, archetype reports, and role and team comparisons.',
    tiers: {
      starter: {
        name: 'Starter',
        blurb: 'For organizations up to 250 employees.',
        monthly: 199,
        annual: 2030,
        features: [
          'Unlimited people assessed',
          'Full archetype report for every person',
          'Role and target-profile comparison reports',
          'Team creation and management',
          'Email support'
        ],
        style: 'featured'
      },
      growth: {
        name: 'Growth',
        blurb: 'For organizations up to 750 employees.',
        monthly: 349,
        annual: 3560,
        features: [
          'Everything in Starter',
          'Higher usage for larger teams',
          'Priority support',
          'Onboarding walkthrough'
        ],
        style: 'plain'
      }
    }
  },
  bundle: {
    label: 'Bundle',
    tagline: 'CARE 360 and Element Profile together, on one subscription.',
    tiers: {
      starter: {
        name: 'Starter Bundle',
        blurb: 'CARE 360 Starter and Element Profile Starter, together.',
        monthly: 248,
        annual: 2320,
        features: [
          'Everything in CARE 360 Starter',
          'Everything in Element Profile Starter',
          'One login, one subscription',
          'Save $100 a month versus buying separately',
          'Email support'
        ],
        style: 'featured'
      },
      growth: {
        name: 'Growth Bundle',
        blurb: 'CARE 360 Growth and Element Profile Growth, together.',
        monthly: 548,
        annual: 5350,
        features: [
          'Everything in CARE 360 Growth',
          'Everything in Element Profile Growth',
          'One login, one subscription',
          'Save $100 a month versus buying separately',
          'Priority support'
        ],
        style: 'plain'
      }
    }
  }
};

// The trial, Community and Enterprise cards only ever meant CARE 360:
// there is no Element Profile or Bundle equivalent defined anywhere
// yet, so they only render on the CARE 360 tab, same as they always
// have. Extending them to the other two products is a real content
// decision for later, not assumed here.
const SPECIAL_PLANS = {
  trial: {
    key: 'trial',
    name: 'Free trial',
    blurb: 'Run one complete 360, start to finish.',
    monthly: 0,
    annual: 0,
    priceNote: 'No card required',
    features: [
      'One leader',
      'Unlimited raters on that leader',
      'The full AI report and PDF',
      'Automatic reminders and deadlines',
      'Leadership Action Plan template'
    ],
    cta: 'Start free trial',
    href: '/signup?tier=trial',
    style: 'plain'
  },
  community: {
    key: 'community',
    name: 'Community',
    blurb: 'For nonprofits, schools and government.',
    monthly: null,
    annual: null,
    priceNote: 'Special pricing',
    features: [
      'Everything in Starter',
      'Reduced rate for mission-driven organizations',
      'Requires a short application'
    ],
    cta: 'Apply for Community',
    href: 'mailto:abbie@ingoodcocollective.com?subject=CARE%20360%20Community%20pricing',
    style: 'soft'
  },
  enterprise: {
    key: 'enterprise',
    name: 'Enterprise',
    blurb: 'For organizations over 750 employees.',
    monthly: null,
    annual: null,
    priceNote: 'Custom pricing',
    features: [
      'Everything in Growth',
      'Tailored to your structure and volume',
      'Dedicated onboarding and support'
    ],
    cta: 'Talk to us',
    href: 'mailto:abbie@ingoodcocollective.com?subject=CARE%20360%20Enterprise',
    style: 'soft'
  }
};

// TEMPORARY: Element Profile and Bundle aren't purchasable yet, their
// real Stripe prices don't exist in production (Railway has none of
// the STRIPE_PRICE_ELEMENT_*/STRIPE_PRICE_BUNDLE_* variables set).
// This hides those two tabs from the live page without touching any
// of the underlying checkout/webhook code, which stays fully built
// and tested. Flip back to true the moment real pricing exists and
// those variables are set.
const SHOW_ALL_PRODUCTS = false;

router.get('/', (req, res) => {
  const annual  = req.query.billing === 'annual';
  const product = (SHOW_ALL_PRODUCTS && PRODUCTS[req.query.product]) ? req.query.product : 'care360';
  res.send(plansPage(annual, product, req));
});

function money(n) {
  return '$' + n.toLocaleString('en-US');
}

function specialCard(p, annual, loggedIn) {
  let price, sub;

  if (p.monthly === 0) {
    price = 'Free';
    sub   = p.priceNote || '';
  } else {
    price = p.priceNote || 'Custom';
    sub   = '';
  }

  return `
  <div class="plan plan-${p.style}">
    <div class="plan-name">${p.name}</div>
    <div class="plan-blurb">${p.blurb}</div>
    <div class="plan-price">${price}</div>
    <div class="plan-sub">${sub}</div>
    <ul class="plan-features">
      ${p.features.map(f => `<li>${f}</li>`).join('')}
    </ul>
    <a class="plan-btn" href="${p.href}">${p.cta}</a>
  </div>`;
}

// A brand new visitor needs an account before Stripe has anywhere to
// attach a subscription, so a purchase routes through signup first,
// which then carries them straight into checkout right after. An
// already logged-in visitor (buying a second product, or a higher
// tier) skips straight to checkout, since creating a second account
// for them would be wrong.
function productTierCard(productKey, tierKey, tier, annual, loggedIn) {
  const price = annual ? money(tier.annual) : money(tier.monthly);
  const sub   = annual ? 'per year, two months free' : 'per month';

  const billingParam = annual ? '&billing=annual' : '';
  const href = loggedIn
    ? `/billing/checkout?products=${productKey}&tier=${tierKey}${billingParam}`
    : `/signup?products=${productKey}&tier=${tierKey}${billingParam}`;

  return `
  <div class="plan plan-${tier.style}">
    ${tier.style === 'featured' ? '<div class="plan-tag">Most popular</div>' : ''}
    <div class="plan-name">${tier.name}</div>
    <div class="plan-blurb">${tier.blurb}</div>
    <div class="plan-price">${price}</div>
    <div class="plan-sub">${sub}</div>
    <ul class="plan-features">
      ${tier.features.map(f => `<li>${f}</li>`).join('')}
    </ul>
    <a class="plan-btn ${tier.style === 'featured' ? 'plan-btn-primary' : ''}" href="${href}">Choose ${tier.name}</a>
  </div>`;
}

function plansPage(annual, product, req) {
  const signedIn = !!req.isAdmin;
  const loggedIn = signedIn;
  const p = PRODUCTS[product];
  const billingSuffix = annual ? '&billing=annual' : '';

  const productToggle = Object.keys(PRODUCTS).map(key => `
    <a class="product-opt ${key === product ? 'on' : ''}" href="/plans?product=${key}${billingSuffix}">${PRODUCTS[key].label}</a>
  `).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${p.label} plans — CARE 360</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--ink:#30383B;--clay:#A9633D;--sage:#7C8863;--sand:#D9CBB2;--cream:#F7F4EF;--warm:#EDE8DF;--grey:#595959}
body{font-family:'Inter',Arial,sans-serif;background:var(--cream);color:var(--ink);font-size:14px}
a{text-decoration:none}

.top{background:var(--ink);height:56px;display:flex;align-items:center;padding:0 32px;gap:24px}
.top-logo{display:flex;align-items:center;gap:10px}
.top-mark{width:32px;height:32px;background:var(--clay);border-radius:6px;display:flex;align-items:center;justify-content:center;font-weight:700;color:white;font-size:11px;font-family:'EB Garamond',serif}
.top-brand{color:white;font-weight:600;font-size:15px;font-family:'EB Garamond',serif}
.top-spacer{flex:1}
.top-link{color:rgba(255,255,255,0.65);font-size:13px;font-weight:500}
.top-link:hover{color:white}

.wrap{max-width:1140px;margin:0 auto;padding:48px 24px 80px}
.head{text-align:center;margin-bottom:30px}
.h1{font-family:'EB Garamond',serif;font-size:36px;font-weight:600;margin-bottom:10px}
.lede{font-size:15px;color:var(--grey);line-height:1.7;max-width:560px;margin:0 auto}

.product-toggle{display:flex;justify-content:center;margin-bottom:18px}
.product-toggle-inner{display:inline-flex;background:white;border:1.5px solid var(--sand);border-radius:999px;padding:4px}
.product-opt{padding:8px 22px;border-radius:999px;font-size:13px;font-weight:600;color:var(--grey)}
.product-opt.on{background:var(--clay);color:white}

.toggle{display:flex;justify-content:center;margin-bottom:12px}
.toggle-inner{display:inline-flex;background:white;border:1.5px solid var(--sand);border-radius:999px;padding:4px}
.toggle-opt{padding:8px 20px;border-radius:999px;font-size:13px;font-weight:600;color:var(--grey)}
.toggle-opt.on{background:var(--ink);color:white}
.save{text-align:center;font-size:12px;color:var(--sage);font-weight:600;margin-bottom:34px;min-height:18px}

.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-bottom:18px}
.grid-2{display:grid;grid-template-columns:repeat(2,1fr);gap:18px;max-width:760px;margin:0 auto}

.plan{background:white;border:1px solid var(--warm);border-radius:12px;padding:28px 26px;display:flex;flex-direction:column;position:relative}
.plan-featured{border:2px solid var(--clay);box-shadow:0 6px 24px rgba(169,99,61,0.14)}
.plan-soft{background:#FCFAF7}
.plan-tag{position:absolute;top:-11px;left:50%;transform:translateX(-50%);background:var(--clay);color:white;font-size:10px;font-weight:700;letter-spacing:0.9px;text-transform:uppercase;padding:4px 12px;border-radius:999px;white-space:nowrap}
.plan-name{font-family:'EB Garamond',serif;font-size:22px;font-weight:600;margin-bottom:5px}
.plan-blurb{font-size:12.5px;color:var(--grey);line-height:1.6;margin-bottom:18px;min-height:38px}
.plan-price{font-family:'EB Garamond',serif;font-size:38px;font-weight:600;line-height:1}
.plan-sub{font-size:12px;color:var(--grey);margin-top:5px;margin-bottom:20px;min-height:17px}
.plan-features{list-style:none;margin:0 0 24px;flex:1}
.plan-features li{font-size:13px;color:#454B4E;line-height:1.55;padding:6px 0 6px 20px;position:relative}
.plan-features li::before{content:'';position:absolute;left:0;top:12px;width:7px;height:7px;border-radius:50%;background:var(--sage)}
.plan-btn{display:block;text-align:center;padding:12px;border-radius:8px;font-size:14px;font-weight:600;background:var(--warm);color:var(--ink);border:1.5px solid var(--sand)}
.plan-btn:hover{background:var(--sand)}
.plan-btn-primary{background:var(--clay);color:white;border-color:var(--clay)}
.plan-btn-primary:hover{background:#96562F}

.foot{text-align:center;margin-top:44px;font-size:12.5px;color:var(--grey);line-height:1.8}
.foot a{color:var(--clay)}

@media(max-width:900px){.grid,.grid-2{grid-template-columns:1fr;max-width:420px;margin:0 auto 18px}.top{padding:0 16px}}
</style></head><body>

<div class="top">
  <div class="top-logo">
    <div class="top-mark">C</div>
    <span class="top-brand">in good company.</span>
  </div>
  <div class="top-spacer"></div>
  ${signedIn
    ? '<a href="/admin" class="top-link">Back to surveys</a>'
    : '<a href="/signin" class="top-link">Sign in</a>'}
</div>

<div class="wrap">
  <div class="head">
    <div class="h1">${p.label} plans</div>
    <p class="lede">${p.tagline}</p>
  </div>

  ${SHOW_ALL_PRODUCTS ? `
  <div class="product-toggle">
    <div class="product-toggle-inner">${productToggle}</div>
  </div>` : ''}

  <div class="toggle">
    <div class="toggle-inner">
      <a class="toggle-opt ${annual ? '' : 'on'}" href="/plans?product=${product}">Monthly</a>
      <a class="toggle-opt ${annual ? 'on' : ''}" href="/plans?product=${product}&billing=annual">Annual</a>
    </div>
  </div>
  <div class="save">${annual ? 'Two months free on annual billing' : ''}</div>

  <div class="grid" style="${product === 'care360' ? '' : 'grid-template-columns:repeat(2,1fr);max-width:760px;margin-left:auto;margin-right:auto'}">
    ${product === 'care360' ? specialCard(SPECIAL_PLANS.trial, annual, loggedIn) : ''}
    ${productTierCard(product, 'starter', p.tiers.starter, annual, loggedIn)}
    ${productTierCard(product, 'growth', p.tiers.growth, annual, loggedIn)}
  </div>
  ${product === 'care360' ? `
  <div class="grid-2">
    ${specialCard(SPECIAL_PLANS.community, annual, loggedIn)}
    ${specialCard(SPECIAL_PLANS.enterprise, annual, loggedIn)}
  </div>` : ''}

  <div class="foot">
    Every plan includes unlimited raters and unlimited reports. No per-report charges.<br/>
    Questions? <a href="mailto:abbie@ingoodcocollective.com">Get in touch</a>.
  </div>
</div>

</body></html>`;
}

module.exports = router;
module.exports.PRODUCTS = PRODUCTS;
module.exports.SPECIAL_PLANS = SPECIAL_PLANS;
