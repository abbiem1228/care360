const express = require('express');
const router  = express.Router();

// Prices live here and nowhere else. Change them in one place.
// Annual is ten months for twelve, so two months free.
const PLANS = {
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
    href: '/signup?plan=trial',
    style: 'plain'
  },
  starter: {
    key: 'starter',
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
    cta: 'Choose Starter',
    href: '/signup?plan=starter',
    style: 'featured'
  },
  growth: {
    key: 'growth',
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
    cta: 'Choose Growth',
    href: '/signup?plan=growth',
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

router.get('/', (req, res) => {
  const annual = req.query.billing === 'annual';
  res.send(plansPage(annual, req));
});

function money(n) {
  return '$' + n.toLocaleString('en-US');
}

function planCard(p, annual, loggedIn) {
  let price, sub;

  if (p.monthly === 0) {
    price = 'Free';
    sub   = p.priceNote || '';
  } else if (p.monthly === null) {
    price = p.priceNote || 'Custom';
    sub   = '';
  } else if (annual) {
    price = money(p.annual);
    sub   = 'per year, two months free';
  } else {
    price = money(p.monthly);
    sub   = 'per month';
  }

  // A brand new visitor needs an account before Stripe has anywhere to
  // attach a subscription, so paid plans route through signup first,
  // which then carries them straight into checkout right after. An
  // already logged-in visitor (upgrading from trial) skips straight
  // to checkout, since creating a second account for them would be wrong.
  const isPaid = p.key === 'starter' || p.key === 'growth';
  let href;
  if (isPaid) {
    const billingParam = annual ? '&billing=annual' : '';
    href = loggedIn
      ? `/billing/checkout?plan=${p.key}${billingParam}`
      : `/signup?plan=${p.key}${billingParam}`;
  } else {
    href = p.href;
  }

  return `
  <div class="plan plan-${p.style}">
    ${p.style === 'featured' ? '<div class="plan-tag">Most popular</div>' : ''}
    <div class="plan-name">${p.name}</div>
    <div class="plan-blurb">${p.blurb}</div>
    <div class="plan-price">${price}</div>
    <div class="plan-sub">${sub}</div>
    <ul class="plan-features">
      ${p.features.map(f => `<li>${f}</li>`).join('')}
    </ul>
    <a class="plan-btn ${p.style === 'featured' ? 'plan-btn-primary' : ''}" href="${href}">${p.cta}</a>
  </div>`;
}

function plansPage(annual, req) {
  const signedIn = !!req.isAdmin;
  const loggedIn = signedIn;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Plans — CARE 360</title>
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
    <div class="h1">CARE 360 plans</div>
    <p class="lede">Unlimited 360 surveys for your organization, with the full AI report, automatic reminders and the action plan template on every plan.</p>
  </div>

  <div class="toggle">
    <div class="toggle-inner">
      <a class="toggle-opt ${annual ? '' : 'on'}" href="/plans">Monthly</a>
      <a class="toggle-opt ${annual ? 'on' : ''}" href="/plans?billing=annual">Annual</a>
    </div>
  </div>
  <div class="save">${annual ? 'Two months free on annual billing' : ''}</div>

  <div class="grid">
    ${planCard(PLANS.trial, annual, loggedIn)}
    ${planCard(PLANS.starter, annual, loggedIn)}
    ${planCard(PLANS.growth, annual, loggedIn)}
  </div>
  <div class="grid-2">
    ${planCard(PLANS.community, annual, loggedIn)}
    ${planCard(PLANS.enterprise, annual, loggedIn)}
  </div>

  <div class="foot">
    Every plan includes unlimited raters and unlimited reports. No per-report charges.<br/>
    Questions? <a href="mailto:abbie@ingoodcocollective.com">Get in touch</a>.
  </div>
</div>

</body></html>`;
}

module.exports = router;
module.exports.PLANS = PLANS;
