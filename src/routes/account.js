const express = require('express');
const router  = express.Router();
const { signUp, signIn, setSessionCookies, clearSessionCookies, authClient, redeemHandoffToken } = require('../auth');
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

// ── Pages ─────────────────────────────────────────────────────

router.get('/signup', (req, res) => {
  const tier     = TIERS.includes(req.query.tier) ? req.query.tier : null;
  const products = PRODUCTS.includes(req.query.products) ? req.query.products : 'care360';
  const billing  = req.query.billing === 'annual' ? 'annual' : 'monthly';
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

  if (!email || !password || !organization) {
    return res.send(signupPage('Please fill in every required field.', req.body, tier, products, billing));
  }
  if (password.length < 8) {
    return res.send(signupPage('Please choose a password of at least 8 characters.', req.body, tier, products, billing));
  }
  if (agree_terms !== 'on') {
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
      <div class="group terms-check">
        <label class="terms-label">
          <input type="checkbox" name="agree_terms" required/>
          <span>I agree to the <a href="https://ingoodcocollective.com/terms" target="_blank" rel="noopener">Terms of Service</a> and <a href="https://ingoodcocollective.com/privacy" target="_blank" rel="noopener">Privacy Policy</a></span>
        </label>
      </div>
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
    <div class="alt">No account yet? <a href="/plans">See plans</a></div>`);
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
