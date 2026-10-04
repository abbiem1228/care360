// ============================================================
// Data retention: deleting a product's data 60 days after it ends
//
// The Terms (Section 5.4) and both Privacy Policies keep data for 60
// days after a subscription ends, then permanently delete it. This
// module decides, per account and per product, where each one stands,
// counts exactly what deleting it would remove (the dry run), and
// performs the deletion once the owner approves it in HQ. Nothing here
// ever deletes on its own: the daily job only warns and reports.
//
// Covers both products, since CARE 360 and Element Profile share one
// database. Stripe customers and invoices are never touched; an unpaid
// subscription is canceled in Stripe before its data goes.
// ============================================================

const Stripe   = require('stripe');
const supabase = require('./db/client');
const { productAccess, productPending } = require('./access');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const RETENTION_DAYS = 60;
const WARNING_DAYS   = 7;
const DAY_MS         = 24 * 60 * 60 * 1000;

const PRODUCTS = ['care360', 'element_profile'];
const PRODUCT_LABELS = { care360: 'CARE 360', element_profile: 'Element Profile' };

// What each product's deletion removes, in the order it's deleted
// (rows that others point at go last). Each entry is
// [table, [[column, which id list], ...]]; a row matching any listed
// column is included. CARE 360 rows carry account_id, but a few tables
// allow it to be empty, so rows are also matched through the account's
// Groups and leaders.
const CARE_TABLES = [
  ['custom_comments',     [['account_id', 'accountIds'], ['cycle_id', 'cycleIds'], ['leader_id', 'leaderIds']]],
  ['custom_responses',    [['account_id', 'accountIds'], ['leader_id', 'leaderIds']]],
  ['start_stop_continue', [['account_id', 'accountIds'], ['leader_id', 'leaderIds']]],
  ['open_text',           [['account_id', 'accountIds'], ['leader_id', 'leaderIds']]],
  ['responses',           [['account_id', 'accountIds'], ['leader_id', 'leaderIds']]],
  ['reports',             [['account_id', 'accountIds'], ['leader_id', 'leaderIds']]],
  ['raters',              [['account_id', 'accountIds'], ['leader_id', 'leaderIds']]],
  ['leaders',             [['account_id', 'accountIds'], ['cycle_id', 'cycleIds']]],
  ['custom_questions',    [['account_id', 'accountIds'], ['cycle_id', 'cycleIds']]],
  ['cycles',              [['account_id', 'accountIds']]]
];

// Element Profile tables hang off the account's organization. Each entry
// is [table, [[column, which id list], ...]]; a row matching any listed
// column is included. Cached team narratives live on element_teams.
const ELEMENT_TABLES = [
  ['element_manager_team_comparisons', [['team_id', 'teamIds'], ['manager_person_id', 'personIds']]],
  ['element_manager_comparisons',      [['person_id', 'personIds'], ['manager_person_id', 'personIds']]],
  ['element_role_comparisons',         [['role_id', 'roleIds'], ['person_id', 'personIds']]],
  ['element_team_members',             [['team_id', 'teamIds'], ['person_id', 'personIds']]],
  ['element_target_profiles',          [['role_id', 'roleIds']]],
  ['element_invites',                  [['organization_id', 'orgIds']]],
  ['element_scores',                   [['session_id', 'sessionIds']]],
  ['element_responses',                [['session_id', 'sessionIds']]],
  ['element_sessions',                 [['organization_id', 'orgIds']]],
  ['element_teams',                    [['organization_id', 'orgIds']]],
  ['element_roles',                    [['organization_id', 'orgIds']]],
  ['people',                           [['organization_id', 'orgIds']]],
  ['organizations',                    [['account_id', 'accountIds']]]
];

// Removed only when the whole account goes (see accountCanBeDeleted).
// Logins (Supabase Auth users) are deleted through the Auth admin API
// first, which also removes their account_users rows.
const ACCOUNT_TABLES = ['account_invites', 'account_subscriptions', 'account_users', 'accounts'];

// ── Where each product stands ────────────────────────────────

const covers = (s, product) => s.products === product || s.products === 'bundle';

// When the product's latest subscription ended. Unpaid counts from the
// day it became unpaid.
function productEndedAt(subs, product) {
  const dates = subs
    .filter(s => covers(s, product) && ['canceled', 'incomplete_expired', 'paused', 'unpaid'].includes(s.status))
    .map(s => (s.status === 'unpaid' ? s.unpaid_at : s.ended_at) || s.updated_at)
    .filter(Boolean)
    .map(d => new Date(d).getTime());
  return dates.length ? new Date(Math.max(...dates)) : null;
}

function addDays(date, days) { return new Date(date.getTime() + days * DAY_MS); }
function isoDate(date) { return date.toISOString().slice(0, 10); }

// One product on one account:
//   keep      active, past due, pending, or comped: never deleted
//   none      never purchased: nothing to delete under this policy
//   counting  ended, more than 7 days before its deletion date
//   warn      inside the 7-day window, owner not yet warned
//   warned    owner warned, deletion date not reached yet
//   due       deletion date reached, owner warned at least 7 days ago:
//             listed for approval
//   deleted   already deleted, and not purchased again since
function productStatus(account, subs, logs, product, now) {
  if (account[`comp_${product}`]) return { status: 'keep', reason: 'comped' };
  if (productPending(subs, product)) return { status: 'keep', reason: 'payment pending' };

  const state = productAccess(account, subs, product);
  if (state === 'none') return { status: 'none' };
  if (state === 'active' || state === 'past_due') return { status: 'keep', reason: state.replace('_', ' ') };

  const endedAt = productEndedAt(subs, product);
  if (!endedAt) return { status: 'keep', reason: 'end date unknown' };

  // A deletion counts for this product unless it was bought again after.
  const latestPurchase = Math.max(...subs.filter(s => covers(s, product)).map(s => new Date(s.created_at).getTime()));
  const deletedLog = logs.find(l => l.action === 'deleted' && l.product === product && new Date(l.created_at).getTime() > latestPurchase);
  if (deletedLog) return { status: 'deleted', deletedOn: isoDate(new Date(deletedLog.created_at)) };

  const policyDate = addDays(endedAt, RETENTION_DAYS);
  const warning = logs
    .filter(l => l.action === 'warning_sent' && l.product === product && new Date(l.created_at) > endedAt)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

  // Owners always get the full 7 days' notice: if a warning goes out
  // late, the deletion date moves out to 7 days after it.
  const deletionDate = warning
    ? new Date(Math.max(policyDate.getTime(), addDays(new Date(warning.created_at), WARNING_DAYS).getTime()))
    : policyDate;

  const base = { state, endedOn: isoDate(endedAt), deletionDate: isoDate(deletionDate), warnedOn: warning ? isoDate(new Date(warning.created_at)) : null };
  if (now < addDays(deletionDate, -WARNING_DAYS)) return { status: 'counting', ...base };
  if (!warning) return { status: 'warn', ...base };
  if (now < deletionDate) return { status: 'warned', ...base };
  return { status: 'due', ...base };
}

// allowMissingLog: only for the command-line dry run, so it can run
// before migration 011 creates retention_log. Everything else fails
// loudly if the table is missing.
async function readLogs(accountIds, { allowMissingLog = false } = {}) {
  if (!accountIds.length) return [];
  const { data, error } = await supabase
    .from('retention_log')
    .select('account_id, product, action, deletion_date, created_at')
    .in('account_id', accountIds);
  if (error && allowMissingLog && /retention_log/.test(error.message)) return [];
  if (error) throw error;
  return data;
}

// Every account with at least one subscription row, and where each of
// its products stands. Accounts that never paid never appear.
async function assessAll(now = new Date(), opts = {}) {
  const { data: subs, error } = await supabase.from('account_subscriptions').select('*');
  if (error) throw error;
  const accountIds = [...new Set(subs.map(s => s.account_id))];
  if (!accountIds.length) return [];

  const { data: accounts, error: aErr } = await supabase
    .from('accounts')
    .select('id, name, comp_care360, comp_element_profile')
    .in('id', accountIds);
  if (aErr) throw aErr;
  const logs = await readLogs(accountIds, opts);

  return accounts.map(account => {
    const accountSubs = subs.filter(s => s.account_id === account.id);
    const accountLogs = logs.filter(l => l.account_id === account.id);
    const products = {};
    for (const product of PRODUCTS) products[product] = productStatus(account, accountSubs, accountLogs, product, now);
    return { accountId: account.id, accountName: account.name, products };
  });
}

async function assessAccount(accountId, now = new Date(), opts = {}) {
  const all = await assessAll(now, opts);
  return all.find(a => a.accountId === accountId) || null;
}

// ── Counting (the dry run) ───────────────────────────────────

async function careIds(accountId) {
  const ids = { accountIds: [accountId], cycleIds: [], leaderIds: [] };
  const { data: cycles, error } = await supabase.from('cycles').select('id').eq('account_id', accountId);
  if (error) throw error;
  ids.cycleIds = cycles.map(c => c.id);
  const filters = [`account_id.eq.${accountId}`];
  if (ids.cycleIds.length) filters.push(`cycle_id.in.(${ids.cycleIds.join(',')})`);
  const { data: leaders, error: lErr } = await supabase.from('leaders').select('id').or(filters.join(','));
  if (lErr) throw lErr;
  ids.leaderIds = leaders.map(l => l.id);
  return ids;
}

// The tables for one product, each with the id lists to match on.
async function productTables(accountId, product) {
  return product === 'care360'
    ? { tables: CARE_TABLES, ids: await careIds(accountId) }
    : { tables: ELEMENT_TABLES, ids: await elementIds(accountId) };
}

async function elementIds(accountId) {
  const ids = { accountIds: [accountId], orgIds: [], personIds: [], sessionIds: [], teamIds: [], roleIds: [] };
  const { data: orgs } = await supabase.from('organizations').select('id').eq('account_id', accountId);
  ids.orgIds = (orgs || []).map(o => o.id);
  if (!ids.orgIds.length) return ids;
  const pick = async (table, key) => {
    const { data, error } = await supabase.from(table).select('id').in('organization_id', ids.orgIds);
    if (error) throw error;
    ids[key] = data.map(r => r.id);
  };
  await Promise.all([pick('people', 'personIds'), pick('element_sessions', 'sessionIds'), pick('element_teams', 'teamIds'), pick('element_roles', 'roleIds')]);
  return ids;
}

// A query builder matching rows on any of the listed columns, or null
// when none of the id lists has anything in it.
function matching(query, filters, ids) {
  const parts = filters.filter(([, key]) => ids[key].length).map(([col, key]) => `${col}.in.(${ids[key].join(',')})`);
  return parts.length ? query.or(parts.join(',')) : null;
}

async function countProduct(accountId, product) {
  const counts = {};
  const { tables, ids } = await productTables(accountId, product);
  for (const [table, filters] of tables) {
    const q = matching(supabase.from(table).select('*', { count: 'exact', head: true }), filters, ids);
    if (!q) { counts[table] = 0; continue; }
    const { count, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    counts[table] = count;
  }
  return counts;
}

async function countAccount(accountId) {
  const counts = {};
  for (const table of ACCOUNT_TABLES) {
    const col = table === 'accounts' ? 'id' : 'account_id';
    const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true }).eq(col, accountId);
    if (error) throw new Error(`${table}: ${error.message}`);
    counts[table] = count;
  }
  counts.logins = counts.account_users;
  return counts;
}

// Whether, once `product` is deleted, nothing on the account would be
// left that the policy still protects: no other product active, past
// due, pending, comped, inside its 60 days, or (never purchased but)
// holding data from use outside a subscription, such as a CARE 360 trial.
async function accountCanBeDeleted(accountId, product, assessment) {
  for (const other of PRODUCTS) {
    if (other === product) continue;
    const s = assessment.products[other];
    if (s.status === 'deleted') continue;
    if (s.status === 'none') {
      const counts = await countProduct(accountId, other);
      if (Object.values(counts).some(n => n > 0)) return false;
      continue;
    }
    if (s.status === 'due') continue;   // its own approval deletes it; until then the account stays
    return false;
  }
  // Every other product is deleted or never held data. A "due" sibling
  // still holds data, so the account waits for that approval too.
  return PRODUCTS.filter(p => p !== product).every(p => ['deleted', 'none'].includes(assessment.products[p].status));
}

// Exactly what approving this product's deletion would remove right
// now, without removing anything.
async function dryRun(accountId, product, now = new Date(), opts = {}) {
  const assessment = await assessAccount(accountId, now, opts);
  if (!assessment) return null;
  const counts = await countProduct(accountId, product);
  const deletesAccount = await accountCanBeDeleted(accountId, product, assessment);
  return {
    accountId,
    accountName: assessment.accountName,
    product,
    ...assessment.products[product],
    counts,
    deletesAccount,
    accountCounts: deletesAccount ? await countAccount(accountId) : null
  };
}

// ── Deleting (only after approval) ───────────────────────────

async function deleteMatching(table, build) {
  const q = build(supabase.from(table).delete());
  if (!q) return 0;
  const { data, error } = await q.select();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data.length;
}

async function deleteProductRows(accountId, product) {
  const counts = {};
  const { tables, ids } = await productTables(accountId, product);
  for (const [table, filters] of tables) counts[table] = await deleteMatching(table, q => matching(q, filters, ids));
  return counts;
}

async function deleteAccountRows(accountId) {
  const counts = { logins: 0 };
  const { data: users, error } = await supabase.from('account_users').select('auth_user_id').eq('account_id', accountId);
  if (error) throw error;
  for (const u of users) {
    const { error: authErr } = await supabase.auth.admin.deleteUser(u.auth_user_id);
    if (authErr && !/not found/i.test(authErr.message)) throw new Error(`login: ${authErr.message}`);
    counts.logins++;
  }
  for (const table of ACCOUNT_TABLES) {
    const col = table === 'accounts' ? 'id' : 'account_id';
    counts[table] = await deleteMatching(table, q => q.eq(col, accountId));
  }
  return counts;
}

// An unpaid subscription is still open in Stripe. It's canceled first,
// so nothing is ever charged for data that's gone. Customers and
// invoices stay in Stripe.
async function cancelUnpaidInStripe(accountId, product) {
  const { data: subs, error } = await supabase
    .from('account_subscriptions')
    .select('stripe_subscription_id, products, status')
    .eq('account_id', accountId)
    .eq('status', 'unpaid');
  if (error) throw error;
  const canceled = [];
  for (const s of subs.filter(s => covers(s, product))) {
    const live = await stripe.subscriptions.retrieve(s.stripe_subscription_id);
    if (live.status !== 'canceled') await stripe.subscriptions.cancel(s.stripe_subscription_id);
    canceled.push(s.stripe_subscription_id);
  }
  return canceled;
}

async function log(entry) {
  const { error } = await supabase.from('retention_log').insert(entry);
  if (error) throw error;
}

// Runs only from the owner's approval in HQ. Re-checks eligibility at
// that moment, so an account that resubscribed after the list was sent
// is never touched. Logs ids, the product, the date and row counts only.
async function executeDeletion(accountId, product, now = new Date()) {
  const assessment = await assessAccount(accountId, now);
  if (!assessment) throw new Error('Account not found or has no subscriptions.');
  const status = assessment.products[product];
  if (!status || status.status !== 'due') {
    throw new Error(`Not eligible for deletion right now (status: ${status ? status.status : 'unknown'}).`);
  }

  const deletesAccount = await accountCanBeDeleted(accountId, product, assessment);
  const canceledInStripe = status.state === 'unpaid' ? await cancelUnpaidInStripe(accountId, product) : [];

  const counts = await deleteProductRows(accountId, product);
  await log({
    account_id: accountId, product, action: 'deleted', deletion_date: isoDate(now),
    row_counts: { ...counts, stripe_subscriptions_canceled: canceledInStripe.length }
  });

  let accountCounts = null;
  if (deletesAccount) {
    accountCounts = await deleteAccountRows(accountId);
    await log({ account_id: accountId, product: 'account', action: 'deleted', deletion_date: isoDate(now), row_counts: accountCounts });
  }
  return { product, counts, canceledInStripe, deletesAccount, accountCounts };
}

// ── The daily job: warn owners, report to IGC, delete nothing ──

async function emailedWithin(now, days) {
  const since = addDays(now, -days).toISOString();
  const { data, error } = await supabase
    .from('retention_log').select('row_counts').eq('action', 'scan').gte('created_at', since);
  if (error) throw error;
  return data.some(r => r.row_counts && r.row_counts.emailed);
}

// When the daily job last ran, for HQ: a stale time means it stopped.
async function lastScan() {
  const { data, error } = await supabase
    .from('retention_log').select('created_at, row_counts').eq('action', 'scan')
    .order('created_at', { ascending: false }).limit(1);
  if (error) throw error;
  return data[0] || null;
}

async function ownerEmails(accountId) {
  const { data } = await supabase.from('account_users').select('email, role').eq('account_id', accountId);
  const owners = (data || []).filter(u => u.role === 'owner').map(u => u.email);
  return owners.length ? owners : (data || []).map(u => u.email);
}

// Once per calendar day, however often it's called or the server
// restarts. sendWarning/sendSummary are the email functions (passed in
// so they can be replaced in tests).
// force: run even if today's run already happened (manual runs and tests).
async function runDailyRetention({ sendWarning, sendSummary, sendAllClear, now = new Date(), force = false }) {
  const today = isoDate(now);
  const { data: ran, error } = await supabase
    .from('retention_log').select('id').eq('action', 'scan').eq('deletion_date', today).limit(1);
  if (error) throw error;
  if (ran.length && !force) return { skipped: true };

  const assessed = await assessAll(now);
  const warned = [], due = [], upcoming = [], noOwnerEmail = [];

  for (const a of assessed) {
    for (const product of PRODUCTS) {
      const s = a.products[product];
      if (s.status === 'warn') {
        // The deletion date the owner is told: 7 full days from today
        // at the earliest.
        const deletionDate = isoDate(new Date(Math.max(new Date(s.deletionDate).getTime(), addDays(now, WARNING_DAYS).getTime())));
        const to = await ownerEmails(a.accountId);
        const item = { accountId: a.accountId, accountName: a.accountName, product, deletionDate };
        if (to.length) {
          await sendWarning({ to, accountName: a.accountName, product, productLabel: PRODUCT_LABELS[product], deletionDate, unpaid: s.state === 'unpaid' });
          warned.push(item);
        } else {
          // No one to email. The 7-day notice period still starts, so the
          // product can still be deleted on time; IGC sees it flagged.
          noOwnerEmail.push(item);
        }
        // The count of people emailed, never their addresses.
        await log({ account_id: a.accountId, product, action: 'warning_sent', deletion_date: deletionDate, row_counts: { recipients: to.length } });
      } else if (s.status === 'due') {
        due.push({ accountId: a.accountId, accountName: a.accountName, product, deletionDate: s.deletionDate });
      } else if (s.status === 'warned') {
        upcoming.push({ accountId: a.accountId, accountName: a.accountName, product, deletionDate: s.deletionDate });
      }
    }
  }

  // IGC hears about anything to act on every day. When there's nothing,
  // a short "all clear" goes out once a week, so a silent inbox never
  // hides a job that has stopped running.
  let emailed = null;
  if (due.length || upcoming.length || warned.length || noOwnerEmail.length) {
    await sendSummary({ due, upcoming, warned, noOwnerEmail });
    emailed = 'summary';
  } else if (!(await emailedWithin(now, 7))) {
    await sendAllClear({ accountsChecked: assessed.length });
    emailed = 'all_clear';
  }

  await log({ account_id: null, product: null, action: 'scan', deletion_date: today, row_counts: { due: due.length, upcoming: upcoming.length, warned_today: warned.length, emailed } });
  return { due, upcoming, warned, noOwnerEmail, emailed };
}

module.exports = {
  RETENTION_DAYS, WARNING_DAYS, PRODUCTS, PRODUCT_LABELS, CARE_TABLES, ELEMENT_TABLES, ACCOUNT_TABLES,
  assessAll, assessAccount, dryRun, executeDeletion, runDailyRetention, productStatus, lastScan, productTables, matching
};
