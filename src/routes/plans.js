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
          'Sized for organizations up to 750 employees',
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
        annual: 1990,
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
        annual: 3490,
        features: [
          'Everything in Starter',
          'Sized for organizations up to 750 employees',
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
        annual: 2480,
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
        annual: 5480,
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

// Element Profile and Bundle are now purchasable: their real,
// live-mode Stripe prices exist and Railway has all eight
// STRIPE_PRICE_ELEMENT_*/STRIPE_PRICE_BUNDLE_* variables set,
// confirmed directly against a freshly restarted production process.
const SHOW_ALL_PRODUCTS = true;

const ELEMENT_PROFILE_URL = process.env.ELEMENT_PROFILE_URL || 'https://element.ingoodcocollective.com';

// Short aliases, so /plans?product=element works as well as the full key.
const PRODUCT_ALIASES = { element: 'element_profile', care: 'care360' };

// Copy that differs by product tab. Element Profile and the Bundle have
// no free trial, so their tabs say so and point to Starter or a demo.
const PAGE_COPY = {
  care360: {
    backHref: '/admin',
    backText: 'Back to surveys',
    foot: 'Every plan includes unlimited raters and unlimited reports. No per-report charges.',
    note: ''
  },
  element_profile: {
    backHref: `${ELEMENT_PROFILE_URL}/admin`,
    backText: 'Back to your dashboard',
    foot: 'Every plan includes unlimited people and unlimited assessments. No per-assessment charges.',
    note: 'No free trial. Start on Starter or <a href="mailto:info@ingoodcocollective.com?subject=Element%20Profile%20demo">book a demo</a>.'
  },
  bundle: {
    backHref: '/admin',
    backText: 'Back to your account',
    foot: 'Every plan includes unlimited people, assessments, raters and reports. No per-report charges.',
    note: 'No free trial. Start on Starter or <a href="mailto:info@ingoodcocollective.com?subject=Bundle%20demo">book a demo</a>.'
  }
};

router.get('/', (req, res) => {
  const annual  = req.query.billing === 'annual';
  const asked   = PRODUCT_ALIASES[req.query.product] || req.query.product;
  const product = (SHOW_ALL_PRODUCTS && PRODUCTS[asked]) ? asked : 'care360';
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
  const copy = PAGE_COPY[product];
  const billingSuffix = annual ? '&billing=annual' : '';

  const productToggle = Object.keys(PRODUCTS).map(key => `
    <a class="product-opt ${key === product ? 'on' : ''}" href="/plans?product=${key}${billingSuffix}">${PRODUCTS[key].label}</a>
  `).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${p.label} plans | In Good Company</title>
<link rel="icon" type="image/svg+xml" href="/img/care-mark.svg"/>
<script>
// A hash never reaches the server, so #element, #bundle and #care360
// are honored here instead, and only when no ?product= was given.
(function(){
  var map = { '#element': 'element_profile', '#bundle': 'bundle', '#care360': 'care360' };
  var q = new URLSearchParams(location.search);
  var target = map[location.hash.toLowerCase()];
  if (target && !q.get('product') && target !== '${product}') {
    q.set('product', target);
    location.replace('/plans?' + q.toString());
  }
})();
</script>
<style>
@import url('https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;500;600&family=Noto+Sans:wght@400;500;600;700&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--ink:#30383B;--ink-deep:#20282B;--clay:#A9633D;--clay-dark:#925433;--ochre:#A87B2C;--ochre-light:#E3C785;--ochre-tint:#FBF5E6;--ochre-line:#EEDFB8;--sage:#7C8863;--sand:#D9CBB2;--cream:#F7F3EA;--wash:#FAF8F4;--warm:#EDE8DF;--grey:#637074;--line:rgba(48,56,59,0.09);--line-strong:rgba(48,56,59,0.18);--shadow:0 1px 2px rgba(48,56,59,0.04),0 2px 10px rgba(48,56,59,0.04);--shadow-lift:0 2px 4px rgba(48,56,59,0.05),0 18px 40px rgba(48,56,59,0.1);--ease:cubic-bezier(.2,.7,.2,1)}
@keyframes igc-rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
:focus-visible{outline:2px solid var(--clay);outline-offset:2px}
::selection{background:var(--ochre-light)}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
body{font-family:'Noto Sans',Arial,sans-serif;background:#ffffff;color:var(--ink);font-size:14px;line-height:1.6;-webkit-font-smoothing:antialiased}
a{text-decoration:none}

.top{background:rgba(255,255,255,0.78);-webkit-backdrop-filter:saturate(180%) blur(16px);backdrop-filter:saturate(180%) blur(16px);height:72px;display:flex;align-items:center;padding:0 40px;gap:24px;box-shadow:0 1px 0 var(--line);position:sticky;top:0;z-index:100}
.top-logo{display:flex;align-items:center}
.top-wordmark{height:19px;width:auto;display:block}
.top-spacer{flex:1}
.top-link{display:inline-flex;align-items:center;background:var(--ink);color:var(--cream);font-size:13px;font-weight:600;padding:10px 18px;border-radius:999px;text-transform:lowercase}
.top-link:hover{background:var(--ink-deep)}

.wrap{max-width:1140px;margin:0 auto;padding:64px 32px 96px}
.head{text-align:center;margin-bottom:34px;animation:igc-rise .55s var(--ease) both}
.h1{font-family:'EB Garamond',Georgia,serif;font-size:60px;font-weight:500;letter-spacing:-2.2px;font-feature-settings:"lnum" 1;line-height:1.08;margin-bottom:12px}
.lede{font-size:16px;color:var(--grey);line-height:1.7;max-width:580px;margin:0 auto}

.product-toggle{display:flex;justify-content:center;margin-bottom:18px}
.product-toggle-inner{display:inline-flex;background:var(--wash);border:1px solid var(--line);border-radius:999px;padding:4px}
.product-opt{text-transform:lowercase;padding:9px 22px;border-radius:999px;font-size:13px;font-weight:600;color:var(--grey);transition:color .15s,background .2s}
.product-opt:hover{color:var(--ink)}
.product-opt.on{background:var(--ink);color:var(--cream);box-shadow:0 2px 8px rgba(32,40,43,0.18)}

.toggle{display:flex;justify-content:center;margin-bottom:12px}
.toggle-inner{display:inline-flex;background:var(--wash);border:1px solid var(--line);border-radius:999px;padding:4px}
.toggle-opt{text-transform:lowercase;padding:9px 22px;border-radius:999px;font-size:13px;font-weight:600;color:var(--grey);transition:color .15s}
.toggle-opt:hover{color:var(--ink)}
.toggle-opt.on{background:#ffffff;color:var(--ink);box-shadow:0 1px 2px rgba(48,56,59,0.08),0 2px 8px rgba(48,56,59,0.06)}
.save{text-align:center;font-size:13px;color:var(--ochre);font-weight:600;margin-bottom:36px;min-height:18px}

.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-bottom:20px}
.grid-2{display:grid;grid-template-columns:repeat(2,1fr);gap:20px;max-width:760px;margin:0 auto}

.plan{background:#ffffff;border:1px solid var(--line);border-radius:24px;padding:34px 30px 30px;display:flex;flex-direction:column;position:relative;box-shadow:var(--shadow);transition:transform .3s var(--ease),box-shadow .3s var(--ease);animation:igc-rise .6s var(--ease) both}
.plan:hover{transform:translateY(-4px);box-shadow:var(--shadow-lift)}
.grid .plan:nth-child(2),.grid-2 .plan:nth-child(1){animation-delay:.06s}.grid .plan:nth-child(3),.grid-2 .plan:nth-child(2){animation-delay:.12s}
.plan-featured{border:1.5px solid var(--ink);box-shadow:0 2px 4px rgba(48,56,59,0.06),0 20px 44px rgba(48,56,59,0.1)}
.plan-soft{background:var(--wash)}
.plan-tag{position:absolute;top:-13px;left:50%;transform:translateX(-50%);background:var(--ochre-light);color:var(--ink);box-shadow:0 2px 8px rgba(168,123,44,0.25);font-size:12px;font-weight:600;padding:4px 14px;border-radius:999px;white-space:nowrap;text-transform:lowercase}
.plan-name{text-transform:lowercase;font-family:'EB Garamond',Georgia,serif;font-size:28px;font-weight:500;letter-spacing:-0.6px;margin-bottom:6px}
.plan-blurb{font-size:13px;color:var(--grey);line-height:1.6;margin-bottom:20px;min-height:42px}
.plan-price{font-family:'EB Garamond',Georgia,serif;font-size:54px;font-weight:500;letter-spacing:-1.6px;line-height:1;font-feature-settings:"lnum" 1}
.plan-sub{font-size:12px;color:var(--grey);margin-top:6px;margin-bottom:22px;min-height:17px}
.plan-features{list-style:none;margin:0 0 26px;flex:1;border-top:1px solid var(--line);padding-top:14px}
.plan-features li{font-size:13.5px;color:var(--ink);line-height:1.55;padding:6px 0 6px 20px;position:relative}
.plan-features li::before{content:'';position:absolute;left:0;top:13px;width:7px;height:7px;border-radius:50%;background:var(--clay)}
.plan-btn{text-transform:lowercase;display:block;text-align:center;padding:13px;border-radius:999px;font-size:14px;font-weight:600;background:#ffffff;color:var(--ink);border:1px solid var(--line-strong);transition:background .15s,color .15s,border-color .15s,transform .12s}
.plan-btn:active{transform:translateY(1px) scale(.99)}
.plan-btn:hover{border-color:var(--ink)}
.plan-btn-primary{background:var(--ink);color:var(--cream);border-color:var(--ink);box-shadow:0 1px 2px rgba(32,40,43,0.2),inset 0 1px 0 rgba(255,255,255,0.08)}
.plan-btn-primary:hover{background:var(--ink-deep);box-shadow:0 6px 16px rgba(32,40,43,0.18)}

.no-trial{text-align:center;font-size:14px;color:var(--ink);margin:-18px 0 32px}
.no-trial a{color:var(--ink);font-weight:600;text-decoration:underline;text-underline-offset:3px}

.foot{text-align:center;margin-top:48px;font-size:13px;color:var(--grey);line-height:1.8}
.foot a{color:var(--ink);text-decoration:underline;text-underline-offset:3px}

@media(max-width:900px){.grid,.grid-2{grid-template-columns:1fr !important;max-width:440px !important;margin:0 auto 20px !important}.top{padding:0 16px;height:64px}.wrap{padding:40px 16px 72px}.h1{font-size:40px}}
</style></head><body>

<div class="top">
  <a class="top-logo" href="https://www.ingoodcocollective.com/" aria-label="In Good Company Collective home">
    <img class="top-wordmark" src="/img/igc-wordmark.svg" alt="in good company."/>
  </a>
  <div class="top-spacer"></div>
  ${signedIn
    ? `<a href="${copy.backHref}" class="top-link">${copy.backText}</a>`
    : '<a href="/signin" class="top-link">Sign in</a>'}
</div>

<div class="wrap">
  <div class="head">
    <div class="h1">${p.label.toLowerCase()} plans.</div>
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
  ${copy.note ? `<div class="no-trial">${copy.note}</div>` : ''}

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
    ${copy.foot}<br/>
    Questions? <a href="mailto:info@ingoodcocollective.com">Get in touch</a>.
  </div>
</div>

</body></html>`;
}

module.exports = router;
module.exports.PRODUCTS = PRODUCTS;
module.exports.SPECIAL_PLANS = SPECIAL_PLANS;
