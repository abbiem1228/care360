// ============================================================
// CARE 360 billing gate
//
// Mounted in front of every signed-in CARE 360 page and form (/admin,
// /report, /guide), so access is checked on every request, not only at
// sign-in. Billing, sign-in/out, plans and rater links are never behind
// it. See src/access.js for how a product's state is decided.
// ============================================================

const supabase = require('../db/client');
const { productAccess, productPending, dataKeptUntil, accountSubscriptions, LOCKED_STATES } = require('../access');
const { shell } = require('./account');
const { adminShell } = require('./admin');

const INFO_EMAIL = 'info@ingoodcocollective.com';

// Under /admin, always reachable whatever the billing state: the legacy
// shared-password login/logout, and switching to Element Profile.
const ALWAYS_ALLOWED = ['/admin/login', '/admin/logout', '/admin/handoff/element-profile'];

// Read-only mode allows every GET except these: they start something
// new (a fresh AI report, or a form whose only purpose is to create).
const READ_ONLY_BLOCKED_GETS = [
  /^\/report\/generate\//,
  /^\/admin\/cycles\/new$/,
  /^\/admin\/cycles\/[^/]+\/leaders\/new$/,
  /^\/admin\/leaders\/[^/]+\/raters\/new$/
];

// The only form posts read-only mode allows: closing a survey early,
// changing the dates of a Group that's currently open, and removing a
// rater. Every other status change stays blocked, and so does changing
// a closed Group's dates, since saving a future close date reopens it.
async function isAllowedWhileReadOnly(req, fullPath) {
  if (req.method !== 'POST') return false;
  if (/^\/admin\/cycles\/[^/]+\/status$/.test(fullPath)) return !!req.body && req.body.status === 'closed';
  if (/^\/admin\/raters\/[^/]+\/delete$/.test(fullPath)) return true;
  const dates = fullPath.match(/^\/admin\/cycles\/([^/]+)\/dates$/);
  if (dates) {
    const { data: cycle } = await supabase
      .from('cycles')
      .select('status')
      .eq('id', dates[1])
      .eq('account_id', req.accountId)
      .maybeSingle();
    return !!cycle && cycle.status === 'active';
  }
  return false;
}

async function careAccessGate(req, res, next) {
  // Signed out, or the legacy shared-password admin with no account:
  // the routes' own requireAuth handles those exactly as before.
  if (!req.accountId || !req.account) return next();

  const fullPath = req.baseUrl + req.path;
  if (ALWAYS_ALLOWED.includes(fullPath)) return next();

  let subs;
  try {
    subs = await accountSubscriptions(req.accountId);
  } catch (e) {
    // Never lock a paying customer out over a failed lookup.
    console.error('CARE 360 access check failed:', e.message);
    return next();
  }

  const state = productAccess(req.account, subs, 'care360');
  req.care360Access = state;
  req.care360Pending = productPending(subs, 'care360');
  req.elementAccess = productAccess(req.account, subs, 'element_profile');

  // A payment awaiting verification keeps whatever access the product
  // already has (a trial, or a current plan), with a banner. Only when
  // there would otherwise be no access does the pending page show.
  if (req.care360Pending && LOCKED_STATES.includes(state)) return res.status(403).send(pendingPage(req));

  if (state === 'active' || state === 'none') return next();

  if (state === 'past_due') {
    if (req.method === 'GET' && !READ_ONLY_BLOCKED_GETS.some(re => re.test(fullPath))) return next();
    if (await isAllowedWhileReadOnly(req, fullPath)) return next();
    return res.status(403).send(readOnlyBlockedPage(req));
  }

  if (state === 'unpaid') return res.status(403).send(pausedPage(req));
  req.care360KeptUntil = dataKeptUntil(subs, 'care360');
  return res.status(403).send(endedPage(req));
}

// ── Shared pieces ────────────────────────────────────────────

function manageBillingLink(req) {
  return req.account && req.account.stripe_customer_id
    ? '<a href="/billing/portal" class="btn" style="display:block;text-align:center;text-decoration:none">Manage billing</a>'
    : '';
}

// Only when Element Profile itself is fully usable, so the link never
// leads to a second locked page.
function elementLink(req) {
  return req.elementAccess === 'active'
    ? '<div class="alt"><a href="/admin/handoff/element-profile">Go to Element Profile</a></div>'
    : '';
}

function footerLinks(req) {
  return `${elementLink(req)}
    <div class="alt">Questions? <a href="mailto:${INFO_EMAIL}">${INFO_EMAIL}</a></div>
    <div class="alt"><a href="/signout">Sign out</a></div>`;
}

// ── Pages ────────────────────────────────────────────────────

function readOnlyBlockedPage(req) {
  return adminShell('Paused while billing is past due', `<div class="card" style="max-width:560px">
    <h2 style="font-family:'EB Garamond',serif;font-size:22px;margin-bottom:8px">This is paused for now</h2>
    <p style="font-size:14px;color:#595959;line-height:1.7;margin-bottom:16px">While your last payment is past due, you can still view everything, including existing reports, close a survey early, change an open Group's dates and remove a rater, but you can't make other changes or start anything new. Updating your billing restores full access right away.</p>
    ${req.account && req.account.stripe_customer_id ? '<a href="/billing/portal" class="btn btn-primary">Manage billing</a>' : ''}
    <a href="/admin" class="btn btn-ghost">Back to dashboard</a>
  </div>`, req);
}

function pendingPage(req) {
  return shell('Payment pending', `
    <div class="title">Your payment is pending verification</div>
    <div class="sub">As soon as your card is verified, you'll have full access to CARE 360. If your bank asked you to confirm the payment, you can finish that in Manage billing.</div>
    ${manageBillingLink(req)}
    ${footerLinks(req)}`);
}

function pausedPage(req) {
  return shell('Subscription paused', `
    <div class="title">Your subscription is paused</div>
    <div class="sub">Your subscription is paused because payment didn't go through. Update your billing to restore access. Paying the open invoice in Manage billing restores everything automatically.</div>
    ${manageBillingLink(req)}
    ${footerLinks(req)}`);
}

// Matches the Terms (Section 5.4) and Privacy Policy: data is kept for
// 60 days after cancellation, then permanently deleted.
function endedPage(req) {
  return shell('Subscription ended', `
    <div class="title">Your CARE 360 subscription has ended</div>
    <div class="sub">Your account and data are kept ${req.care360KeptUntil ? `until ${req.care360KeptUntil}` : 'for 60 days after your subscription ends'}, so you can resubscribe and pick up where you left off, or ask us for an export. After that, they're permanently deleted.</div>
    <a href="/plans?product=care360" class="btn" style="display:block;text-align:center;text-decoration:none">Resubscribe</a>
    ${req.account && req.account.stripe_customer_id ? '<div class="alt"><a href="/billing/portal">Manage billing and past invoices</a></div>' : ''}
    ${footerLinks(req)}`);
}

module.exports = { careAccessGate };
