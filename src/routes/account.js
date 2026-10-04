const express = require('express');
const router  = express.Router();
const { signUp, signIn, requestPasswordReset, setSessionCookies, clearSessionCookies, authClient, redeemHandoffToken } = require('../auth');

const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const supabase = require('../db/client');

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

const PRODUCT_LABELS = { care360: 'CARE 360', element_profile: 'Element Profile', bundle: 'Bundle' };
const TIER_LABELS     = { starter: 'Starter', growth: 'Growth' };

function purchaseLabel(tier, products) {
  if (products === 'bundle') return tier === 'growth' ? 'Growth Bundle' : 'Starter Bundle';
  return `${PRODUCT_LABELS[products]} ${TIER_LABELS[tier]}`;
}

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
  const tier     = TIERS.includes(req.query.tier) ? req.query.tier : null;
  const products = PRODUCTS.includes(req.query.products) ? req.query.products : 'care360';
  const billing  = req.query.billing === 'annual' ? 'annual' : 'monthly';
  // Only CARE 360 has a free trial. An Element Profile or Bundle signup
  // without a paid tier goes back to that product's plans, never into
  // the CARE 360 trial signup.
  if (products !== 'care360' && !tier) {
    return res.redirect(`/plans?product=${products}`);
  }
  res.send(signupPage(null, {}, tier, products, billing));
});

router.get('/signin', (req, res) => {
  const error = req.query.handoff === 'failed' ? 'That link has expired or has already been used. Please sign in.' : null;
  res.send(signinPage(error));
});

// ── Sign up ───────────────────────────────────────────────────

router.post('/signup', async (req, res) => {
  const { name, email, password, organization, agree_terms } = req.body;
  const tier     = TIERS.includes(req.body.tier) ? req.body.tier : null;
  const products = PRODUCTS.includes(req.body.products) ? req.body.products : 'care360';
  const billing  = req.body.billing === 'annual' ? 'annual' : 'monthly';
  if (products !== 'care360' && !tier) {
    return res.redirect(`/plans?product=${products}`);
  }

  if (!email || !password || !organization) {
    return res.send(signupPage('Please fill in every required field.', req.body, tier, products, billing));
  }
  if (password.length < 8) {
    return res.send(signupPage('Please choose a password of at least 8 characters.', req.body, tier, products, billing));
  }
  if (products === 'bundle') {
    if (req.body.agree_terms_care360 !== 'on' || req.body.agree_terms_element !== 'on') {
      return res.send(signupPage('Please agree to both CARE 360\'s and Element Profile\'s Terms of Service and Privacy Policy to create a Bundle account.', req.body, tier, products, billing));
    }
  } else if (agree_terms !== 'on') {
    return res.send(signupPage('Please agree to the Terms of Service and Privacy Policy to create an account.', req.body, tier, products, billing));
  }

  const result = await signUp({
    email: email.trim().toLowerCase(),
    password,
    name: (name || '').trim(),
    organization: organization.trim(),
    termsAcceptedAt: new Date().toISOString()
  });

  if (result.error) return res.send(signupPage(result.error, req.body, tier, products, billing));

  // A paid tier was chosen. Remember it and which product it buys
  // across the email confirmation gap in a short-lived signed cookie,
  // so the moment this person actually signs in for the first time,
  // they land directly in checkout for what they picked rather than a
  // trial dashboard.
  if (tier) {
    res.cookie('pendingPurchase', JSON.stringify({ tier, products, billing }), { ...COOKIE_OPTS, maxAge: 7 * 24 * 60 * 60 * 1000 });
  }

  if (result.needsConfirmation) {
    return res.send(messagePage(
      'Check your email',
      tier
        ? `We have sent a confirmation link to <strong>${email.trim()}</strong>. Click it, then sign in below, and you will be taken straight to checkout to finish setting up your ${purchaseLabel(tier, products)} plan.`
        : `We have sent a confirmation link to <strong>${email.trim()}</strong>. Click it to activate your account, then sign in.`,
      'Go to sign in', '/signin'
    ));
  }

  // No confirmation required, a session already exists.
  setSessionCookies(res, result.session);
  if (tier) {
    return res.redirect(`/billing/checkout?tier=${tier}&products=${products}&billing=${billing}`);
  }
  return res.redirect('/admin');
});

// ── Sign in ───────────────────────────────────────────────────

router.post('/signin', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.send(signinPage('Please enter your email and password.'));

  const result = await signIn({ email: email.trim().toLowerCase(), password });
  if (result.error) return res.send(signinPage(result.error, email));

  setSessionCookies(res, result.session);

  // If this person signed up for a paid tier but had to confirm their
  // email first, this is the moment that gets honored: send them
  // straight into checkout instead of the dashboard, then forget it.
  const pending = req.signedCookies && req.signedCookies.pendingPurchase;
  if (pending) {
    res.clearCookie('pendingPurchase');
    try {
      const { tier, products, billing } = JSON.parse(pending);
      if (TIERS.includes(tier)) {
        const resolvedProducts = PRODUCTS.includes(products) ? products : 'care360';
        return res.redirect(`/billing/checkout?tier=${tier}&products=${resolvedProducts}&billing=${billing || 'monthly'}`);
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
    return res.send(inviteAcceptPage(invite, 'An account with that email already exists on CARE 360. Sign in with it instead, or ask whoever invited you to double-check the email address.'));
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
  // next=/billing/portal?return=..., since the portal lives in this
  // app. Only the portal path is honored, so this can never become
  // an open redirect; billing.js separately checks the return target.
  const next = typeof req.query.next === 'string' ? req.query.next : '';
  if (next === '/billing/portal' || next.startsWith('/billing/portal?')) {
    return res.redirect(next);
  }
  res.redirect('/admin');
});

// ══════════════════════════════════════════════════════════════
// Pages
// ══════════════════════════════════════════════════════════════

const CSS = `
<style>
@import url('https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--ink:#30383B;--clay:#A9633D;--sage:#7C8863;--sand:#D9CBB2;--cream:#F7F4EF;--warm:#EDE8DF;--grey:#595959}
body{font-family:'Inter',Arial,sans-serif;background:var(--ink);color:var(--ink);font-size:14px;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
a{color:var(--clay);text-decoration:none}a:hover{text-decoration:underline}
.wrap{width:100%;max-width:460px}
.card{background:white;border-radius:14px;padding:44px 46px;box-shadow:0 20px 60px rgba(0,0,0,0.25)}
.logo{display:flex;align-items:center;gap:12px;margin-bottom:30px}
.logo-mark{width:46px;height:46px;background:var(--clay);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:22px;font-family:'EB Garamond',serif;color:white;font-weight:600}
.logo-name{font-family:'EB Garamond',serif;font-size:20px;color:var(--ink);line-height:1.2}
.logo-sub{font-size:12px;color:var(--grey)}
.title{font-family:'EB Garamond',serif;font-size:26px;color:var(--ink);margin-bottom:6px;font-weight:600}
.sub{font-size:14px;color:var(--grey);margin-bottom:24px;line-height:1.6}
.group{margin-bottom:16px}
.label{display:block;font-size:12px;font-weight:600;color:var(--ink);margin-bottom:6px}
.control{width:100%;padding:11px 13px;border:1.5px solid var(--sand);border-radius:6px;font-size:15px;font-family:inherit;color:var(--ink);background:white;transition:border-color .15s,box-shadow .15s}
.control:focus{outline:none;border-color:var(--clay);box-shadow:0 0 0 3px rgba(169,99,61,0.12)}
.hint{font-size:11px;color:var(--grey);margin-top:5px}
.btn{width:100%;padding:13px;background:var(--ink);color:white;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;transition:background .15s;margin-top:6px}
.btn:hover{background:var(--clay)}
.alt{text-align:center;margin-top:20px;font-size:13px;color:var(--grey)}
.err{background:#FFF0EE;color:#A94442;border:1px solid #FDDDD9;border-radius:6px;padding:11px 14px;font-size:13px;margin-bottom:18px;line-height:1.6}
.foot{text-align:center;margin-top:24px;font-size:11px;color:rgba(255,255,255,0.35);letter-spacing:0.5px}
.trial{background:var(--cream);border-left:4px solid var(--sage);border-radius:0 6px 6px 0;padding:12px 15px;font-size:12.5px;color:#4A5154;line-height:1.65;margin-bottom:22px}
.plan-badge{background:var(--cream);border-left:4px solid var(--clay);border-radius:0 6px 6px 0;padding:12px 15px;font-size:12.5px;color:#4A5154;line-height:1.65;margin-bottom:22px}
.plan-badge strong{color:var(--ink)}
.terms-check{margin-bottom:20px}
.terms-label{display:flex;align-items:flex-start;gap:9px;font-size:12.5px;color:var(--grey);line-height:1.6;cursor:pointer}
.terms-label input{margin-top:3px;flex-shrink:0;width:15px;height:15px;accent-color:var(--clay);cursor:pointer}
.terms-label a{color:var(--clay);font-weight:600}
</style>`;

function shell(title, inner) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title} — CARE 360</title>${CSS}</head><body>
<div class="wrap"><div class="card">
  <div class="logo">
    <div class="logo-mark">C</div>
    <div>
      <div class="logo-name">in good company.</div>
      <div class="logo-sub">CARE 360 Leadership Survey</div>
    </div>
  </div>
  ${inner}
</div>
<div class="foot">Thoughtful &nbsp;&middot;&nbsp; Innovative &nbsp;&middot;&nbsp; Human</div>
</div></body></html>`;
}

function signupPage(error, prev, tier, products, billing) {
  const v = prev || {};
  tier     = TIERS.includes(tier) ? tier : null;
  products = PRODUCTS.includes(products) ? products : 'care360';
  billing  = billing === 'annual' ? 'annual' : 'monthly';

  const label = tier ? purchaseLabel(tier, products) : null;

  const contextBlock = label
    ? `<div class="plan-badge">You are signing up for <strong>${label}</strong>${billing === 'annual' ? ', billed annually' : ''}. Right after you create your login, you will go straight to checkout to finish setting it up.</div>`
    : `<div class="trial">Your trial covers one leader. Everything else works exactly as it does on a paid plan, including reminders, the report and the action plan.</div>`;

  return shell(label ? `Sign up for ${label}` : 'Start your free trial', `
    <div class="title">${label ? `Set up your ${label} account` : 'Start your free trial'}</div>
    <div class="sub">${label ? 'Create your login, then continue to payment.' : 'Run one full 360 at no cost, from invitations through to the finished report.'}</div>
    ${error ? `<div class="err">${error}</div>` : ''}
    ${contextBlock}
    <form method="POST" action="/signup">
      <input type="hidden" name="tier" value="${tier || ''}"/>
      <input type="hidden" name="products" value="${products}"/>
      <input type="hidden" name="billing" value="${billing}"/>
      <div class="group">
        <label class="label">Organization *</label>
        <input class="control" name="organization" required value="${v.organization || ''}" placeholder="Acme Corp"/>
        <div class="hint">The company this account belongs to.</div>
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
    <div class="alt">Already have an account? <a href="/signin">Sign in</a></div>`);
}

function signinPage(error, email) {
  return shell('Sign in', `
    <div class="title">Welcome back</div>
    <div class="sub">Sign in to manage your Groups, leaders and reports.</div>
    ${error ? `<div class="err">${error}</div>` : ''}
    <form method="POST" action="/signin">
      <div class="group">
        <label class="label">Email</label>
        <input class="control" type="email" name="email" required autofocus value="${email || ''}" placeholder="jane@acme.com"/>
      </div>
      <div class="group">
        <label class="label">Password</label>
        <input class="control" type="password" name="password" required placeholder="Your password"/>
      </div>
      <button class="btn" type="submit">Sign in</button>
    </form>
    <div class="alt"><a href="/forgot-password">Forgot password?</a></div>
    <div class="alt">No account yet? <a href="/plans">See plans</a></div>`);
}

function forgotPasswordPage({ submitted } = {}) {
  return shell('Forgot password', `
    <div class="title">Reset your password</div>
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
      <div class="title">Checking your link</div>
      <div class="sub">One moment.</div>
    </section>

    <section id="invalid" hidden>
      <div class="title">This link is not valid</div>
      <div class="sub">It may have expired, or already been used. Request a new one below.</div>
      <div class="alt"><a href="/forgot-password">Request a new link</a></div>
    </section>

    <section id="form" hidden>
      <div class="title">Set a new password</div>
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
      <div class="title">Password updated</div>
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

function messagePage(title, body, ctaLabel, ctaHref) {
  return shell(title, `
    <div class="title">${title}</div>
    <div class="sub">${body}</div>
    <a class="btn" href="${ctaHref}" style="display:block;text-align:center;text-decoration:none">${ctaLabel}</a>`);
}

function inviteAcceptPage(invite, error) {
  const accountName = invite.accounts ? invite.accounts.name : 'CARE 360';

  return shell(`Join ${accountName}`, `
    <div class="title">Join ${accountName}</div>
    <div class="sub">You have been invited to join this account on CARE 360. Set a password to finish.</div>
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
module.exports.CARE360_TERMS_URL   = CARE360_TERMS_URL;
module.exports.CARE360_PRIVACY_URL = CARE360_PRIVACY_URL;
module.exports.ELEMENT_TERMS_URL   = ELEMENT_TERMS_URL;
module.exports.ELEMENT_PRIVACY_URL = ELEMENT_PRIVACY_URL;
