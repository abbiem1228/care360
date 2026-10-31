const express = require('express');
const router  = express.Router();
const { signUp, signIn, requestPasswordReset, setSessionCookies, clearSessionCookies, authClient, redeemHandoffToken } = require('../auth');

const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const supabase = require('../db/client');
const { gtmHead, gtmBody, pushEvent, handoffPage, audienceOf } = require('../analytics');

const COOKIE_OPTS = {
  signed: true, httpOnly: true, sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production'
};

// plan is strictly a tier (starter/growth); products is strictly which
// product(s) that tier buys (care360/element_profile/bundle). Neither
// one means anything about the other, same split PRICE_MAP and
// account_subscriptions.products already use.
const TIERS    = ['starter', 'growth'];
const PRODUCTS = ['care360', 'element_profile', 'bundle'];

const PRODUCT_LABELS = { care360: 'care 360', element_profile: 'Element Profile', bundle: 'Bundle' };

// Who a purchase is for, and so how it is billed. Organizations buy
// annual plans only. Coaches (from the unlisted /coach page) buy the
// monthly Starter price of each product, and a coach's CARE 360 sign-up
// starts with the same free trial everyone else gets. Anything other than
// audience=coach is an organization, so an old ?billing=monthly link can
// never start a monthly plan.
function purchaseTerms(source, products) {
  const audience = source.audience === 'coach' ? 'coach' : 'organization';
  if (audience === 'coach') {
    return { audience, billing: 'monthly', tier: products === 'care360' ? null : 'starter' };
  }
  // Any paid tier, including an old Growth link, is the one plan for that
  // product, which is the existing Starter price.
  return { audience, billing: 'annual', tier: TIERS.includes(source.tier) ? 'starter' : null };
}

// One plan per product, named just by the product. (tier stays in the
// signature: it is always 'starter' now, the price that plan uses.)
const PLAN_NAMES = { care360: 'care 360', element_profile: 'The Element Profile', bundle: 'the bundle' };
const PLAN_TITLES = { care360: 'set up your care 360 account.', element_profile: 'set up the element profile.', bundle: 'set up the bundle.' };
function purchaseLabel(tier, products) {
  return PLAN_NAMES[products] || PLAN_NAMES.care360;
}

// A paid product someone picked before signing in or up (from /plans,
// /coach or the website), or null for a plain sign-in or the care 360
// free trial. It travels on the sign-up and sign-in links and forms, so
// switching between them never loses the choice.
function purchaseContext(source) {
  const products = PRODUCTS.includes(source.products) ? source.products : null;
  if (!products) return null;
  const { tier, billing, audience } = purchaseTerms(source, products);
  return tier ? { products, tier, billing, audience } : null;
}
const purchaseQuery = ctx => `products=${ctx.products}&tier=${ctx.tier}&billing=${ctx.billing}${ctx.audience === 'coach' ? '&audience=coach' : ''}`;
const checkoutUrl   = ctx => `/billing/checkout?${purchaseQuery(ctx)}`;
const purchaseFields = ctx => ctx ? `
      <input type="hidden" name="products" value="${ctx.products}"/>
      <input type="hidden" name="tier" value="${ctx.tier}"/>
      <input type="hidden" name="billing" value="${ctx.billing}"/>
      ${ctx.audience === 'coach' ? '<input type="hidden" name="audience" value="coach"/>' : ''}` : '';

// Same env var and default already used for the handoff redirect
// (src/routes/admin.js), not a second, separately-configured URL.
const ELEMENT_PROFILE_URL = process.env.ELEMENT_PROFILE_URL || 'https://element.ingoodcocollective.com';

const CARE360_TERMS_URL    = 'https://ingoodcocollective.com/terms';
const CARE360_PRIVACY_URL  = 'https://ingoodcocollective.com/privacy';
const ELEMENT_TERMS_URL    = `${ELEMENT_PROFILE_URL}/terms`;
const ELEMENT_PRIVACY_URL  = `${ELEMENT_PROFILE_URL}/privacy`;

// A Bundle customer is agreeing to two distinct products' real terms,
// not one document that happens to cover both, so it gets two separate
// checkboxes rather than one checkbox glossing over two agreements.
// care360-only and element_profile-only each still get a single
// checkbox, just pointed at whichever product's real documents apply.
function termsCheckboxBlock(products) {
  if (products === 'bundle') {
    return `
      <div class="group terms-check">
        <label class="terms-label">
          <input type="checkbox" name="agree_terms_care360" required/>
          <span>I agree to CARE 360's <a href="${CARE360_TERMS_URL}" target="_blank" rel="noopener">Terms of Service</a> and <a href="${CARE360_PRIVACY_URL}" target="_blank" rel="noopener">Privacy Policy</a></span>
        </label>
        <label class="terms-label" style="margin-top:8px">
          <input type="checkbox" name="agree_terms_element" required/>
          <span>I agree to Element Profile's <a href="${ELEMENT_TERMS_URL}" target="_blank" rel="noopener">Terms of Service</a> and <a href="${ELEMENT_PRIVACY_URL}" target="_blank" rel="noopener">Privacy Policy</a></span>
        </label>
      </div>`;
  }

  const termsUrl   = products === 'element_profile' ? ELEMENT_TERMS_URL   : CARE360_TERMS_URL;
  const privacyUrl = products === 'element_profile' ? ELEMENT_PRIVACY_URL : CARE360_PRIVACY_URL;
  const productName = products === 'element_profile' ? 'Element Profile' : 'CARE 360';

  return `
      <div class="group terms-check">
        <label class="terms-label">
          <input type="checkbox" name="agree_terms" required/>
          <span>I agree to ${productName}'s <a href="${termsUrl}" target="_blank" rel="noopener">Terms of Service</a> and <a href="${privacyUrl}" target="_blank" rel="noopener">Privacy Policy</a></span>
        </label>
      </div>`;
}

// ── Pages ─────────────────────────────────────────────────────

router.get('/signup', (req, res) => {
  const products = PRODUCTS.includes(req.query.products) ? req.query.products : 'care360';
  const { tier, billing, audience } = purchaseTerms(req.query, products);
  // Only CARE 360 has a free trial. An Element Profile or Bundle signup
  // without a paid tier goes back to that product's plans, never into
  // the CARE 360 trial signup.
  if (products !== 'care360' && !tier) {
    return res.redirect(`/plans?product=${products}`);
  }
  res.send(signupPage(null, {}, tier, products, billing, audience));
});

router.get('/signin', (req, res) => {
  const error = req.query.handoff === 'failed' ? 'That link has expired or has already been used. Please sign in.' : null;
  res.send(signinPage(error, '', purchaseContext(req.query)));
});

// ── Sign up ───────────────────────────────────────────────────

router.post('/signup', async (req, res) => {
  const { name, email, password, organization, agree_terms } = req.body;
  const products = PRODUCTS.includes(req.body.products) ? req.body.products : 'care360';
  const { tier, billing, audience } = purchaseTerms(req.body, products);
  if (products !== 'care360' && !tier) {
    return res.redirect(`/plans?product=${products}`);
  }

  if (!email || !password || !organization) {
    return res.send(signupPage('Please fill in every required field.', req.body, tier, products, billing, audience));
  }
  if (password.length < 8) {
    return res.send(signupPage('Please choose a password of at least 8 characters.', req.body, tier, products, billing, audience));
  }
  if (products === 'bundle') {
    if (req.body.agree_terms_care360 !== 'on' || req.body.agree_terms_element !== 'on') {
      return res.send(signupPage('Please agree to both CARE 360\'s and Element Profile\'s Terms of Service and Privacy Policy to create a Bundle account.', req.body, tier, products, billing, audience));
    }
  } else if (agree_terms !== 'on') {
    return res.send(signupPage('Please agree to the Terms of Service and Privacy Policy to create an account.', req.body, tier, products, billing, audience));
  }

  const result = await signUp({
    email: email.trim().toLowerCase(),
    password,
    name: (name || '').trim(),
    organization: organization.trim(),
    termsAcceptedAt: new Date().toISOString(),
    // A coach's free trial marks the account as a coach account now.
    // A paid coach purchase is marked by the Stripe webhook instead,
    // once checkout actually completes.
    isCoach: audience === 'coach' && !tier
  });

  if (result.error) return res.send(signupPage(result.error, req.body, tier, products, billing, audience));

  // A paid tier was chosen. Remember it and which product it buys
  // across the email confirmation gap in a short-lived signed cookie,
  // so the moment this person actually signs in for the first time,
  // they land directly in checkout for what they picked rather than a
  // trial dashboard.
  if (tier) {
    res.cookie('pendingPurchase', JSON.stringify({ tier, products, billing, audience }), { ...COOKIE_OPTS, maxAge: 7 * 24 * 60 * 60 * 1000 });
  }

  // The account exists now: tell GTM, with no name or email.
  const signUpEvent = { event: 'sign_up', product: products, plan: tier ? 'paid' : 'trial', audience: audienceOf(audience === 'coach') };

  if (result.needsConfirmation) {
    return res.send(messagePage(
      'Check your email',
      tier
        ? `We have sent a confirmation link to <strong>${email.trim()}</strong>. Click it, then sign in below, and you will be taken straight to checkout to finish setting up your ${purchaseLabel(tier, products)} plan.`
        : `We have sent a confirmation link to <strong>${email.trim()}</strong>. Click it to activate your account, then sign in.`,
      'Go to sign in', tier ? `/signin?${purchaseQuery({ tier, products, billing, audience })}` : '/signin',
      products, { analytics: true, event: signUpEvent }
    ));
  }

  // No confirmation required, a session already exists.
  setSessionCookies(res, result.session);
  const next = tier ? `/billing/checkout?tier=${tier}&products=${products}&billing=${billing}${audience === 'coach' ? '&audience=coach' : ''}` : '/admin';
  return res.send(handoffPage(signUpEvent, next));
});

// ── Sign in ───────────────────────────────────────────────────

router.post('/signin', async (req, res) => {
  const { email, password } = req.body;
  const ctx = purchaseContext(req.body);
  if (!email || !password) return res.send(signinPage('Please enter your email and password.', email, ctx));

  const result = await signIn({ email: email.trim().toLowerCase(), password });
  if (result.error) return res.send(signinPage(result.error, email, ctx));

  // A login whose owner removed it from the account still signs in to
  // Supabase, but has no account here: say so instead of looping back.
  const { data: link } = await supabase.from('account_users').select('id').eq('auth_user_id', result.user.id).maybeSingle();
  if (!link) return res.send(signinPage("This login isn't part of an account anymore. Ask the account owner to invite you again.", email, ctx));

  setSessionCookies(res, result.session);

  // Signed in from a product someone picked: straight on to that
  // checkout, which sends anyone who already has it elsewhere.
  if (ctx) {
    res.clearCookie('pendingPurchase');
    return res.redirect(checkoutUrl(ctx));
  }

  // If this person signed up for a paid tier but had to confirm their
  // email first, this is the moment that gets honored: send them
  // straight into checkout instead of the dashboard, then forget it.
  const pending = req.signedCookies && req.signedCookies.pendingPurchase;
  if (pending) {
    res.clearCookie('pendingPurchase');
    try {
      const saved = JSON.parse(pending);
      const { products, audience } = saved;
      // Any paid tier saved before this change, Growth included, is the one plan now.
      const tier = TIERS.includes(saved.tier) ? 'starter' : null;
      if (tier) {
        const resolvedProducts = PRODUCTS.includes(products) ? products : 'care360';
        const coach = audience === 'coach';
        return res.redirect(`/billing/checkout?tier=${tier}&products=${resolvedProducts}&billing=${coach ? 'monthly' : 'annual'}${coach ? '&audience=coach' : ''}`);
      }
    } catch (e) { /* malformed cookie, fall through to normal redirect */ }
  }

  res.redirect('/admin');
});

// ── Forgot password ───────────────────────────────────────────
// Mirrors Element Profile's flow. The recovery email links back to
// this app's own /reset-password, never Element's.

router.get('/forgot-password', (req, res) => res.send(forgotPasswordPage()));

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (email && typeof email === 'string' && email.trim()) {
    await requestPasswordReset(email.trim().toLowerCase(), `${APP_URL}/reset-password`);
  }
  // Same confirmation whether or not that email actually has an
  // account, or was even provided: this response must never be usable
  // to tell which emails are registered.
  res.send(forgotPasswordPage({ submitted: true }));
});

router.get('/reset-password', (req, res) => res.send(resetPasswordPage()));

// ── Sign out ──────────────────────────────────────────────────

router.get('/signout', (req, res) => {
  clearSessionCookies(res);
  res.clearCookie('adminAuth');
  res.clearCookie('pendingPurchase');
  res.redirect('/signin');
});

// ── Teammate invites ─────────────────────────────────────────
// Public routes, reached only via an emailed token. The token's own
// row state (accepted_at) is the entire validity check, same pattern
// as the rater-invite token in src/routes/survey.js. Ends in a real
// signup, but against an existing account_id, never a new accounts
// row: that's the one thing this path can never do.

router.get('/invite/:token', async (req, res) => {
  const { data: invite } = await supabase
    .from('account_invites')
    .select('*, accounts(name)')
    .eq('token', req.params.token)
    .maybeSingle();

  if (!invite) {
    return res.send(messagePage('Invite not found', 'This invitation link was not found. Please check the link or ask whoever invited you to send a new one.', 'Go to sign in', '/signin'));
  }
  if (invite.accepted_at) {
    return res.send(messagePage('Already accepted', 'This invitation has already been accepted. If this was not you, please contact whoever sent it.', 'Go to sign in', '/signin'));
  }

  res.send(inviteAcceptPage(invite, null));
});

router.post('/invite/:token', async (req, res) => {
  const { name, password } = req.body;

  const { data: invite } = await supabase
    .from('account_invites')
    .select('*, accounts(name)')
    .eq('token', req.params.token)
    .maybeSingle();

  if (!invite) {
    return res.send(messagePage('Invite not found', 'This invitation link was not found. Please check the link or ask whoever invited you to send a new one.', 'Go to sign in', '/signin'));
  }
  if (invite.accepted_at) {
    return res.send(messagePage('Already accepted', 'This invitation has already been accepted. If this was not you, please contact whoever sent it.', 'Go to sign in', '/signin'));
  }
  if (!password || password.length < 8) {
    return res.send(inviteAcceptPage(invite, 'Please choose a password of at least 8 characters.'));
  }

  const auth = authClient();
  const { data, error } = await auth.auth.signUp({
    email: invite.email,
    password,
    options: { data: { full_name: name || invite.name || null } }
  });

  if (error) return res.send(inviteAcceptPage(invite, error.message));

  // Supabase returns a user with an empty identities array when the
  // email is already registered, rather than an error. This is the
  // case that must fail honestly: an existing login can never be
  // silently attached to a second, different account, since
  // account_users.auth_user_id is unique, one login belongs to exactly
  // one account.
  if (!data.user || (data.user.identities && data.user.identities.length === 0)) {
    return res.send(inviteAcceptPage(invite, 'An account with that email already exists on care 360. Sign in with it instead, or ask whoever invited you to double-check the email address.'));
  }

  const { error: linkErr } = await supabase.from('account_users').insert([{
    account_id: invite.account_id,
    auth_user_id: data.user.id,
    email: invite.email,
    name: name || invite.name || null,
    role: 'admin'
  }]);

  if (linkErr) {
    console.error('TEAMMATE LINK FAILED', invite.email, linkErr.message);
    return res.send(messagePage('Something went wrong', 'Your login was created but joining the account failed. Please contact support.', 'Go to sign in', '/signin'));
  }

  await supabase.from('account_invites').update({ accepted_at: new Date().toISOString() }).eq('id', invite.id);

  if (!data.session) {
    return res.send(messagePage(
      'Check your email',
      `We have sent a confirmation link to <strong>${invite.email}</strong>. Click it, then sign in to join ${invite.accounts ? invite.accounts.name : 'your team'}.`,
      'Go to sign in', '/signin'
    ));
  }

  setSessionCookies(res, data.session);
  res.redirect('/admin');
});

// ── Cross-app handoff from Element Profile ──────────────────────
// Public: reached with a short-lived, single-use Supabase magic-link
// token minted by Element Profile for this same real person. Redeems
// it for a real session here, exactly like an ordinary sign-in minus
// the password. A stale or already-used token fails cleanly, same as
// Supabase's own single-use enforcement already guarantees.

router.get('/handoff', async (req, res) => {
  const token = req.query.token;
  if (!token) return res.redirect('/signin');

  const { session, error } = await redeemHandoffToken(token);
  if (error || !session) {
    console.error('CARE 360 handoff failed:', error);
    return res.redirect('/signin?handoff=failed');
  }

  setSessionCookies(res, session);

  // Element Profile's "Manage billing" link hands off here with
  // next=/billing/portal?return=..., its "Upgrade to the Bundle" link
  // with next=/billing/upgrade-to-bundle, and its "Account" link with
  // next=/admin/account, since billing and the account page live in
  // this app. Only those two paths are honored, so this can never become
  // an open redirect; billing.js separately checks the return target.
  const next = typeof req.query.next === 'string' ? req.query.next : '';
  if (next === '/billing/portal' || next.startsWith('/billing/portal?') || next === '/billing/upgrade-to-bundle' || next === '/admin/account') {
    return res.redirect(next);
  }
  res.redirect('/admin');
});

// ══════════════════════════════════════════════════════════════
// Pages
// ══════════════════════════════════════════════════════════════

const CSS = `
<style>
@import url('https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;500;600&family=Noto+Sans:wght@400;500;600;700&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--ink:#30383B;--ink-deep:#20282B;--clay:#A9633D;--ochre:#A87B2C;--ochre-light:#E3C785;--ochre-tint:#FBF5E6;--ochre-line:#EEDFB8;--danger:#A94442;--danger-tint:#FBEFED;--danger-line:#F1D3CF;--sage:#7C8863;--sand:#D9CBB2;--cream:#F7F3EA;--wash:#FAF8F4;--warm:#EDE8DF;--grey:#637074;--line:rgba(48,56,59,0.09);--line-strong:rgba(48,56,59,0.18);--shadow-lift:0 2px 4px rgba(48,56,59,0.05),0 14px 32px rgba(48,56,59,0.09);--ease:cubic-bezier(.2,.7,.2,1)}
@keyframes igc-rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
:focus-visible{outline:2px solid var(--clay);outline-offset:2px}
::selection{background:var(--ochre-light)}
body{font-family:'Noto Sans',Arial,sans-serif;background:#ffffff;color:var(--ink);font-size:14px;line-height:1.6;min-height:100vh;-webkit-font-smoothing:antialiased}
.auth{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);min-height:100vh}
.auth-art{position:sticky;top:0;height:100vh;overflow:hidden;background:#B0673F;color:#F7F3EA;display:flex;flex-direction:column;justify-content:space-between}
.auth-art::after{content:'';position:absolute;inset:0;background:linear-gradient(to top,rgba(122,64,36,0.88) 0%,rgba(122,64,36,0.45) 32%,rgba(122,64,36,0) 58%),linear-gradient(to bottom,rgba(122,64,36,0.35),rgba(122,64,36,0) 22%);pointer-events:none}
.auth-art>img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:30% 35%;animation:igc-zoom 14s ease-out both}
.auth-art-top{position:relative;z-index:1;padding:40px 56px}
@keyframes igc-zoom{from{transform:scale(1.06)}to{transform:scale(1)}}
.auth-art-copy{position:relative;z-index:1;padding:0 56px 56px;display:flex;flex-direction:column;gap:14px;max-width:600px;animation:igc-rise .8s .15s var(--ease) both}
.auth-art-mark{display:flex;align-items:center;gap:10px;font-family:'EB Garamond',Georgia,serif;font-size:22px;font-weight:500;letter-spacing:-0.4px;color:#F7F3EA}
.auth-art-mark img{position:static;width:28px;height:28px;animation:none;filter:brightness(0) invert(96%) sepia(8%) saturate(300%)}
.auth-art h2{font-family:'EB Garamond',Georgia,serif;font-weight:500;font-size:clamp(40px,4.4vw,60px);line-height:1.02;letter-spacing:-2px;text-wrap:balance}
.auth-art p{font-size:15px;line-height:1.65;color:rgba(247,243,234,0.86);max-width:400px}
.auth-main{display:flex;flex-direction:column;justify-content:center;padding:48px clamp(24px,6vw,96px)}
a{color:var(--ink);text-decoration:underline;text-decoration-color:var(--line-strong);text-underline-offset:3px}a:hover{color:var(--clay);text-decoration-color:currentColor}
.wrap{width:100%;max-width:420px;margin:0 auto}
.card{animation:igc-rise .55s var(--ease) both}
.logo{display:flex;flex-direction:column;align-items:flex-start;gap:10px;margin-bottom:40px}
.logo-mark{height:28px;width:auto;display:block}
.logo-by{font-family:'EB Garamond',Georgia,serif;font-size:15px;color:var(--grey)}
.product-switch{display:inline-flex;gap:2px;padding:3px;margin-bottom:36px;background:var(--wash);border:1px solid var(--line);border-radius:999px}
.product-switch a{display:inline-flex;align-items:center;gap:7px;padding:6px 14px 6px 8px;border-radius:999px;font-size:13px;font-weight:600;color:var(--grey);text-decoration:none;transition:color .15s,background .2s,box-shadow .2s}
.product-switch a:hover{color:var(--ink)}
.product-switch a.on{background:#ffffff;color:var(--ink);box-shadow:0 1px 2px rgba(48,56,59,0.08),0 3px 10px rgba(48,56,59,0.07)}
.product-switch img{width:18px;height:18px}
.logo-sub{font-size:13px;color:var(--grey)}
.title{font-family:'EB Garamond',Georgia,serif;font-size:42px;color:var(--ink);margin-bottom:10px;font-weight:500;letter-spacing:-1.4px;line-height:1.05;text-wrap:balance}
.sub{font-size:14px;color:var(--grey);margin-bottom:26px;line-height:1.6}
.group{margin-bottom:16px}
.label{display:block;font-size:13px;font-weight:600;color:var(--ink);margin-bottom:6px}
.control{width:100%;padding:12px 14px;border:1px solid var(--line-strong);border-radius:12px;font-size:15px;font-family:inherit;color:var(--ink);background:#ffffff;box-shadow:0 1px 2px rgba(48,56,59,0.04);transition:border-color .15s,box-shadow .15s}
.control:hover{border-color:rgba(48,56,59,0.3)}
.control::placeholder{color:#9AA2A4}
.control:focus{outline:none;border-color:var(--clay);box-shadow:0 0 0 4px rgba(169,99,61,0.12)}
.hint{font-size:12px;color:var(--grey);margin-top:6px}
.btn{text-transform:lowercase;width:100%;padding:14px;background:var(--ink);color:var(--cream);border:none;border-radius:999px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;transition:background .15s,box-shadow .2s,transform .12s;margin-top:8px;box-shadow:0 1px 2px rgba(32,40,43,0.2),inset 0 1px 0 rgba(255,255,255,0.08)}
.btn:hover{background:var(--ink-deep);box-shadow:0 6px 16px rgba(32,40,43,0.18)}
.btn:active{transform:translateY(1px) scale(.99)}
@keyframes igc-spin{to{transform:rotate(360deg)}}
.btn.is-loading{position:relative;color:transparent;pointer-events:none}
.btn.is-loading::after{content:'';position:absolute;inset:0;margin:auto;width:18px;height:18px;border-radius:50%;border:2px solid rgba(247,243,234,0.35);border-top-color:#F7F3EA;animation:igc-spin .7s linear infinite}
.alt{text-align:center;margin-top:20px;font-size:13px;color:var(--grey)}
.err{background:var(--danger-tint);border:1px solid var(--danger-line);color:var(--danger);border-radius:12px;padding:12px 14px;font-size:13px;margin-bottom:18px;line-height:1.6}
.err a{color:#A94442}
.foot{margin-top:40px;font-size:12px;color:var(--grey)}
.trial,.plan-badge{background:var(--ochre-tint);border:1px solid var(--ochre-line);border-radius:14px;padding:14px 16px;font-size:13px;color:var(--ink);line-height:1.65;margin-bottom:22px}
.plan-badge strong{color:var(--ink)}
.terms-check{margin-bottom:20px}
.terms-label{display:flex;align-items:flex-start;gap:10px;font-size:13px;color:var(--grey);line-height:1.6;cursor:pointer}
.terms-label input{margin-top:3px}
.terms-label a{color:var(--ink);font-weight:600}
/* ── Form controls: custom dropdown chevron, calendar button, checkbox ── */
select.form-control,select.control{appearance:none;-webkit-appearance:none;background:#fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23637074' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E") right 12px center/16px no-repeat;padding-right:38px;cursor:pointer}
input[type=datetime-local],input[type=date]{font-variant-numeric:tabular-nums;min-height:44px;color:var(--ink)}
input[type=datetime-local]::-webkit-datetime-edit,input[type=date]::-webkit-datetime-edit{padding:0}
input[type=datetime-local]:not(:valid)::-webkit-datetime-edit,input[type=datetime-local][value=""]::-webkit-datetime-edit{color:#9AA2A4}
input[type=datetime-local]::-webkit-calendar-picker-indicator,input[type=date]::-webkit-calendar-picker-indicator{cursor:pointer;width:18px;height:18px;padding:5px;margin-right:-6px;border-radius:8px;opacity:1;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23A9633D' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect width='18' height='18' x='3' y='4' rx='2'/%3E%3Cpath d='M16 2v4'/%3E%3Cpath d='M8 2v4'/%3E%3Cpath d='M3 10h18'/%3E%3C/svg%3E") center/18px no-repeat;transition:background-color .15s}
input[type=datetime-local]::-webkit-calendar-picker-indicator:hover,input[type=date]::-webkit-calendar-picker-indicator:hover{background-color:#F7ECE5}
input[type=checkbox]{appearance:none;-webkit-appearance:none;width:18px;height:18px;margin:2px 0 0;border:1.5px solid rgba(48,56,59,0.3);border-radius:6px;background:#fff;cursor:pointer;flex-shrink:0;transition:background-color .15s,border-color .15s,box-shadow .15s}
input[type=checkbox]:hover{border-color:#30383B}
input[type=checkbox]:checked{border-color:#30383B;background:#30383B url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4 8.3l2.6 2.6L12 5.5' fill='none' stroke='%23F7F3EA' stroke-width='1.9' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center/14px no-repeat}
input[type=checkbox]:focus-visible{outline:2px solid #A9633D;outline-offset:2px}
@media(max-width:860px){.auth{grid-template-columns:1fr}.auth-art{position:relative;height:220px}.auth-art-top{padding:20px 24px;display:flex;justify-content:flex-end}.auth-art-copy{padding:0 24px 24px}.auth-art h2,.auth-art p{display:none}.auth-main{padding:36px 20px 48px;justify-content:flex-start}.logo{display:none}.product-switch{margin-bottom:28px}.title{font-size:36px}}
/* The Element Profile: sage, as on its own sign-in page. */
.brand-element .auth-art{background:#4A5636}
.brand-element .auth-art::after{background:linear-gradient(to top,rgba(62,72,44,0.94) 0%,rgba(62,72,44,0.86) 26%,rgba(62,72,44,0.5) 46%,rgba(62,72,44,0) 66%),linear-gradient(to bottom,rgba(62,72,44,0.78) 0%,rgba(62,72,44,0.5) 14%,rgba(62,72,44,0.18) 28%,rgba(62,72,44,0) 42%)}
.brand-element .trial,.brand-element .plan-badge{background:#F2F4EE;border-color:#DCE2D1}
/* The bundle: In Good Company clay, the copy up in the photo's open wall and the people below. */
.brand-bundle .auth-art{justify-content:flex-start}
.brand-bundle .auth-art>img{object-position:50% 100%}
.brand-bundle .auth-art::after{background:linear-gradient(to bottom,rgba(122,64,36,0.55) 0%,rgba(122,64,36,0.3) 38%,rgba(122,64,36,0) 60%)}
.brand-bundle .auth-art-copy{padding-top:8px}
.auth-art-mark .duo,.logo-products .duo{display:inline-flex}
.auth-art-mark .duo img{filter:none}
.duo img+img{margin-left:-6px}
.logo-igc{height:24px}
.logo-products{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--grey)}
.logo-products img{width:20px;height:20px;display:block}
@media(max-width:860px){.brand-element .auth-art::after{background:linear-gradient(to bottom,rgba(62,72,44,0.74) 0%,rgba(62,72,44,0.52) 50%,rgba(62,72,44,0.78) 100%)}.brand-bundle .auth-art::after{background:linear-gradient(to bottom,rgba(122,64,36,0.6),rgba(122,64,36,0.2) 70%)}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
</style>`;

// The sign-in and sign-up pages wear the brand of whatever was picked:
// care 360, The Element Profile (sage, its own photo and marks), or the
// bundle (In Good Company, both marks). Everything else is care 360.
const BRANDS = {
  care360: {
    suffix: 'care 360', icon: '/img/care-mark.svg', photo: '/img/care360-photo.jpg',
    mark: '<img src="/img/care-mark.svg" alt=""/>care 360',
    headline: 'turn feedback into a place to start.',
    lede: '360-degree leadership feedback built around connect, accountable, reach and empower.',
    logo: '<img class="logo-mark" src="/img/care360-wordmark.svg" alt="care 360."/>\n    <div class="logo-by">by in good company.</div>'
  },
  element_profile: {
    cls: 'brand-element', suffix: 'The Element Profile', icon: '/img/element-mark.svg', photo: '/img/element-photo.jpg',
    mark: '<img src="/img/element-mark.svg" alt=""/>element',
    headline: 'the element profile. understand how your people work best.',
    logo: '<img class="logo-mark" src="/img/element-wordmark.svg" alt="element."/>\n    <div class="logo-by">by in good company.</div>'
  },
  bundle: {
    cls: 'brand-bundle', suffix: 'In Good Company', icon: '/img/igc-mark.svg', photo: '/img/igc-hero-clay-mobile.webp',
    mark: '<span class="duo"><img src="/img/care-mark-light.svg" alt=""/><img src="/img/element-mark-light.svg" alt=""/></span>in good company',
    headline: 'care 360 and the element profile. two tools, one account.',
    logo: '<img class="logo-mark logo-igc" src="/img/igc-wordmark.svg" alt="in good company."/>\n    <div class="logo-products"><span class="duo"><img src="/img/care-mark.svg" alt=""/><img src="/img/element-mark.svg" alt=""/></span>care 360 and the element profile</div>'
  }
};

// opts.switcher adds the care 360 / element switch above the form, for the
// plain sign-in page only, matching the sign-in menu on ingoodcocollective.com.
// opts.brand picks the page's brand (care 360 when missing).
// opts.analytics loads Google Tag Manager, for the public sign-up and
// sign-in pages only; opts.event is a dataLayer event to push with it.
function shell(title, inner, opts = {}) {
  const b = BRANDS[opts.brand] || BRANDS.care360;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>${opts.analytics ? pushEvent(opts.event) + gtmHead() : ''}
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title} | ${b.suffix}</title><link rel="icon" type="image/svg+xml" href="${b.icon}"/>${CSS}</head><body${b.cls ? ` class="${b.cls}"` : ''}>${opts.analytics ? gtmBody() : ''}
<div class="auth">
<aside class="auth-art">
  <img src="${b.photo}" alt=""/>
  <div class="auth-art-top"><div class="auth-art-mark">${b.mark}</div></div>
  <div class="auth-art-copy">
    <h2>${b.headline}</h2>
    ${b.lede ? `<p>${b.lede}</p>` : ''}
  </div>
</aside>
<main class="auth-main">
<div class="wrap"><div class="card">
  ${opts.switcher ? `<nav class="product-switch" aria-label="Choose a product">
    <a class="on" href="/signin" aria-current="page"><img src="/img/care-mark.svg" alt=""/>care 360</a>
    <a href="${ELEMENT_PROFILE_URL}/signin"><img src="/img/element-mark.svg" alt=""/>element</a>
  </nav>` : ''}
  <div class="logo">
    ${b.logo}
  </div>
  ${inner}
</div>
<div class="foot">Thoughtful &nbsp;&middot;&nbsp; Innovative &nbsp;&middot;&nbsp; Human</div>
</div>
</main>
</div>
<script>document.addEventListener('submit',function(e){if(e.defaultPrevented)return;var b=e.submitter||e.target.querySelector('button[type=submit],button:not([type])');if(!b||b.classList.contains('is-loading'))return;b.classList.add('is-loading');b.setAttribute('aria-busy','true');setTimeout(function(){b.disabled=true},0)});window.addEventListener('pageshow',function(e){if(e.persisted)document.querySelectorAll('.is-loading').forEach(function(b){b.classList.remove('is-loading');b.disabled=false;b.removeAttribute('aria-busy')})});</script>
</body></html>`;
}

function signupPage(error, prev, tier, products, billing, audience) {
  const v = prev || {};
  tier     = TIERS.includes(tier) ? tier : null;
  products = PRODUCTS.includes(products) ? products : 'care360';
  billing  = billing === 'monthly' ? 'monthly' : 'annual';
  const coach = audience === 'coach';

  const label = tier ? purchaseLabel(tier, products) : null;

  const contextBlock = label
    ? `<div class="plan-badge"><strong>You are signing up for ${label}, ${coach ? 'billed monthly at coach pricing' : 'billed annually'}.</strong> Right after you create your login, you will go straight to checkout to finish setting it up.</div>`
    : `<div class="trial">Your trial covers one leader. Everything else works exactly as it does on a paid plan, including reminders, the report and the action plan.${coach ? ' When you are ready, care 360 is $149 a month at coach pricing.' : ''}</div>`;

  return shell('Sign up', `
    <div class="title">${label ? PLAN_TITLES[products] : 'start your free trial.'}</div>
    <div class="sub">${label ? 'Create your login, then continue to payment.' : 'Run one full 360 at no cost, from invitations through to the finished report.'}</div>
    ${error ? `<div class="err">${error}</div>` : ''}
    ${contextBlock}
    <form method="POST" action="/signup">
      <input type="hidden" name="tier" value="${tier || ''}"/>
      <input type="hidden" name="products" value="${products}"/>
      <input type="hidden" name="billing" value="${billing}"/>
      ${coach ? '<input type="hidden" name="audience" value="coach"/>' : ''}
      <div class="group">
        <label class="label">Organization *</label>
        <input class="control" name="organization" required value="${v.organization || ''}" placeholder="Acme Corp"/>
        <div class="hint">${coach ? 'Your practice or business name.' : 'The company this account belongs to.'}</div>
      </div>
      <div class="group">
        <label class="label">Your name</label>
        <input class="control" name="name" value="${v.name || ''}" placeholder="Jane Smith"/>
      </div>
      <div class="group">
        <label class="label">Work email *</label>
        <input class="control" type="email" name="email" required value="${v.email || ''}" placeholder="jane@acme.com"/>
      </div>
      <div class="group">
        <label class="label">Password *</label>
        <input class="control" type="password" name="password" required placeholder="At least 8 characters"/>
      </div>
      ${termsCheckboxBlock(products)}
      <button class="btn" type="submit">${label ? `Continue to payment` : 'Create my account'}</button>
    </form>
    <div class="alt">already have an account? <a href="${tier ? `/signin?${purchaseQuery({ products, tier, billing, audience })}` : '/signin'}">sign in</a></div>`, { brand: products, analytics: true });
}

function signinPage(error, email, ctx) {
  return shell('Sign in', `
    <div class="title">welcome back.</div>
    <div class="sub">${ctx ? `Sign in to continue to checkout for ${purchaseLabel(ctx.tier, ctx.products)}.` : 'Sign in to manage your Groups, leaders and reports.'}</div>
    ${error ? `<div class="err">${error}</div>` : ''}
    <form method="POST" action="/signin">${purchaseFields(ctx)}
      <div class="group">
        <label class="label">Email</label>
        <input class="control" type="email" name="email" required autofocus value="${String(email || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}" placeholder="jane@acme.com"/>
      </div>
      <div class="group">
        <label class="label">Password</label>
        <input class="control" type="password" name="password" required placeholder="Your password"/>
      </div>
      <button class="btn" type="submit">Sign in</button>
    </form>
    <div class="alt"><a href="/forgot-password">Forgot password?</a></div>
    <div class="alt">${ctx ? `new here? <a href="/signup?${purchaseQuery(ctx)}">create an account</a>` : 'No account yet? <a href="/plans">See plans</a>'}</div>`, ctx ? { brand: ctx.products, analytics: true } : { switcher: true, analytics: true });
}

function forgotPasswordPage({ submitted } = {}) {
  return shell('Forgot password', `
    <div class="title">reset your password.</div>
    ${submitted
      ? `<div class="sub">If an account exists for that email, we've sent a link to reset your password. Check your inbox.</div>`
      : `<div class="sub">Enter your email and we'll send you a link to set a new password.</div>
    <form method="POST" action="/forgot-password">
      <div class="group">
        <label class="label">Email</label>
        <input class="control" type="email" name="email" required autofocus placeholder="jane@acme.com"/>
      </div>
      <button class="btn" type="submit">Send reset link</button>
    </form>`}
    <div class="alt"><a href="/signin">Back to sign in</a></div>`);
}

// The recovery link Supabase emails lands the browser here with the
// session token in the URL (a hash fragment or a ?code= param,
// depending on flow configuration), which the server never sees, so
// the whole exchange runs client side. Same logic as Element Profile's
// proven page, in this app's own styling.
function resetPasswordPage() {
  return shell('Set a new password', `
    <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/dist/umd/supabase.js"></script>

    <section id="loading">
      <div class="title">checking your link.</div>
      <div class="sub">One moment.</div>
    </section>

    <section id="invalid" hidden>
      <div class="title">this link isn't valid.</div>
      <div class="sub">It may have expired, or already been used. Request a new one below.</div>
      <div class="alt"><a href="/forgot-password">Request a new link</a></div>
    </section>

    <section id="form" hidden>
      <div class="title">set a new password.</div>
      <div class="sub">Choose a new password for your account.</div>
      <form id="reset-form">
        <div class="group">
          <label class="label" for="password">New password</label>
          <input class="control" type="password" id="password" required minlength="8" placeholder="At least 8 characters"/>
        </div>
        <div class="group">
          <label class="label" for="confirmPassword">Confirm password</label>
          <input class="control" type="password" id="confirmPassword" required minlength="8"/>
        </div>
        <div class="err" id="form-error" hidden></div>
        <button class="btn" type="submit">Set new password</button>
      </form>
    </section>

    <section id="success" hidden>
      <div class="title">password updated.</div>
      <div class="sub">Your password has been changed. You can sign in with it now.</div>
      <div class="alt"><a href="/signin">Go to sign in</a></div>
    </section>

    <script>
      const supabaseClient = supabase.createClient('${process.env.SUPABASE_URL}', '${process.env.SUPABASE_ANON_KEY}', {
        auth: { persistSession: false },
      });

      async function init() {
        const hashParams   = new URLSearchParams(window.location.hash.slice(1));
        const accessToken  = hashParams.get('access_token');
        const refreshToken = hashParams.get('refresh_token');
        const code = new URLSearchParams(window.location.search).get('code');

        let sessionEstablished = false;
        if (accessToken && refreshToken) {
          const { error } = await supabaseClient.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
          sessionEstablished = !error;
        } else if (code) {
          const { error } = await supabaseClient.auth.exchangeCodeForSession(code);
          sessionEstablished = !error;
        }

        document.getElementById('loading').hidden = true;
        document.getElementById(sessionEstablished ? 'form' : 'invalid').hidden = false;
      }

      document.getElementById('reset-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const password = document.getElementById('password').value;
        const confirmPassword = document.getElementById('confirmPassword').value;
        const errorEl = document.getElementById('form-error');
        errorEl.hidden = true;

        if (password !== confirmPassword) {
          errorEl.textContent = 'Passwords do not match.';
          errorEl.hidden = false;
          return;
        }

        const submitButton = e.target.querySelector('button');
        submitButton.disabled = true;
        submitButton.textContent = 'Saving...';

        const { error } = await supabaseClient.auth.updateUser({ password });
        if (error) {
          errorEl.textContent = error.message;
          errorEl.hidden = false;
          submitButton.disabled = false;
          submitButton.textContent = 'Set new password';
          return;
        }

        document.getElementById('form').hidden = true;
        document.getElementById('success').hidden = false;
      });

      init();
    </script>`);
}

// opts.analytics and opts.event are as in shell(), for the check-your-email
// page after a sign-up only.
function messagePage(title, body, ctaLabel, ctaHref, brand, opts = {}) {
  return shell(title, `
    <div class="title">${title}</div>
    <div class="sub">${body}</div>
    <a class="btn" href="${ctaHref}" style="display:block;text-align:center;text-decoration:none">${ctaLabel}</a>`, { brand, analytics: opts.analytics, event: opts.event });
}

function inviteAcceptPage(invite, error) {
  const accountName = invite.accounts ? invite.accounts.name : 'care 360';

  return shell(`Join ${accountName}`, `
    <div class="title">join ${accountName}.</div>
    <div class="sub">You have been invited to join this account on care 360. Set a password to finish.</div>
    ${error ? `<div class="err">${error}</div>` : ''}
    <form method="POST" action="/invite/${invite.token}">
      <div class="group">
        <label class="label">Email</label>
        <input class="control" value="${invite.email}" disabled/>
      </div>
      <div class="group">
        <label class="label">Your name</label>
        <input class="control" name="name" value="${invite.name || ''}" placeholder="Jane Smith"/>
      </div>
      <div class="group">
        <label class="label">Password *</label>
        <input class="control" type="password" name="password" required placeholder="At least 8 characters"/>
      </div>
      <button class="btn" type="submit">Join ${accountName}</button>
    </form>
    <div class="alt">Already have an account? <a href="/signin">Sign in</a></div>`);
}

module.exports = router;
// Exposed so billing.js can point Stripe Checkout's own terms
// consent at the exact same real URLs, per product, instead of a
// second, separately-maintained copy.
module.exports.shell = shell;
module.exports.messagePage = messagePage;
module.exports.CARE360_TERMS_URL   = CARE360_TERMS_URL;
module.exports.CARE360_PRIVACY_URL = CARE360_PRIVACY_URL;
module.exports.ELEMENT_TERMS_URL   = ELEMENT_TERMS_URL;
module.exports.ELEMENT_PRIVACY_URL = ELEMENT_PRIVACY_URL;
