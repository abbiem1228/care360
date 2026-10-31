// ============================================================
// The account page (/admin/account): one place for everything about
// the account itself, for both products. Email and password (one
// Supabase login covers care 360 and Element Profile), the team who can
// sign in to this account, and links to billing, which lives in this
// app for both.
//
// Email and password changes go through Supabase's own user endpoint
// with the person's own access token, so Supabase applies its own
// rules (confirmation emails, password strength). Team changes are
// owner-only and checked here; the rows are written with the service
// client, always filtered to this account.
// ============================================================

const express  = require('express');
const router   = express.Router();
const Stripe   = require('stripe');
const supabase = require('../db/client');
const { authClient, setSessionCookies } = require('../auth');
const { adminShell, escapeHtml, avatar } = require('./admin');

const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const ELEMENT_PROFILE_URL = process.env.ELEMENT_PROFILE_URL || 'https://element.ingoodcocollective.com';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

let stripeClient = null;
function stripe() {
  if (!stripeClient) stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripeClient;
}

function requireAuth(req, res, next) {
  if (req.isAdmin && req.session && req.accountId) return next();
  res.redirect('/signin');
}

const isOwner = req => !!(req.session && req.session.role === 'owner');

// Supabase's own user endpoint, as the signed-in person. The same call
// supabase-js's updateUser makes, without needing a stored session.
async function updateAuthUser(accessToken, body, redirectTo) {
  const url = `${SUPABASE_URL}/auth/v1/user${redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : ''}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return { error: data.msg || data.message || data.error_description || `status ${response.status}` };
  return { user: data };
}

// ── Email change confirmed: catch up ─────────────────────────────
// Supabase changes the login's email only once the change is
// confirmed. The next request after that sees the new address on the
// login and brings the rest up to date: this account's account_users
// row, and the Stripe customer's email when it was this person's old
// address (a teammate changing their own email never touches the
// billing contact). Runs on every signed-in request, but only does
// anything when the two differ.
async function syncConfirmedEmail(req) {
  const session = req.session;
  if (!session || !session.user || !session.user.email || !session.email) return;
  const newEmail = session.user.email.toLowerCase();
  const oldEmail = session.email.toLowerCase();
  if (newEmail === oldEmail) return;

  const { error } = await supabase
    .from('account_users')
    .update({ email: newEmail })
    .eq('auth_user_id', session.user.id)
    .eq('account_id', session.accountId);
  if (error) {
    console.error('Could not update account_users email after a confirmed change:', error.message);
    return;
  }
  session.email = newEmail;
  console.log('Login email changed and confirmed; account_users updated');

  const customerId = session.account && session.account.stripe_customer_id;
  if (!customerId) return;
  try {
    const customer = await stripe().customers.retrieve(customerId);
    if (customer && !customer.deleted && (customer.email || '').toLowerCase() === oldEmail) {
      await stripe().customers.update(customerId, { email: newEmail });
      console.log('Stripe customer email updated to match the confirmed login email');
    }
  } catch (e) {
    console.error('Could not update the Stripe customer email after a confirmed change:', e.message);
  }
}

// ── Page ─────────────────────────────────────────────────────────

// Fixed messages, picked by key, so nothing anyone typed ends up in
// the page address.
const NOTICES = {
  'email-sent': { ok: true, text: 'Check your new inbox to confirm the change. Your email stays the same until you do. If you also get an email at your current address, confirm that one too.' },
  'email-changed': { ok: true, text: 'Your email is changed.' },
  'password-changed': { ok: true, text: 'Your password is changed. Any other place you were signed in, Element Profile included, will ask you to sign in again.' },
  removed: { ok: true, text: 'Removed. They no longer have access to care 360 or Element Profile.' },
  'invite-cancelled': { ok: true, text: 'Invite cancelled. The link in that email no longer works.' },
  'invite-sent': { ok: true, text: 'Invite sent.' },
  'not-owner': { ok: false, text: 'Only the account owner can change the team.' },
  'cant-remove-self': { ok: false, text: "You can't remove yourself. The account always needs its owner." },
  'last-owner': { ok: false, text: 'The account always needs at least one owner, so this person stays.' },
  'not-found': { ok: false, text: 'That person or invite is no longer on this account.' },
  'invite-failed': { ok: false, text: "That invite email didn't send, so no invite was created. Check the address and try again." },
};

async function loadPage(req) {
  const [{ data: teammates }, { data: invites }, { data: authUser }] = await Promise.all([
    supabase.from('account_users').select('*').eq('account_id', req.accountId).order('created_at', { ascending: true }),
    supabase.from('account_invites').select('*').eq('account_id', req.accountId).is('accepted_at', null).order('created_at', { ascending: false }),
    supabase.auth.admin.getUserById(req.session.user.id),
  ]);
  const pendingEmail = authUser && authUser.user && authUser.user.new_email ? authUser.user.new_email : null;
  return { teammates: teammates || [], invites: invites || [], pendingEmail };
}

const fmtDate = iso => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

function accountPage(req, data, errors = {}) {
  const { teammates, invites, pendingEmail } = data;
  const acct = req.account || {};
  const owner = isOwner(req);
  const notice = NOTICES[req.query.done] || NOTICES[req.query.error];
  const noticeHtml = notice ? `<div class="flash ${notice.ok ? 'flash-ok' : 'flash-warn'}" role="${notice.ok ? 'status' : 'alert'}">${notice.text}</div>` : '';
  const fieldError = key => (errors[key] ? `<div class="flash flash-warn" role="alert" style="margin:0 0 16px">${escapeHtml(errors[key])}</div>` : '');

  const memberRows = teammates.map(t => {
    const display = t.name || t.email;
    const isSelf = t.auth_user_id === req.session.user.id;
    const removable = owner && !isSelf;
    const confirmText = `remove ${display}? they'll lose access right away.`;
    return `<tr>
      <td><span class="person">${avatar(display)}${escapeHtml(t.name || '')}${t.name ? '' : '<span style="color:#ccc">&mdash;</span>'}${isSelf ? ' <span class="badge badge-draft">you</span>' : ''}</span></td>
      <td style="color:var(--grey)">${escapeHtml(t.email)}</td>
      <td><span class="badge badge-active">${escapeHtml(t.role)}</span></td>
      <td>${fmtDate(t.created_at)}</td>
      <td style="text-align:right">${removable
        ? `<form method="POST" action="/admin/account/team/${encodeURIComponent(t.id)}/remove" style="display:inline" onsubmit="return confirm(${escapeHtml(JSON.stringify(confirmText))})"><button class="btn btn-red btn-sm" type="submit">remove</button></form>`
        : ''}</td>
    </tr>`;
  }).join('');

  const inviteRows = invites.map(i => `<tr>
      <td><span class="person">${avatar(i.name || i.email)}${escapeHtml(i.name || '')}${i.name ? '' : '<span style="color:#ccc">&mdash;</span>'}</span></td>
      <td style="color:var(--grey)">${escapeHtml(i.email)}</td>
      <td><span class="badge badge-draft">pending</span></td>
      <td>${fmtDate(i.created_at)}</td>
      <td style="text-align:right">${owner
        ? `<form method="POST" action="/admin/account/invites/${encodeURIComponent(i.id)}/cancel" style="display:inline"><button class="btn btn-ghost btn-sm" type="submit">cancel invite</button></form>`
        : ''}</td>
    </tr>`).join('');

  const hasBoth = acct.has_care360 && acct.has_element_profile;
  const bundleLink = acct.has_care360 && !acct.has_element_profile
    ? 'upgrade to the bundle and get Element Profile too'
    : acct.has_element_profile && !acct.has_care360 ? 'upgrade to the bundle and get care 360 too' : null;
  const products = [acct.has_care360 && 'care 360', acct.has_element_profile && 'Element Profile'].filter(Boolean).join(' and ') || 'no products yet';

  return adminShell('Account', `${noticeHtml}
    <div class="page-header">
      <div>
        <div class="page-title">account.</div>
        <div class="page-sub">Your login, your team and billing, for care 360 and Element Profile.${acct.has_element_profile ? ` <a href="${ELEMENT_PROFILE_URL}/admin">back to Element Profile</a>` : ''}</div>
      </div>
    </div>

    <div class="account-grid">
      <div class="card" id="email">
        <div class="card-header"><span class="card-title">email</span></div>
        ${fieldError('email')}
        <p class="form-hint" style="margin:0 0 14px">You sign in to care 360 and Element Profile with <strong>${escapeHtml(req.session.user.email)}</strong>.</p>
        ${pendingEmail ? `<div class="flash flash-ok" role="status" style="margin:0 0 16px">Waiting for you to confirm <strong>${escapeHtml(pendingEmail)}</strong>. Check that inbox.</div>` : ''}
        <form method="POST" action="/admin/account/email">
          <div class="form-group">
            <label class="form-label" for="new-email">new email</label>
            <input class="form-control" id="new-email" type="email" name="email" required autocomplete="email"/>
          </div>
          <button class="btn btn-primary" type="submit">change email</button>
        </form>
      </div>

      <div class="card" id="password">
        <div class="card-header"><span class="card-title">password</span></div>
        ${fieldError('password')}
        <form method="POST" action="/admin/account/password">
          <div class="form-group">
            <label class="form-label" for="current-password">current password</label>
            <input class="form-control" id="current-password" type="password" name="current_password" required autocomplete="current-password"/>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="new-password">new password</label>
              <input class="form-control" id="new-password" type="password" name="new_password" required minlength="8" autocomplete="new-password"/>
            </div>
            <div class="form-group">
              <label class="form-label" for="confirm-password">confirm new password</label>
              <input class="form-control" id="confirm-password" type="password" name="confirm_password" required minlength="8" autocomplete="new-password"/>
            </div>
          </div>
          <div class="form-hint" style="margin:-6px 0 14px">At least 8 characters. This is your password for both care 360 and Element Profile.</div>
          <button class="btn btn-primary" type="submit">change password</button>
        </form>
      </div>
    </div>

    <div class="card" id="team" style="margin-top:20px">
      <div class="card-header"><span class="card-title">team</span></div>
      <p class="form-hint" style="margin:0 0 14px">Everyone here can sign in to this account in care 360${acct.has_element_profile ? ' and Element Profile' : ''}.${owner ? ' Removing someone ends their access to both right away.' : ' Only the account owner can remove people or cancel invites.'}</p>
      <div class="table-scroll">
        <table class="data-table team-table">
          <thead><tr><th>name</th><th>email</th><th>role</th><th>joined</th><th></th></tr></thead>
          <tbody>${memberRows}</tbody>
        </table>
      </div>
      ${invites.length ? `
      <div class="card-title" style="margin:24px 0 10px;font-size:18px">pending invites</div>
      <div class="table-scroll">
        <table class="data-table team-table">
          <thead><tr><th>name</th><th>email</th><th>status</th><th>sent</th><th></th></tr></thead>
          <tbody>${inviteRows}</tbody>
        </table>
      </div>` : ''}
      <div class="card-title" style="margin:24px 0 10px;font-size:18px">invite a teammate</div>
      <form method="POST" action="/admin/team/invites" class="invite-form">
        <div class="form-group" style="margin:0">
          <label class="form-label" for="invite-name">name</label>
          <input class="form-control" id="invite-name" name="name" placeholder="Jane Smith"/>
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label" for="invite-email">email</label>
          <input class="form-control" id="invite-email" type="email" name="email" required placeholder="jane@acme.com"/>
        </div>
        <button class="btn btn-primary" type="submit">send invite</button>
      </form>
    </div>

    <div class="card" id="billing" style="margin-top:20px">
      <div class="card-header"><span class="card-title">billing</span></div>
      <p class="form-hint" style="margin:0 0 14px">This account has ${products}${acct.plan === 'trial' ? ', on a free trial' : ''}. Billing for both products is managed here.</p>
      <div class="billing-actions">
        ${acct.stripe_customer_id ? '<a href="/billing/portal" class="btn btn-primary">manage billing</a>' : ''}
        ${bundleLink ? `<a href="/billing/upgrade-to-bundle" class="btn btn-ghost">${bundleLink}</a>` : ''}
        ${acct.plan === 'trial' ? `<a href="${acct.is_coach ? '/coach?product=care360' : '/plans'}" class="btn btn-ghost">upgrade</a>` : ''}
        ${!acct.stripe_customer_id && !bundleLink && acct.plan !== 'trial' ? `<span class="form-hint" style="margin:0">${hasBoth ? 'You have both products.' : ''} Nothing to manage here yet.</span>` : ''}
      </div>
    </div>
    <style>
      .account-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start}
      .invite-form{display:grid;grid-template-columns:1fr 1fr auto;gap:12px;align-items:end}
      .billing-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
      .table-scroll{overflow-x:auto}
      @media(max-width:900px){.account-grid{grid-template-columns:1fr}}
      /* Phones: each person becomes a small stacked block, so the
         email wraps and the remove / cancel buttons stay in view. */
      @media(max-width:700px){
        .invite-form{grid-template-columns:1fr}
        .team-table thead{display:none}
        .team-table,.team-table tbody{display:block;width:100%}
        .team-table tr{display:grid;grid-template-columns:1fr auto;gap:4px 12px;padding:12px 0;border-bottom:1px solid var(--line)}
        .team-table td{display:block;padding:0;border:0;overflow-wrap:anywhere}
        .team-table td:nth-child(1){grid-column:1/-1}
        .team-table td:nth-child(2){grid-column:1/-1;font-size:13px}
        .team-table td:nth-child(4){display:none}
        .team-table td:nth-child(5){text-align:right!important}
      }
    </style>`, req);
}

router.get('/account', requireAuth, async (req, res) => {
  res.send(accountPage(req, await loadPage(req)));
});

// ── Change email ─────────────────────────────────────────────────

router.post('/account/email', requireAuth, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const fail = async message => res.status(400).send(accountPage(req, await loadPage(req), { email: message }));

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Please enter a valid email address.');
  if (email === req.session.user.email.toLowerCase()) return fail("That's already your email.");

  const { error } = await updateAuthUser(req.session.accessToken, { email }, `${APP_URL}/admin/account?done=email-changed`);
  if (error) {
    console.error('Email change request failed:', error);
    if (/already|registered|exists/i.test(error)) return fail('That email is already used by another login.');
    if (/rate|too many|seconds/i.test(error)) return fail('Too many email changes in a short time. Please wait a minute and try again.');
    return fail("Couldn't start the email change. Please try again.");
  }
  res.redirect('/admin/account?done=email-sent');
});

// ── Change password ──────────────────────────────────────────────

router.post('/account/password', requireAuth, async (req, res) => {
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');
  const confirmNext = String(req.body.confirm_password || '');
  const fail = async message => res.status(400).send(accountPage(req, await loadPage(req), { password: message }));

  if (!current || !next) return fail('Please fill in every password field.');
  if (next.length < 8) return fail('Please choose a new password of at least 8 characters.');
  if (next !== confirmNext) return fail("The new passwords don't match.");

  // Checking the current password is a fresh sign-in, which also
  // satisfies Supabase's "recent sign-in" rule for a password change.
  const auth = authClient();
  const { data: checked, error: wrong } = await auth.auth.signInWithPassword({ email: req.session.user.email, password: current });
  if (wrong || !checked || !checked.session) return fail("That current password isn't right.");

  const { error } = await updateAuthUser(checked.session.access_token, { password: next });
  if (error) {
    // The sign-in above was only a check: end that extra session.
    await fetch(`${SUPABASE_URL}/auth/v1/logout?scope=local`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${checked.session.access_token}` },
    }).catch(() => {});
    console.error('Password change failed:', error);
    if (/different|same/i.test(error)) return fail('Please choose a password different from your current one.');
    if (/weak|short|characters|strength/i.test(error)) return fail("That password isn't strong enough. Try a longer one.");
    return fail("Couldn't change your password. Please try again.");
  }
  // Supabase signs out every other session when a password changes,
  // this browser's included, so the session from the check above
  // becomes this browser's sign-in.
  setSessionCookies(res, checked.session);
  res.redirect('/admin/account?done=password-changed');
});

// ── Team ─────────────────────────────────────────────────────────

router.post('/account/team/:id/remove', requireAuth, async (req, res) => {
  if (!isOwner(req)) return res.redirect('/admin/account?error=not-owner#team');

  const { data: target } = await supabase
    .from('account_users')
    .select('id, auth_user_id, role')
    .eq('id', req.params.id)
    .eq('account_id', req.accountId)
    .maybeSingle();
  if (!target) return res.redirect('/admin/account?error=not-found#team');
  if (target.auth_user_id === req.session.user.id) return res.redirect('/admin/account?error=cant-remove-self#team');

  if (target.role === 'owner') {
    const { count } = await supabase
      .from('account_users')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', req.accountId)
      .eq('role', 'owner');
    if ((count || 0) <= 1) return res.redirect('/admin/account?error=last-owner#team');
  }

  // Both apps look this row up on every request, so deleting it ends
  // their access to care 360 and Element Profile on their next click.
  const { error } = await supabase.from('account_users').delete().eq('id', target.id).eq('account_id', req.accountId);
  if (error) throw error;
  console.log('Account owner removed a teammate');
  res.redirect('/admin/account?done=removed#team');
});

router.post('/account/invites/:id/cancel', requireAuth, async (req, res) => {
  if (!isOwner(req)) return res.redirect('/admin/account?error=not-owner#team');
  const { data, error } = await supabase
    .from('account_invites')
    .delete()
    .eq('id', req.params.id)
    .eq('account_id', req.accountId)
    .is('accepted_at', null)
    .select('id');
  if (error) throw error;
  if (!data || !data.length) return res.redirect('/admin/account?error=not-found#team');
  res.redirect('/admin/account?done=invite-cancelled#team');
});

module.exports = router;
module.exports.syncConfirmedEmail = syncConfirmedEmail;
