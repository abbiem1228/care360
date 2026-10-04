// ============================================================
// Per-product billing access
//
// Decides what a signed-in account can do in one product, from that
// product's own subscription rows and comp, never from accounts.status
// (which is account-wide). A Bundle row covers both products. Element
// Profile has its own copy of this same logic (server/access.js).
//
//   active      full access (active/trialing, or comped)
//   past_due    read-only: view everything, change nothing
//   unpaid      locked: Stripe gave up retrying, paying restores it
//   ended       locked: canceled, incomplete_expired or paused
//   none        never purchased: existing trial behavior, no change
//
// Separately, a product is "pending" while a payment for it awaits card
// verification (Stripe status incomplete). Pending never takes access
// away: the product keeps whatever the rest of its state gives it, plus
// a banner. Only when that would be no access at all does the pending
// page replace the product.
// ============================================================

const supabase = require('./db/client');

const STRIPE_TO_STATE = {
  active: 'active',
  trialing: 'active',
  past_due: 'past_due',
  unpaid: 'unpaid',
  canceled: 'ended',
  incomplete_expired: 'ended',
  paused: 'ended'
};

// Best state wins when a product has more than one subscription row,
// e.g. an old canceled one and a new active one.
const STATE_ORDER = ['active', 'past_due', 'unpaid', 'ended'];

function coveringRows(subs, product) {
  return (subs || []).filter(s => s.products === product || s.products === 'bundle');
}

function productAccess(account, subs, product) {
  if (!account) return 'none';
  if (account[`comp_${product}`]) return 'active';
  const rows = coveringRows(subs, product).filter(s => s.status !== 'incomplete');
  if (!rows.length) return 'none';
  const states = rows.map(s => STRIPE_TO_STATE[s.status] || 'ended');
  return STATE_ORDER.find(state => states.includes(state));
}

function productPending(subs, product) {
  return coveringRows(subs, product).some(s => s.status === 'incomplete');
}

// The Terms (Section 5.4) and Privacy Policy keep data for 60 days
// after cancellation. The date shown on the ended page: 60 days after
// the latest end among this product's subscriptions. null if unknown.
const RETENTION_DAYS = 60;

function dataKeptUntil(subs, product) {
  const ends = coveringRows(subs, product)
    .map(s => s.ended_at || s.updated_at)
    .filter(Boolean)
    .map(d => new Date(d).getTime());
  if (!ends.length) return null;
  const until = new Date(Math.max(...ends) + RETENTION_DAYS * 24 * 60 * 60 * 1000);
  return until.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

async function accountSubscriptions(accountId) {
  const { data, error } = await supabase
    .from('account_subscriptions')
    .select('products, status, ended_at, updated_at')
    .eq('account_id', accountId);
  if (error) throw error;
  return data || [];
}

// For routes with no signed-in account behind them (rater links, the
// hourly jobs): looks the account up by id.
async function accessForAccountId(accountId, product) {
  if (!accountId) return 'none';
  const { data: account, error } = await supabase
    .from('accounts')
    .select('id, comp_care360, comp_element_profile')
    .eq('id', accountId)
    .maybeSingle();
  if (error) throw error;
  return productAccess(account, await accountSubscriptions(accountId), product);
}

const LOCKED_STATES = ['unpaid', 'ended'];

module.exports = { productAccess, productPending, dataKeptUntil, accountSubscriptions, accessForAccountId, LOCKED_STATES };
