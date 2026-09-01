// ============================================================
// Supabase Auth helpers
//
// Three kinds of database connection exist in this app now:
//
//   1. The service client (src/db/client.js). Ignores row level
//      security. Used by survey routes, where the rater is not
//      logged in and the token is the security boundary.
//
//   2. authClient(). Anonymous. Only used to sign people up and
//      log them in.
//
//   3. userClient(token). Acts as one specific logged in user.
//      Row level security applies, so the database itself will
//      not return another account's rows.
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const admin = require('./db/client');

const URL  = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;

const OPTS = { auth: { persistSession: false, autoRefreshToken: false } };

function authClient() {
  return createClient(URL, ANON, OPTS);
}

function userClient(accessToken) {
  return createClient(URL, ANON, {
    ...OPTS,
    global: { headers: { Authorization: `Bearer ${accessToken}` } }
  });
}

// ── Sign up ──────────────────────────────────────────────────
// Creates the auth user, then the account, then links them.

async function signUp({ email, password, name, organization }) {
  const auth = authClient();

  const { data, error } = await auth.auth.signUp({
    email,
    password,
    options: { data: { full_name: name || null } }
  });

  if (error) return { error: error.message };

  // Supabase returns a user with an empty identities array when the
  // email is already registered, rather than an error.
  if (!data.user || (data.user.identities && data.user.identities.length === 0)) {
    return { error: 'An account with that email already exists. Try signing in instead.' };
  }

  // Account and link row are written with the service client, because
  // the new user has no session yet when email confirmation is on.
  const { data: account, error: acctErr } = await admin
    .from('accounts')
    .insert([{ name: organization, plan: 'trial', status: 'active' }])
    .select()
    .single();

  if (acctErr) {
    console.error('ACCOUNT CREATE FAILED', email, acctErr.message);
    return { error: 'Your login was created but the account setup failed. Please contact support.' };
  }

  const { error: linkErr } = await admin
    .from('account_users')
    .insert([{
      account_id:   account.id,
      auth_user_id: data.user.id,
      email,
      name:         name || null,
      role:         'owner'
    }]);

  if (linkErr) {
    console.error('ACCOUNT LINK FAILED', email, linkErr.message);
    return { error: 'Your login was created but the account setup failed. Please contact support.' };
  }

  return { user: data.user, account, needsConfirmation: !data.session };
}

// ── Sign in ──────────────────────────────────────────────────

async function signIn({ email, password }) {
  const auth = authClient();
  const { data, error } = await auth.auth.signInWithPassword({ email, password });

  if (error) {
    if (/confirm/i.test(error.message)) {
      return { error: 'Please confirm your email address first. Check your inbox for the link.' };
    }
    return { error: 'That email and password combination was not recognized.' };
  }
  return { session: data.session, user: data.user };
}

// ── Read the current session from cookies ────────────────────
// Returns null when nobody is logged in. Refreshes a stale access
// token automatically so people are not thrown out every hour.

async function getSession(req, res) {
  const access  = req.signedCookies && req.signedCookies.sbAccess;
  const refresh = req.signedCookies && req.signedCookies.sbRefresh;
  if (!access && !refresh) return null;

  if (access) {
    const auth = authClient();
    const { data, error } = await auth.auth.getUser(access);
    if (!error && data && data.user) {
      return await attachAccount(data.user, access);
    }
  }

  if (refresh) {
    const auth = authClient();
    const { data, error } = await auth.auth.refreshSession({ refresh_token: refresh });
    if (!error && data && data.session) {
      setSessionCookies(res, data.session);
      return await attachAccount(data.session.user, data.session.access_token);
    }
  }

  clearSessionCookies(res);
  return null;
}

async function attachAccount(user, accessToken) {
  const { data: link } = await admin
    .from('account_users')
    .select('*, accounts(*)')
    .eq('auth_user_id', user.id)
    .single();

  if (!link) return null;

  return {
    user,
    accessToken,
    accountId: link.account_id,
    account:   link.accounts,
    name:      link.name,
    email:     link.email,
    role:      link.role,
    db:        userClient(accessToken)
  };
}

// ── Cookies ──────────────────────────────────────────────────

function setSessionCookies(res, session) {
  const base = {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  };
  res.cookie('sbAccess',  session.access_token,  { ...base, maxAge: 60 * 60 * 1000 });
  res.cookie('sbRefresh', session.refresh_token, { ...base, maxAge: 30 * 24 * 60 * 60 * 1000 });
}

function clearSessionCookies(res) {
  res.clearCookie('sbAccess');
  res.clearCookie('sbRefresh');
}

module.exports = {
  authClient,
  userClient,
  signUp,
  signIn,
  getSession,
  setSessionCookies,
  clearSessionCookies
};
