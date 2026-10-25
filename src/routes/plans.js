const express = require('express');
const router  = express.Router();
const { icon } = require('../icons');

// Prices live here and nowhere else. Change them in one place.
// Organizations buy annual plans only. The monthly Starter prices are
// kept for coach accounts (see the /coach page below) and for existing
// monthly customers, who keep their plans. Both must match the real
// Stripe prices exactly (see PRICE_MAP in routes/billing.js).
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
    label: 'The Element Profile',
    tab: 'the element profile',
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
          'Save $1,000 a year versus buying separately',
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
          'Save $1,000 a year versus buying separately',
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

// ?billing= is ignored: organizations only ever see annual prices now,
// and old ?billing=monthly links land on the same annual page.
router.get('/', (req, res) => {
  const asked   = PRODUCT_ALIASES[req.query.product] || req.query.product;
  const product = (SHOW_ALL_PRODUCTS && PRODUCTS[asked]) ? asked : 'care360';
  res.send(plansPage(product, req));
});

function money(n) {
  return '$' + n.toLocaleString('en-US');
}

// Per-product hero: the product's own wordmark from the website, plus
// a one-line promise. The longer tagline in PRODUCTS sits under it.
const HERO = {
  care360:         { marks: [['care360-wordmark.svg', 'care 360.']], title: 'unlimited 360s, one simple price.' },
  element_profile: { marks: [['element-wordmark.svg', 'element.']], title: 'profiles for your whole team, one simple price.' },
  bundle:          { marks: [['care360-wordmark.svg', 'care 360.'], ['element-wordmark.svg', 'element.']], title: 'both products, one subscription.' }
};

const TAB_MARK = { care360: 'care-mark.svg', element_profile: 'element-mark.svg', bundle: null };

// Questions and answers taken word for word from the product pages on
// ingoodcocollective.com, so the pricing page and the site agree.
const SITE_FAQ = {
  careWhat:    ['What is care 360?', 'A 360-degree leadership feedback tool. A leader completes a self-assessment, and their supervisor, peers, direct reports and skip-level colleagues answer the same questions. The report shows averages by rater group, comments with names removed, and development themes.'],
  careCost:    ['How much does care 360 cost?', 'Plans are priced by company size and billed annually. Starter is $1,490 a year and Growth is $2,990 a year. Every paid plan includes unlimited surveys and reports, with no per-report fees. A free trial is available.'],
  careAnon:    ['Is the feedback anonymous?', 'Individual answers are never shown to the leader or the administrator. If only one person in a rater group responds, such as a single supervisor, the group average reflects that person\'s ratings. Self-assessments aren\'t anonymous.'],
  careHiring:  ['Can care 360 be used for hiring or pay decisions?', 'No. It\'s a development tool. Results shouldn\'t be the only basis for decisions about employment or pay, and it isn\'t offered for hiring.'],
  elWhat:      ['What does The Element Profile measure?', 'How a person naturally works across six dimensions: drive, pace, people orientation, structure, composure, and ambiguity tolerance.'],
  elProfiles:  ['What are the Element profiles?', 'Each person\'s two strongest dimensions form one of 15 profiles, such as The Steady Hand or The Trailblazer. Evenly balanced results are The Wild Card.'],
  elCost:      ['How much does it cost?', 'Plans are billed annually. Starter is $1,990 a year and Growth is $3,490 a year. There\'s no free trial; you can book a demo.'],
  elHiring:    ['Can it be used for hiring?', 'No. It\'s built for development, coaching and team conversations, not for screening or selecting candidates.'],
  elWithCare:  ['Does it work with care 360?', 'Yes. Both share one account, can be bought together as a bundle, and connect a person\'s results so administrators can see them side by side.']
};
const FAQ = {
  care360:         ['careWhat', 'careCost', 'careAnon', 'careHiring'],
  element_profile: ['elWhat', 'elProfiles', 'elCost', 'elHiring', 'elWithCare'],
  bundle:          ['elWithCare', 'careWhat', 'elWhat', 'careHiring']
};

const CONTACT_URL = 'https://www.ingoodcocollective.com/contact/';
// The public coach page on the website, which explains coach pricing and
// links to this app's unlisted /coach page.
const COACH_PAGE_URL = 'https://ingoodcocollective.com/coaches/';

function featureList(features) {
  return `<ul class="plan-features">${features.map(f => `<li>${icon('check')}<span>${f}</span></li>`).join('')}</ul>`;
}

function specialCard(p) {
  let price, sub;

  if (p.monthly === 0) {
    price = 'Free';
    sub   = p.priceNote || '';
  } else {
    price = p.priceNote || 'Custom';
    sub   = '';
  }

  const wide = p.style === 'soft';
  return `
  <div class="plan plan-${p.style}${wide ? ' plan-wide' : ''}">
    <div class="plan-head">
      <div class="plan-name">${p.name}</div>
      <div class="plan-blurb">${p.blurb}</div>
    </div>
    <div class="plan-price-row"><span class="plan-price${p.monthly === 0 ? '' : ' plan-price-text'}">${price}</span></div>
    <div class="plan-sub">${sub}</div>
    ${featureList(p.features)}
    <a class="plan-btn" href="${p.href}">${p.cta}${icon('arrow-right')}</a>
  </div>`;
}

// A brand new visitor needs an account before Stripe has anywhere to
// attach a subscription, so a purchase routes through signup first,
// which then carries them straight into checkout right after. An
// already logged-in visitor (buying a second product, or a higher
// tier) skips straight to checkout, since creating a second account
// for them would be wrong.
function productTierCard(productKey, tierKey, tier, loggedIn) {
  const price = money(tier.annual);
  const per   = '/year';
  const sub   = 'billed annually';

  const href = loggedIn
    ? `/billing/checkout?products=${productKey}&tier=${tierKey}&billing=annual`
    : `/signup?products=${productKey}&tier=${tierKey}&billing=annual`;

  const featured = tier.style === 'featured';
  return `
  <div class="plan plan-${tier.style}">
    ${featured ? '<div class="plan-tag">Most popular</div>' : ''}
    <div class="plan-head">
      <div class="plan-name">${tier.name}</div>
      <div class="plan-blurb">${tier.blurb}</div>
    </div>
    <div class="plan-price-row"><span class="plan-price">${price}</span><span class="plan-per">${per}</span></div>
    <div class="plan-sub">${sub}</div>
    ${featureList(tier.features)}
    <a class="plan-btn ${featured ? 'plan-btn-primary' : ''}" href="${href}">Choose ${tier.name}${icon('arrow-right')}</a>
  </div>`;
}

// Shared by /plans and /coach.
const PLANS_CSS = `@import url('https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;500;600&family=Noto+Sans:wght@400;500;600;700&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--ink:#30383B;--ink-deep:#20282B;--clay:#A9633D;--clay-dark:#925433;--clay-tint:#F7ECE5;--ochre:#A87B2C;--ochre-light:#E3C785;--ochre-tint:#FBF5E6;--ochre-line:#EEDFB8;--sage:#7C8863;--cream:#F7F3EA;--wash:#FAF8F4;--grey:#637074;--line:rgba(48,56,59,0.09);--line-strong:rgba(48,56,59,0.18);--shadow:0 1px 2px rgba(48,56,59,0.04),0 2px 10px rgba(48,56,59,0.04);--shadow-lift:0 2px 4px rgba(48,56,59,0.05),0 18px 40px rgba(48,56,59,0.1);--ease:cubic-bezier(.2,.7,.2,1)}
@keyframes igc-rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
:focus-visible{outline:2px solid var(--clay);outline-offset:2px}
::selection{background:var(--ochre-light)}
body{font-family:'Noto Sans',Arial,sans-serif;background:#ffffff;color:var(--ink);font-size:14px;line-height:1.6;-webkit-font-smoothing:antialiased}
a{text-decoration:none;color:inherit}
.i{width:1.1em;height:1.1em;flex-shrink:0;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}

.top{background:rgba(255,255,255,0.78);-webkit-backdrop-filter:saturate(180%) blur(16px);backdrop-filter:saturate(180%) blur(16px);height:72px;display:flex;align-items:center;padding:0 40px;gap:24px;box-shadow:0 1px 0 var(--line);position:sticky;top:0;z-index:100}
.top-logo{display:flex;align-items:center}
.top-wordmark{height:19px;width:auto;display:block}
.top-spacer{flex:1}
.top-link{display:inline-flex;align-items:center;background:var(--ink);color:var(--cream);font-size:13px;font-weight:600;padding:10px 18px;border-radius:999px;text-transform:lowercase;transition:background .15s}
.top-link:hover{background:var(--ink-deep)}

.hero{position:relative;text-align:center;padding:72px 24px 36px;overflow:hidden}
.hero::before{content:'';position:absolute;inset:-40% -10% auto;height:520px;background:radial-gradient(closest-side,rgba(227,199,133,0.22),transparent 70%),radial-gradient(closest-side at 70% 40%,rgba(169,99,61,0.10),transparent 70%);pointer-events:none;z-index:-1}
.hero>*{animation:igc-rise .6s var(--ease) both}
.hero-marks{display:flex;justify-content:center;align-items:center;gap:18px;margin-bottom:22px}
.hero-marks img{height:30px;width:auto}
.hero-marks .plus{color:var(--grey);font-size:18px}
.h1{font-family:'EB Garamond',Georgia,serif;font-size:64px;font-weight:500;letter-spacing:-2.4px;line-height:1.02;margin:0 auto 16px;max-width:760px;text-wrap:balance;animation-delay:.05s}
.lede{font-size:16.5px;color:var(--grey);line-height:1.7;max-width:600px;margin:0 auto;animation-delay:.1s}

.controls{display:flex;flex-direction:column;align-items:center;gap:12px;margin:34px 0 10px;animation-delay:.15s}
.product-toggle-inner{display:inline-flex;flex-wrap:wrap;justify-content:center;background:var(--wash);border:1px solid var(--line);border-radius:999px;padding:4px;gap:2px}
.product-opt{display:inline-flex;align-items:center;gap:8px;padding:8px 18px 8px 10px;border-radius:999px;font-size:13.5px;font-weight:600;color:var(--grey);transition:color .15s,background .2s,box-shadow .2s}
.product-opt img{width:20px;height:20px}
.product-opt .duo{display:inline-flex}
.product-opt .duo img+img{margin-left:-6px}
.product-opt:hover{color:var(--ink)}
.product-opt.on{background:#ffffff;color:var(--ink);box-shadow:0 1px 2px rgba(48,56,59,0.08),0 4px 12px rgba(48,56,59,0.08)}
.no-trial{text-align:center;font-size:13.5px;color:var(--grey)}
.no-trial a{color:var(--ink);font-weight:600;text-decoration:underline;text-underline-offset:3px}

.wrap{max-width:1140px;margin:0 auto;padding:24px 32px 96px}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;align-items:stretch}
.grid-2{grid-template-columns:repeat(2,minmax(0,1fr));max-width:780px;margin:0 auto}
.grid-wide{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin-top:20px}

.plan{background:#ffffff;border:1px solid var(--line);border-radius:24px;padding:32px 30px 28px;display:flex;flex-direction:column;position:relative;box-shadow:var(--shadow);transition:transform .3s var(--ease),box-shadow .3s var(--ease);animation:igc-rise .6s var(--ease) both}
.plan:hover{transform:translateY(-4px);box-shadow:var(--shadow-lift)}
.grid .plan:nth-child(2){animation-delay:.06s}.grid .plan:nth-child(3){animation-delay:.12s}
.plan-tag{position:absolute;top:-13px;left:30px;background:var(--ochre-light);color:var(--ink);font-size:12px;font-weight:600;padding:4px 12px;border-radius:999px;white-space:nowrap;text-transform:lowercase;box-shadow:0 4px 12px rgba(168,123,44,0.25)}
.plan-name{font-family:'EB Garamond',Georgia,serif;font-size:30px;font-weight:500;letter-spacing:-0.8px;line-height:1.1;text-transform:lowercase}
.plan-blurb{font-size:13.5px;color:var(--grey);line-height:1.55;margin-top:6px;min-height:42px}
.plan-price-row{display:flex;align-items:baseline;gap:6px;margin-top:22px}
.plan-price{font-family:'EB Garamond',Georgia,serif;font-size:60px;font-weight:500;letter-spacing:-2px;line-height:1;font-feature-settings:"lnum" 1}
.plan-price-text{font-size:40px;letter-spacing:-1.2px}
.plan-per{font-size:14px;color:var(--grey)}
.plan-sub{font-size:12.5px;color:var(--grey);margin-top:8px;min-height:19px}
.plan-features{list-style:none;margin:22px 0 26px;padding-top:20px;border-top:1px solid var(--line);flex:1;display:flex;flex-direction:column;gap:10px}
.plan-features li{display:flex;gap:10px;font-size:14px;line-height:1.45}
.plan-features .i{width:16px;height:16px;color:var(--clay);margin-top:2px}
.plan-btn{display:flex;align-items:center;justify-content:center;gap:8px;text-align:center;padding:14px;border-radius:999px;font-size:14px;font-weight:600;text-transform:lowercase;background:#ffffff;color:var(--ink);border:1px solid var(--line-strong);transition:background .15s,color .15s,border-color .15s,transform .12s}
.plan-btn .i{width:15px;height:15px;transition:transform .2s var(--ease)}
.plan-btn:hover{border-color:var(--ink)}
.plan-btn:hover .i{transform:translateX(3px)}
.plan-btn:active{transform:translateY(1px) scale(.99)}

/* Featured plan: the one dark card on the page */
.plan-featured{background:var(--ink);border-color:var(--ink);color:var(--cream);box-shadow:0 2px 6px rgba(32,40,43,0.15),0 24px 50px rgba(32,40,43,0.22)}
.plan-featured .plan-blurb,.plan-featured .plan-per,.plan-featured .plan-sub{color:rgba(247,243,234,0.7)}
.plan-featured .plan-features{border-top-color:rgba(247,243,234,0.14)}
.plan-featured .plan-features .i{color:var(--ochre-light)}
.plan-btn-primary{background:var(--cream);color:var(--ink);border-color:var(--cream)}
.plan-btn-primary:hover{background:#ffffff;border-color:#ffffff}

/* Community and Enterprise: compact, side by side */
.plan-wide{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);grid-template-areas:"head price" "feat feat" "btn btn";column-gap:24px;background:var(--wash);box-shadow:none;padding:26px 28px}
.plan-wide .plan-head{grid-area:head}
.plan-wide .plan-price-row{grid-area:price;margin-top:0;justify-content:flex-end;align-self:start}
.plan-wide .plan-sub{display:none}
.plan-wide .plan-features{grid-area:feat;margin:18px 0 20px;padding-top:16px}
.plan-wide .plan-btn{grid-area:btn}
.plan-wide .plan-name{font-size:26px}
.plan-wide .plan-blurb{min-height:0}
.plan-wide .plan-price-text{font-size:22px;letter-spacing:-0.4px;color:var(--grey)}

.includes{display:flex;align-items:center;justify-content:center;gap:12px;margin:40px auto 0;max-width:760px;padding:16px 22px;border-radius:999px;background:var(--ochre-tint);border:1px solid var(--ochre-line);font-size:14px;text-align:center}
.includes .i{width:18px;height:18px;color:var(--ochre)}

.faq{max-width:780px;margin:88px auto 0}
.section-title{font-family:'EB Garamond',Georgia,serif;font-size:44px;font-weight:500;letter-spacing:-1.4px;text-align:center;margin-bottom:26px}
.faq-item{border-bottom:1px solid var(--line)}
.faq-item summary{list-style:none;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px 4px;cursor:pointer;font-family:'EB Garamond',Georgia,serif;font-size:22px;font-weight:500;letter-spacing:-0.3px}
.faq-item summary::-webkit-details-marker{display:none}
.faq-toggle{width:32px;height:32px;border-radius:50%;border:1px solid var(--line-strong);display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:transform .25s var(--ease),background .15s}
.faq-toggle .i{width:15px;height:15px}
.faq-item[open] .faq-toggle{transform:rotate(45deg);background:var(--ink);color:var(--cream);border-color:var(--ink)}
.faq-item p{padding:0 52px 22px 4px;font-size:15px;line-height:1.75;color:var(--grey);animation:igc-rise .3s var(--ease) both}

.cta{max-width:1076px;margin:88px auto 0;border-radius:28px;background:var(--ink);color:var(--cream);padding:48px 52px;display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap;position:relative;overflow:hidden}
.cta::after{content:'';position:absolute;right:-60px;top:-60px;width:240px;height:240px;border-radius:50%;border:28px solid rgba(169,99,61,0.35)}
.cta h2{font-family:'EB Garamond',Georgia,serif;font-size:40px;font-weight:500;letter-spacing:-1.2px;line-height:1.05}
.cta p{color:rgba(247,243,234,0.72);margin-top:8px;font-size:15px}
.cta-btn{position:relative;z-index:1;display:inline-flex;align-items:center;gap:8px;background:var(--cream);color:var(--ink);font-weight:600;font-size:14px;padding:14px 24px;border-radius:999px;text-transform:lowercase;transition:transform .12s,background .15s}
.cta-btn:hover{background:#ffffff}
.cta-btn .i{width:15px;height:15px}

.foot{text-align:center;margin-top:56px;font-size:13px;color:var(--grey);line-height:1.8}
.foot a{color:var(--ink);text-decoration:underline;text-underline-offset:3px}
.foot img{height:15px;width:auto;opacity:.8;display:block;margin:0 auto 10px}
.coach-line{text-align:center;margin-top:18px;font-size:12.5px}
.coach-line a{color:var(--grey);text-decoration:underline;text-decoration-color:var(--line-strong);text-underline-offset:3px}
.coach-line a:hover{color:var(--ink)}

@media(max-width:960px){.grid,.grid-2,.grid-wide{grid-template-columns:1fr;max-width:460px;margin-left:auto;margin-right:auto}.grid-wide{margin-top:20px}}
@media(max-width:700px){.top{padding:0 16px;height:64px}.hero{padding:48px 16px 24px}.h1{font-size:44px;letter-spacing:-1.6px}.wrap{padding:16px 16px 72px}.plan-wide{grid-template-columns:1fr;grid-template-areas:"head" "price" "feat" "btn"}.plan-wide .plan-price-row{justify-content:flex-start;margin-top:12px}.includes{border-radius:18px}.cta{padding:36px 28px}.cta h2{font-size:32px}.section-title{font-size:36px}.faq-item p{padding-right:4px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`;

function plansPage(product, req) {
  const signedIn = !!req.isAdmin;
  const loggedIn = signedIn;
  const p = PRODUCTS[product];
  const copy = PAGE_COPY[product];
  const hero = HERO[product];

  const productToggle = Object.keys(PRODUCTS).map(key => `
    <a class="product-opt ${key === product ? 'on' : ''}" href="/plans?product=${key}">${TAB_MARK[key]
      ? `<img src="/img/${TAB_MARK[key]}" alt=""/>`
      : `<span class="duo"><img src="/img/care-mark.svg" alt=""/><img src="/img/element-mark.svg" alt=""/></span>`}${PRODUCTS[key].tab || PRODUCTS[key].label}</a>
  `).join('');

  const faq = FAQ[product].map(k => SITE_FAQ[k]).map(([q, a]) => `
      <details class="faq-item">
        <summary>${q}<span class="faq-toggle">${icon('plus')}</span></summary>
        <p>${a}</p>
      </details>`).join('');

  const tierCards = `
    ${productTierCard(product, 'starter', p.tiers.starter, loggedIn)}
    ${productTierCard(product, 'growth', p.tiers.growth, loggedIn)}`;

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
${PLANS_CSS}</style></head><body>

<div class="top">
  <a class="top-logo" href="https://www.ingoodcocollective.com/" aria-label="In Good Company Collective home">
    <img class="top-wordmark" src="/img/igc-wordmark.svg" alt="in good company."/>
  </a>
  <div class="top-spacer"></div>
  ${signedIn
    ? `<a href="${copy.backHref}" class="top-link">${copy.backText}</a>`
    : '<a href="/signin" class="top-link">Sign in</a>'}
</div>

<header class="hero">
  <div class="hero-marks">${hero.marks.map(([f, alt]) => `<img src="/img/${f}" alt="${alt}"/>`).join('<span class="plus">+</span>')}</div>
  <h1 class="h1">${hero.title}</h1>
  <p class="lede">${p.tagline}</p>
  <div class="controls">
    ${SHOW_ALL_PRODUCTS ? `<div class="product-toggle-inner" role="navigation" aria-label="Product">${productToggle}</div>` : ''}
    ${copy.note ? `<div class="no-trial">${copy.note}</div>` : ''}
  </div>
</header>

<main class="wrap">
  ${product === 'care360' ? `
  <div class="grid">
    ${specialCard(SPECIAL_PLANS.trial)}
    ${tierCards}
  </div>
  <div class="grid-wide">
    ${specialCard(SPECIAL_PLANS.community)}
    ${specialCard(SPECIAL_PLANS.enterprise)}
  </div>` : `
  <div class="grid grid-2">${tierCards}</div>`}

  <div class="includes">${icon('check-circle')}<span>${copy.foot}</span></div>

  <section class="faq" aria-labelledby="faq-title">
    <h2 class="section-title" id="faq-title">questions, answered.</h2>
    ${faq}
  </section>

  <section class="cta">
    <div>
      <h2>not sure which plan fits?</h2>
      <p>Tell us about your organization and we'll help you choose, or set up a demo.</p>
    </div>
    <a class="cta-btn" href="${CONTACT_URL}">let's talk${icon('arrow-right')}</a>
  </section>

  <div class="foot">
    <img src="/img/igc-wordmark.svg" alt="in good company."/>
    Questions? <a href="mailto:info@ingoodcocollective.com">Get in touch</a>.
  </div>
  <p class="coach-line"><a href="${COACH_PAGE_URL}">coach or consultant? see coach pricing.</a></p>
</main>

</body></html>`;
}

// ── Coach pricing ────────────────────────────────────────────
// Unlisted (noindex, not linked from the app's nav): reached from the
// website's coach page, https://ingoodcocollective.com/coaches/. Coaches
// buy the existing monthly Starter price of each product, with no
// leader band, and a coach's CARE 360 sign-up starts with the same free
// trial everyone else gets. Every button carries audience=coach, which
// is what checkout and the Stripe webhook use to mark a coach account.
const coachRouter = express.Router();

const COACH_PRODUCT_KEYS = { care360: 'care360', element: 'element_profile', element_profile: 'element_profile', bundle: 'bundle' };

const COACH_CARDS = {
  care360: {
    name: 'care 360',
    mark: 'care-mark.svg',
    features: ['Unlimited leaders and surveys', 'Unlimited raters', 'The full AI report and PDF', 'Automatic reminders and deadlines', 'Leadership Action Plan template']
  },
  element_profile: {
    name: 'the element profile',
    mark: 'element-mark.svg',
    features: ['Unlimited people assessed', 'Full archetype report for every person', 'Role and target-profile comparison reports', 'Team creation and management']
  },
  bundle: {
    name: 'the bundle',
    mark: null,
    features: ['Everything in care 360', 'Everything in The Element Profile', 'One login, one subscription', 'Save $100 a month versus buying separately']
  }
};

function coachCard(productKey, highlighted, loggedIn) {
  const card = COACH_CARDS[productKey];
  const monthly = PRODUCTS[productKey].tiers.starter.monthly;
  const trial = productKey === 'care360' && !loggedIn;
  const href = loggedIn || productKey !== 'care360'
    ? (loggedIn
      ? `/billing/checkout?products=${productKey}&tier=starter&billing=monthly&audience=coach`
      : `/signup?products=${productKey}&tier=starter&billing=monthly&audience=coach`)
    : '/signup?products=care360&audience=coach';
  const mark = card.mark
    ? `<img class="coach-mark" src="/img/${card.mark}" alt=""/>`
    : '<span class="coach-mark duo"><img src="/img/care-mark.svg" alt=""/><img src="/img/element-mark.svg" alt=""/></span>';
  return `
  <div class="plan ${highlighted ? 'plan-featured' : 'plan-plain'}" id="${productKey === 'element_profile' ? 'element' : productKey}">
    <div class="plan-head">
      ${mark}
      <div class="plan-name">${card.name}</div>
    </div>
    <div class="plan-price-row"><span class="plan-price">${money(monthly)}</span><span class="plan-per">/month</span></div>
    <div class="plan-sub">${trial ? 'free trial first, then billed monthly' : 'billed monthly'}</div>
    ${featureList(card.features)}
    <a class="plan-btn ${highlighted ? 'plan-btn-primary' : ''}" href="${href}">${trial ? 'start free trial' : `choose ${card.name}`}${icon('arrow-right')}</a>
  </div>`;
}

coachRouter.get('/', (req, res) => {
  const highlight = COACH_PRODUCT_KEYS[req.query.product] || null;
  const loggedIn = !!req.isAdmin;
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="robots" content="noindex, nofollow"/>
<title>Coach pricing | In Good Company</title>
<link rel="icon" type="image/svg+xml" href="/img/care-mark.svg"/>
<style>
${PLANS_CSS}
.coach-mark{display:block;height:22px;width:auto;margin-bottom:14px}
.coach-mark.duo{display:inline-flex}
.coach-mark.duo img{height:22px;width:auto}
.coach-mark.duo img+img{margin-left:-6px}
.coach-note{text-align:center;margin-top:26px;font-size:14px;color:var(--grey)}
</style></head><body>

<div class="top">
  <a class="top-logo" href="https://www.ingoodcocollective.com/" aria-label="In Good Company Collective home">
    <img class="top-wordmark" src="/img/igc-wordmark.svg" alt="in good company."/>
  </a>
  <div class="top-spacer"></div>
  ${loggedIn ? '<a href="/admin" class="top-link">Back to your account</a>' : '<a href="/signin" class="top-link">Sign in</a>'}
</div>

<header class="hero">
  <div class="hero-marks"><img src="/img/care360-wordmark.svg" alt="care 360."/><span class="plus">+</span><img src="/img/element-wordmark.svg" alt="element."/></div>
  <h1 class="h1">coach pricing, billed monthly.</h1>
  <p class="lede">Monthly plans for your client work with CARE 360 and The Element Profile, with no limit on how many leaders you run.</p>
</header>

<main class="wrap">
  <div class="grid">
    ${['care360', 'element_profile', 'bundle'].map(k => coachCard(k, k === highlight, loggedIn)).join('')}
  </div>
  <p class="coach-note">for coaches and consultants using our tools with their clients.</p>

  <div class="foot">
    <img src="/img/igc-wordmark.svg" alt="in good company."/>
    Questions? <a href="mailto:info@ingoodcocollective.com">Get in touch</a>.
  </div>
</main>

</body></html>`);
});

module.exports = router;
module.exports.PRODUCTS = PRODUCTS;
module.exports.SPECIAL_PLANS = SPECIAL_PLANS;
module.exports.coachRouter = coachRouter;
