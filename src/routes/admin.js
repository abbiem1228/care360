const express  = require('express');
const router   = express.Router();
const supabase = require('../db/client');
const { nanoid } = require('nanoid');
const { sendRaterInvite, sendTeammateInvite } = require('../email');
const { generateHandoffToken } = require('../auth');

const ELEMENT_PROFILE_URL = process.env.ELEMENT_PROFILE_URL || 'https://element.ingoodcocollective.com';

// Every query below runs on the signed in user's own connection, so the
// database refuses to return another account's rows. The shared service
// client is only a fallback for the legacy password login.
function db(req) { return req.userDb || supabase; }

function requireAuth(req, res, next) {
  if (req.isAdmin) return next();
  res.redirect('/signin');
}

// ── Legacy password login (kept as a fallback) ────────────────
router.get('/login', (req, res) => res.send(loginPage(req.query.error)));

router.post('/login', (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD) {
    res.cookie('adminAuth', 'yes', {
      signed: true, httpOnly: true, sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 8 * 60 * 60 * 1000
    });
    return res.redirect('/admin');
  }
  res.redirect('/admin/login?error=1');
});

router.get('/logout', (req, res) => { res.clearCookie('adminAuth'); res.redirect('/signin'); });

// ── Dashboard ──────────────────────────────────────────────────
// NOTE: this file uses "Group" in every user-facing label. The database
// table underneath is still called "cycles" on purpose, that name never
// needs to change since nobody but us ever sees it.
router.get('/', requireAuth, async (req, res) => {
  const { data: cycles } = await db(req).from('cycles').select('*').order('created_at', { ascending: false });
  res.send(dashboardPage(cycles || [], req));
});

// ── Team ──────────────────────────────────────────────────────
// Real teammate invites: a second real login on the same account,
// distinct from the legacy shared password and from rater invites
// (which invite someone to give feedback, not to join the account).
router.get('/team', requireAuth, async (req, res) => {
  const { data: teammates } = await db(req).from('account_users').select('*').order('created_at', { ascending: true });
  const { data: invites }   = await db(req).from('account_invites').select('*').is('accepted_at', null).order('created_at', { ascending: false });
  res.send(teamPage(teammates || [], invites || [], req));
});

router.post('/team/invites', requireAuth, async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const name  = (req.body.name || '').trim();

  if (!email) return res.redirect('/admin/team');

  const inviteRow = {
    account_id: req.accountId,
    email,
    name: name || null,
    token: nanoid(24),
    invited_by: req.session ? req.session.user.id : null,
  };

  const { error } = await db(req).from('account_invites').insert([inviteRow]);
  if (error) {
    console.error('INVITE CREATE FAILED', error.message);
    return res.redirect('/admin/team');
  }

  try {
    const inviterName = (req.session && req.session.name) || 'A teammate';
    await sendTeammateInvite(inviteRow, inviterName, req.account ? req.account.name : 'CARE 360');
  } catch (e) {
    console.error('Teammate invite email failed:', e.message);
  }

  res.redirect('/admin/team');
});

// ── Cross-app handoff to Element Profile ────────────────────────
// Only reachable when the account genuinely has both products, same
// entitlement check as the "Upgrade to the Bundle" reminder. Mints a
// short-lived, single-use Supabase magic-link token for this exact
// person's real email and hands it to Element Profile, which redeems
// it for a real session there, no second password.
router.get('/handoff/element-profile', requireAuth, async (req, res) => {
  // Only Element Profile itself needs to be on: this is also how a
  // CARE 360 account whose CARE subscription lapsed reaches Element.
  if (!req.account || !req.account.has_element_profile) {
    return res.redirect('/admin');
  }

  const { token, error } = await generateHandoffToken(req.session.email);
  if (error) {
    console.error('Element Profile handoff failed:', error);
    return res.status(500).send('Could not open Element Profile right now. <a href="/admin">Back to dashboard</a>');
  }

  res.redirect(`${ELEMENT_PROFILE_URL}/handoff?token=${encodeURIComponent(token)}`);
});

// ── Groups ────────────────────────────────────────────────────
router.get('/cycles/new', requireAuth, (req, res) => res.send(cycleFormPage(req)));

router.post('/cycles', requireAuth, async (req, res) => {
  const { name, description, client_name, opens_at, closes_at } = req.body;
  if (!closes_at) return res.send(adminShell('Error', '<div class="card"><p>A close date is required. <a href="/admin/cycles/new">Go back</a></p></div>', req));
  if (new Date(closes_at) <= new Date()) return res.send(adminShell('Error', '<div class="card"><p>The close date must be in the future. <a href="/admin/cycles/new">Go back</a></p></div>', req));

  const row = { name, description, client_name, opens_at: opens_at || null, closes_at };
  if (req.accountId) row.account_id = req.accountId;

  const { error } = await db(req).from('cycles').insert([row]);
  if (error) {
    console.error('GROUP CREATE FAILED', error.message);
    return res.send(adminShell('Error', `<div class="card"><p>The Group could not be created. <a href="/admin/cycles/new">Go back</a></p></div>`, req));
  }
  res.redirect('/admin');
});

router.post('/cycles/:id/status', requireAuth, async (req, res) => {
  if (req.body.status === 'draft') {
    const { data: leaders } = await db(req).from('leaders').select('raters(email_sent_at)').eq('cycle_id', req.params.id);
    const anyInviteSent = (leaders || []).some(l => (l.raters || []).some(r => r.email_sent_at));
    if (anyInviteSent) {
      return res.send(adminShell('Cannot reopen to draft', `<div class="card alert-card" style="max-width:520px">
        <div style="font-size:15px;font-weight:600;color:#A94442;margin-bottom:8px">Invitations have already been sent</div>
        <div style="font-size:13px;color:var(--grey);line-height:1.7;margin-bottom:16px">At least one rater has already received a link for this Group. Reopening it to draft could let leaders, raters, or questions be edited while someone is mid-way through their survey. This Group can still be closed or re-activated, just not returned to draft.</div>
        <a href="/admin/cycles/${req.params.id}" class="btn btn-ghost">Back to Group</a>
      </div>`, req));
    }
  }
  await db(req).from('cycles').update({ status: req.body.status }).eq('id', req.params.id);
  res.redirect(`/admin/cycles/${req.params.id}`);
});

// Edits a Group's opens_at/closes_at after creation, on a Group in any
// status. checkClosedCycles and sendReminders (server.js) both read
// these columns live off the cycles row on every run, no caching
// anywhere, so a saved change here takes effect on the very next
// hourly pass, and the survey link (survey.js) re-reads them on every
// single rater visit. The one state this route has to actively manage
// itself: closed_notified_at. That column is the automatic system's
// own record that it already emailed an admin notice for this Group's
// closure, and checkClosedCycles will never fire again for a cycle
// once it's set, regardless of status or dates. If extending closes_at
// into the future on an already-closed, already-notified Group is
// confirmed below, this route clears closed_notified_at along with
// reactivating status, specifically so the automatic system is
// genuinely re-armed, not just cosmetically reopened on screen.
router.post('/cycles/:id/dates', requireAuth, async (req, res) => {
  const { data: cycle } = await db(req).from('cycles').select('*').eq('id', req.params.id).maybeSingle();
  if (!cycle) return res.redirect('/admin');

  const { opens_at, closes_at, confirm } = req.body;
  if (!closes_at) {
    return res.send(adminShell('Error', `<div class="card"><p>A close date is required. <a href="/admin/cycles/${cycle.id}">Go back</a></p></div>`, req));
  }
  if (opens_at && new Date(closes_at) <= new Date(opens_at)) {
    return res.send(adminShell('Error', `<div class="card"><p>The close date must be after the open date. <a href="/admin/cycles/${cycle.id}">Go back</a></p></div>`, req));
  }

  // The one silent-undo risk worth blocking on: this Group already
  // closed for real, the automatic notice about it already went out
  // (closed_notified_at is set precisely because that happened), and
  // this save would put its close date back in the future. Saving that
  // change is exactly what "fixing dates on a Group that's already
  // live" means when the Group in question has already closed, so it's
  // allowed, just not silently — it also reactivates the Group, which
  // is a real, meaningful reversal of something raters and the account
  // owner were already told was final.
  const wouldReopenAlreadyClosedGroup = cycle.status === 'closed' && cycle.closed_notified_at && new Date(closes_at) > new Date();
  if (wouldReopenAlreadyClosedGroup && !confirm) {
    return res.send(adminShell('Confirm reopening this Group', `
      <div class="card notice-card" style="max-width:560px">
        <div style="font-size:15px;font-weight:600;color:#30383B;margin-bottom:8px">This Group already closed, and that closure was already reported</div>
        <div style="font-size:13px;color:var(--grey);line-height:1.7;margin-bottom:18px">"${cycle.name}" closed automatically, and the admin notice for any leader with unanswered raters already went out. Saving a close date in the future will also reactivate this Group so raters can respond again. If that's what you want, confirm below.</div>
        <form method="POST" action="/admin/cycles/${cycle.id}/dates">
          <input type="hidden" name="opens_at" value="${opens_at || ''}"/>
          <input type="hidden" name="closes_at" value="${closes_at}"/>
          <input type="hidden" name="confirm" value="1"/>
          <div class="actions-row">
            <button class="btn btn-sage" type="submit">Yes, save dates and reopen this Group</button>
            <a href="/admin/cycles/${cycle.id}" class="btn btn-ghost">Cancel</a>
          </div>
        </form>
      </div>`, req));
  }

  const update = { opens_at: opens_at || null, closes_at };
  if (wouldReopenAlreadyClosedGroup && confirm) {
    update.status = 'active';
    update.closed_notified_at = null;
  }

  const { error } = await db(req).from('cycles').update(update).eq('id', cycle.id);
  if (error) {
    console.error('GROUP DATES UPDATE FAILED', error.message);
    return res.send(adminShell('Error', `<div class="card"><p>The dates could not be updated. <a href="/admin/cycles/${cycle.id}">Go back</a></p></div>`, req));
  }

  res.redirect(`/admin/cycles/${cycle.id}?datesUpdated=1`);
});

router.get('/cycles/:id', requireAuth, async (req, res) => {
  const { data: cycle } = await db(req).from('cycles').select('*').eq('id', req.params.id).maybeSingle();
  if (!cycle) return res.redirect('/admin');
  const { data: leaders } = await db(req).from('leaders')
    .select('*, raters(id, rater_group, completed_at, email_sent_at)')
    .eq('cycle_id', req.params.id).order('name');
  res.send(cycleDetailPage(cycle, leaders || [], req));
});

// ── Leaders ───────────────────────────────────────────────────
router.get('/cycles/:cycleId/leaders/new', requireAuth, (req, res) => res.send(leaderFormPage(req.params.cycleId, req)));

router.post('/cycles/:cycleId/leaders', requireAuth, async (req, res) => {
  const { name, title, email, department } = req.body;

  // Confirm the Group belongs to this account before adding to it.
  const { data: cycle } = await db(req).from('cycles').select('id').eq('id', req.params.cycleId).maybeSingle();
  if (!cycle) return res.redirect('/admin');

  if (req.account && req.account.plan === 'trial') {
    const { count } = await db(req).from('leaders').select('id', { count: 'exact', head: true });
    if ((count || 0) >= 1) {
      return res.send(adminShell('Trial limit reached', `
        <div class="card notice-card" style="max-width:520px">
          <div style="font-size:16px;font-weight:600;color:#30383B;margin-bottom:8px">You've used your free trial</div>
          <div style="font-size:13px;color:var(--grey);line-height:1.75;margin-bottom:18px">Your trial covers one leader, and you've already run one. Upgrade to add more leaders, unlimited Groups, and everything else CARE 360 offers.</div>
          <a href="/plans" class="btn btn-primary">See plans</a>
        </div>`, req));
    }
  }

  const leaderRow = { cycle_id: req.params.cycleId, name, title, email, department };
  if (req.accountId) leaderRow.account_id = req.accountId;

  const { data: leader, error } = await db(req).from('leaders').insert([leaderRow]).select().single();
  if (error) {
    console.error('LEADER CREATE FAILED', error.message);
    return res.redirect(`/admin/cycles/${req.params.cycleId}`);
  }

  const selfRow = { leader_id: leader.id, name, email, rater_group: 'self', token: nanoid(24) };
  if (req.accountId) selfRow.account_id = req.accountId;
  await db(req).from('raters').insert([selfRow]);

  res.redirect(`/admin/cycles/${req.params.cycleId}`);
});

// ── Raters ────────────────────────────────────────────────────
router.get('/leaders/:leaderId/raters/new', requireAuth, async (req, res) => {
  const { data: leader } = await db(req).from('leaders').select('*').eq('id', req.params.leaderId).maybeSingle();
  if (!leader) return res.redirect('/admin');
  res.send(raterFormPage(leader, req));
});

router.post('/leaders/:leaderId/raters', requireAuth, async (req, res) => {
  const { leaderId } = req.params;
  const { data: leader } = await db(req).from('leaders').select('cycle_id').eq('id', leaderId).maybeSingle();
  if (!leader) return res.redirect('/admin');

  const names  = [].concat(req.body.name        || []);
  const emails = [].concat(req.body.email       || []);
  const groups = [].concat(req.body.rater_group || []);

  const rows = [];
  const incompleteRows = [];

  for (let i = 0; i < names.length; i++) {
    const n = (names[i]  || '').trim();
    const e = (emails[i] || '').trim();
    const g = (groups[i] || '').trim();
    const anyFilled  = n || e || g;
    const allFilled  = n && e && g;

    if (allFilled) {
      const row = { leader_id: leaderId, name: n, email: e, rater_group: g, token: nanoid(24) };
      if (req.accountId) row.account_id = req.accountId;
      rows.push(row);
    } else if (anyFilled) {
      // Some fields were touched but not all. This is the exact case that
      // used to fail silently: a name and email typed in, but the
      // relationship dropdown left on its placeholder. Block the whole
      // save rather than quietly dropping this one row, since a partial
      // save with no explanation is worse than making someone fix it.
      incompleteRows.push({ name: n, email: e, rater_group: g, rowNumber: i + 1 });
    }
    // Rows with nothing filled in at all are just unused extra rows and
    // are silently ignored, same as before.
  }

  if (incompleteRows.length) {
    const { data: leaderFull } = await db(req).from('leaders').select('*').eq('id', leaderId).maybeSingle();
    return res.send(raterFormPage(leaderFull, req,
      `Row ${incompleteRows.map(r => r.rowNumber).join(', ')} ${incompleteRows.length === 1 ? 'is' : 'are'} missing a name, email, or relationship. All three are required for each rater. Please complete or remove the highlighted row before saving.`,
      { names, emails, groups }
    ));
  }

  if (rows.length) {
    const { error } = await db(req).from('raters').insert(rows);
    if (error) console.error('RATER CREATE FAILED', error.message);
  }
  res.redirect(`/admin/cycles/${leader.cycle_id}`);
});

// ── Send invites ──────────────────────────────────────────────
router.post('/leaders/:leaderId/send-invites', requireAuth, async (req, res) => {
  const { leaderId } = req.params;
  const { data: leader } = await db(req).from('leaders').select('*, cycles(name)').eq('id', leaderId).maybeSingle();
  if (!leader) return res.redirect('/admin');

  const { data: raters } = await db(req).from('raters').select('*').eq('leader_id', leaderId).is('email_sent_at', null);

  let sent = 0, failed = 0;
  for (const rater of (raters || [])) {
    try {
      await sendRaterInvite(rater, leader);
      await db(req).from('raters').update({ email_sent_at: new Date().toISOString() }).eq('id', rater.id);
      sent++;
    } catch (e) {
      failed++;
      console.error('Email failed for', rater.email, e.message);
    }
  }
  if (failed) console.error(`INVITES: ${sent} sent, ${failed} failed for leader ${leaderId}`);

  res.redirect(`/admin/cycles/${leader.cycle_id}?sent=${sent}&failed=${failed}`);
});

// ── Generate report ───────────────────────────────────────────
router.post('/leaders/:leaderId/generate-report', requireAuth, (req, res) => {
  res.redirect(`/report/generate/${req.params.leaderId}`);
});

// ── Leader detail ─────────────────────────────────────────────
router.get('/leaders/:leaderId', requireAuth, async (req, res) => {
  const { data: leader } = await db(req).from('leaders').select('*, cycles(name,status)').eq('id', req.params.leaderId).maybeSingle();
  if (!leader) return res.redirect('/admin');
  const { data: raters } = await db(req).from('raters').select('*').eq('leader_id', req.params.leaderId).order('rater_group');
  const { data: report } = await db(req).from('reports').select('id, generated_at').eq('leader_id', req.params.leaderId).order('generated_at', { ascending: false }).limit(1).maybeSingle();
  const completed = (raters || []).filter(r => r.completed_at).length;
  res.send(leaderDetailPage(leader, raters || [], report, completed, (raters || []).length, req));
});

// ── Delete rater ──────────────────────────────────────────────
router.post('/raters/:raterId/delete', requireAuth, async (req, res) => {
  const { data: rater } = await db(req).from('raters').select('leader_id, name, completed_at').eq('id', req.params.raterId).maybeSingle();
  if (!rater) return res.redirect('/admin');
  if (rater.completed_at) {
    return res.send(adminShell('Cannot remove rater', `<div class="card alert-card">
      <div style="font-size:15px;font-weight:600;color:#A94442;margin-bottom:8px">This rater has already submitted</div>
      <div style="font-size:13px;color:var(--grey);line-height:1.7;margin-bottom:16px">${rater.name} completed their survey. Removing them would permanently delete their scores and comments, and that cannot be undone. Raters can only be removed before they respond.</div>
      <a href="/admin/leaders/${rater.leader_id}" class="btn btn-ghost">Back to leader</a>
    </div>`, req));
  }
  await db(req).from('raters').delete().eq('id', req.params.raterId);
  res.redirect(`/admin/leaders/${rater.leader_id}`);
});

// ════════════════════════════════════════════════════════════════
// HTML
// ════════════════════════════════════════════════════════════════

const CSS = `
<style>
@import url('https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;500;600&family=Noto+Sans:wght@400;500;600;700&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--ink:#30383B;--clay:#A9633D;--clay-dark:#925433;--sage:#7C8863;--sand:#D9CBB2;--cream:#F7F3EA;--paper:#F5F2ED;--warm:#EDE8DF;--white:#ffffff;--grey:#637074;--lgrey:#EAE6DE;--line:rgba(48,56,59,0.12);--line-strong:rgba(48,56,59,0.22);--shadow:none;--shadow-md:0 12px 32px rgba(48,56,59,0.12)}
body{font-family:'Noto Sans',Arial,sans-serif;background:var(--white);color:var(--ink);font-size:14px;line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:var(--ink);text-decoration:underline;text-decoration-color:var(--line-strong);text-underline-offset:3px}a:hover{color:var(--clay);text-decoration-color:currentColor}

.admin-nav{background:var(--white);height:76px;display:flex;align-items:center;padding:0 40px;gap:28px;box-shadow:0 1px 0 var(--line);position:sticky;top:0;z-index:100}
.nav-logo{display:flex;align-items:center;gap:10px}
.nav-logo-mark{width:30px;height:30px;display:block;flex-shrink:0}
.nav-brand{color:var(--ink);font-weight:500;font-size:23px;font-family:'EB Garamond',Georgia,serif;letter-spacing:-0.5px;line-height:1}
.nav-logo-switcher{position:relative;cursor:pointer}
.nav-logo-switcher summary{list-style:none}
.nav-logo-switcher summary::-webkit-details-marker{display:none}
.nav-logo-switcher summary::after{content:'';width:6px;height:6px;border-right:1.5px solid var(--ink);border-bottom:1.5px solid var(--ink);transform:rotate(45deg);margin:-4px 0 0 4px;opacity:0.6}
.nav-logo-switcher summary:focus-visible{outline:2px solid var(--clay);outline-offset:4px;border-radius:4px}
.nav-logo-dropdown{position:absolute;top:100%;left:0;margin-top:14px;background:var(--white);border-radius:16px;box-shadow:var(--shadow-md);padding:6px;min-width:220px;z-index:200}
.nav-logo-dropdown-item{display:block;padding:10px 14px;font-size:14px;font-weight:500;color:var(--ink);border-radius:10px;white-space:nowrap;text-decoration:none}
.nav-logo-dropdown-item:hover{background:var(--paper);color:var(--ink)}
.nav-link{color:var(--ink);font-size:14px;font-weight:400;text-transform:lowercase;text-decoration:none;opacity:0.78;transition:opacity 0.15s,color 0.15s}
.nav-link:hover{opacity:1;color:var(--ink);text-decoration:underline;text-decoration-color:var(--clay);text-underline-offset:6px}
.nav-link-accent{color:var(--clay);font-weight:600;opacity:1}
.nav-link-btn{background:none;border:none;font-family:inherit;padding:0;cursor:pointer}
.nav-spacer{flex:1}
.nav-user{display:flex;align-items:center;gap:14px;color:var(--grey);font-size:14px}
.nav-acct{color:var(--ink);font-size:14px;font-weight:500;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nav-plan{font-size:12px;font-weight:500;background:var(--paper);color:var(--ink);padding:3px 10px;border-radius:999px}
.nav-avatar{width:32px;height:32px;border-radius:50%;background:var(--ink);color:var(--cream);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;flex-shrink:0}

.admin-main{max-width:1120px;margin:0 auto;padding:48px 40px 96px}
.page-header{display:flex;align-items:flex-end;justify-content:space-between;flex-wrap:wrap;gap:16px;margin-bottom:32px}
.page-title{font-family:'EB Garamond',Georgia,serif;font-size:44px;font-weight:500;color:var(--ink);letter-spacing:-1.4px;line-height:1.08;margin-bottom:8px}
.page-sub{font-size:15px;color:var(--grey)}

.card{background:var(--paper);border-radius:20px;padding:28px 30px;margin-bottom:20px}
.card-header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}
.card-title{font-family:'EB Garamond',Georgia,serif;font-size:24px;font-weight:500;color:var(--ink);letter-spacing:-0.5px}

.stats-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:20px}
.stat-card{background:var(--paper);border-radius:20px;padding:24px 26px}
.stat-num{font-family:'EB Garamond',Georgia,serif;font-size:46px;font-weight:500;color:var(--ink);line-height:1;letter-spacing:-1px}
.stat-lbl{font-size:13px;font-weight:500;color:var(--grey);margin-top:8px}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:11px 20px;border-radius:999px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid transparent;transition:background 0.15s,color 0.15s,border-color 0.15s;line-height:1.1;font-family:inherit;text-decoration:none;white-space:nowrap}
.btn:hover{text-decoration:none}
.btn-primary,.btn-ink{background:var(--ink);color:var(--cream)}
.btn-primary:hover,.btn-ink:hover{background:#20282B;color:var(--cream)}
.btn-sage{background:var(--clay);color:var(--white)}
.btn-sage:hover{background:var(--clay-dark);color:var(--white)}
.btn-red{background:transparent;color:#A94442;border-color:rgba(169,68,66,0.4)}
.btn-red:hover{background:#A94442;color:var(--white);border-color:#A94442}
.btn-outline{background:transparent;color:var(--ink);border-color:var(--ink)}
.btn-outline:hover{background:var(--ink);color:var(--cream)}
.btn-ghost{background:transparent;color:var(--ink);border-color:var(--line-strong)}
.btn-ghost:hover{border-color:var(--ink);color:var(--ink)}
.btn-sm{padding:7px 14px;font-size:12px}

.data-table{width:100%;border-collapse:collapse}
.data-table th{background:transparent;color:var(--grey);padding:10px 14px;text-align:left;font-size:12px;font-weight:600;border-bottom:1px solid var(--line-strong)}
.data-table td{padding:14px;border-bottom:1px solid var(--line);font-size:14px;vertical-align:middle}
.data-table tr:last-child td{border-bottom:none}
.data-table tbody tr:hover td{background:rgba(255,255,255,0.55)}

.badge{display:inline-flex;align-items:center;gap:6px;padding:3px 11px;border-radius:999px;font-size:12px;font-weight:500;text-transform:lowercase;white-space:nowrap}
.badge::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor}
.badge-draft{background:#E9E6E0;color:var(--grey)}
.badge-active{background:#E6EADD;color:#56603F}
.badge-closed{background:#F2E1DD;color:#A94442}
.badge-complete{background:#E6EADD;color:#56603F}
.badge-pending{background:#F3E6DC;color:var(--clay-dark)}
.badge-self{background:#E3E5E5;color:var(--ink)}
.badge-supervisor{background:#F2E1DD;color:#A94442}
.badge-peer{background:#E6EADD;color:#56603F}
.badge-direct_report{background:#F3E6DC;color:var(--clay-dark)}
.badge-skip_level{background:#E9E6E0;color:var(--grey)}

.progress-wrap{display:flex;align-items:center;gap:10px}
.progress-bar{height:6px;background:rgba(48,56,59,0.1);border-radius:999px;overflow:hidden;width:80px;flex-shrink:0}
.progress-fill{height:100%;background:var(--clay);border-radius:999px;transition:width 0.3s}
.progress-label{font-size:12px;color:var(--grey);white-space:nowrap}

.form-section{margin-bottom:28px}
.form-section-title{font-family:'EB Garamond',Georgia,serif;font-size:22px;font-weight:500;color:var(--ink);letter-spacing:-0.4px;margin-bottom:16px}
.form-group{margin-bottom:18px}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.form-label{display:block;font-size:13px;font-weight:600;color:var(--ink);margin-bottom:6px}
.form-control{width:100%;padding:11px 14px;border:1px solid var(--line-strong);border-radius:12px;font-size:14px;font-family:inherit;color:var(--ink);background:var(--white);transition:border-color 0.15s,box-shadow 0.15s}
.form-control::placeholder{color:#9AA2A4}
.form-control:focus{outline:none;border-color:var(--ink);box-shadow:0 0 0 3px rgba(48,56,59,0.08)}
select.form-control{cursor:pointer}
.form-hint{font-size:12px;color:var(--grey);margin-top:6px;line-height:1.55}

.rater-rows{display:flex;flex-direction:column;gap:10px}
.rater-row{display:grid;grid-template-columns:1fr 1fr 180px 40px;gap:10px;align-items:center;background:var(--white);border-radius:16px;padding:12px 14px;border:1px solid var(--line)}
.rater-row-incomplete{border-color:#A94442;background:#FDF5F3}
.rater-row-header{display:grid;grid-template-columns:1fr 1fr 180px 40px;gap:10px;padding:0 14px 6px}
.rater-row-header span{font-size:12px;font-weight:600;color:var(--grey)}
.remove-rater-btn{width:34px;height:34px;border-radius:50%;border:1px solid var(--line-strong);background:transparent;color:var(--grey);cursor:pointer;font-size:17px;display:flex;align-items:center;justify-content:center;transition:all 0.15s;font-family:inherit}
.remove-rater-btn:hover{background:#A94442;border-color:#A94442;color:var(--white)}
.add-rater-btn{display:inline-flex;align-items:center;gap:8px;padding:10px 18px;border:1px dashed var(--ink);border-radius:999px;color:var(--ink);background:transparent;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit;margin-top:12px;transition:all 0.15s}
.add-rater-btn:hover{background:var(--white)}

.actions-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.empty-state{text-align:center;padding:48px 24px;color:var(--grey)}
.empty-state-icon{font-size:36px;margin-bottom:12px;opacity:0.4}
.empty-state-text{font-size:15px;margin-bottom:18px}

.flash{border-radius:14px;padding:14px 18px;margin-bottom:20px;font-size:14px;line-height:1.6}
.flash-ok{background:#E6EADD;color:#3F4A2E}
.flash-warn{background:#F6E7E3;color:#A94442}
.alert-card{background:#F6E7E3}
.notice-card{background:#F3E6DC}

@media(max-width:900px){.admin-nav{height:auto;flex-wrap:wrap;padding:14px 20px;gap:10px 20px}.nav-spacer{display:none}.nav-user{width:100%;flex-wrap:wrap;gap:8px 14px}}
@media(max-width:700px){.admin-main{padding:28px 16px 64px}.page-title{font-size:34px}.form-row{grid-template-columns:1fr}.rater-row{grid-template-columns:1fr}.rater-row-header{display:none}.card{padding:22px 18px;overflow-x:auto}.data-table{font-size:13px}.data-table td,.data-table th{padding:10px}.nav-acct{display:none}}
</style>`;

// Shown at the top of every adminShell page while CARE 360 is past due,
// or while a CARE 360 payment awaits card verification (both set per
// request by src/routes/access-gate.js).
function billingBanner(message, req) {
  return `<div style="background:#F3E6DC;border-radius:14px;padding:14px 18px;margin-bottom:20px;font-size:14px;color:#30383B;display:flex;gap:14px;align-items:center;flex-wrap:wrap">
    <span style="flex:1;min-width:220px">${message}</span>
    ${req.account && req.account.stripe_customer_id ? '<a href="/billing/portal" style="font-weight:700;color:#A9633D">Manage billing</a>' : ''}
  </div>`;
}

function billingBanners(req) {
  if (!req) return '';
  return (req.care360Access === 'past_due' ? billingBanner('Your last payment didn\'t go through. Update your billing to keep making changes.', req) : '')
       + (req.care360Pending ? billingBanner('Your payment is pending verification.', req) : '');
}

function adminShell(title, content, req) {
  const acct    = req && req.account ? req.account : null;
  const acctName = acct ? acct.name : '';
  const plan     = acct ? acct.plan : '';
  const initial  = acctName ? acctName.trim().charAt(0).toUpperCase() : 'A';

  // Entitlement-aware reminder: only when the account genuinely has
  // exactly one of the two products, read straight from its real,
  // current has_care360/has_element_profile flags. No dismissal state
  // to track, it just stops rendering the moment both are true.
  const missingElementProfile = !!(acct && acct.has_care360 && !acct.has_element_profile);
  const missingCare360        = !!(acct && acct.has_element_profile && !acct.has_care360);
  const bundleReminder = missingElementProfile
    ? 'Upgrade to the Bundle and get Element Profile too'
    : missingCare360
      ? 'Upgrade to the Bundle and get CARE 360 too'
      : null;

  // Same entitlement check as the reminder above, just the other
  // direction: once an account genuinely has both products, the
  // top-left logo itself becomes the environment switcher. A
  // single-product account gets no dropdown at all, not a disabled
  // one, the exact same plain, non-interactive logo as always.
  const hasBothProducts = !!(acct && acct.has_care360 && acct.has_element_profile);

  const navLogo = hasBothProducts
    ? `<details class="nav-logo nav-logo-switcher">
      <summary class="nav-logo-summary" style="display:flex;align-items:center;gap:10px">
        <img class="nav-logo-mark" src="/img/care-mark.svg" alt=""/>
        <span class="nav-brand">care 360</span>
      </summary>
      <div class="nav-logo-dropdown">
        <a href="/admin/handoff/element-profile" class="nav-logo-dropdown-item">Switch to Element Profile</a>
      </div>
    </details>`
    : `<div class="nav-logo">
      <img class="nav-logo-mark" src="/img/care-mark.svg" alt=""/>
      <span class="nav-brand">care 360</span>
    </div>`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title} — CARE 360</title><link rel="icon" type="image/svg+xml" href="/img/care-mark.svg"/>${CSS}</head><body>
  <nav class="admin-nav">
    ${navLogo}
    <a href="/admin" class="nav-link">Groups</a>
    <a href="/admin/team" class="nav-link">Team</a>
    <a href="/guide" class="nav-link">How it works</a>
    <div class="nav-spacer"></div>
    <div class="nav-user">
      <div class="nav-avatar">${initial}</div>
      ${acctName ? `<span class="nav-acct">${acctName}</span>` : ''}
      ${plan ? `<span class="nav-plan">${plan}</span>` : ''}
      ${acct && acct.plan === 'trial' ? `<a href="/plans" class="nav-link nav-link-accent">Upgrade</a>` : ''}
      ${bundleReminder ? `<a href="/billing/upgrade-to-bundle" class="nav-link nav-link-accent">${bundleReminder}</a>` : ''}
      ${acct && acct.stripe_customer_id ? '<a href="/billing/portal" class="nav-link">Manage billing</a>' : ''}
      <a href="/signout" class="nav-link">Sign out</a>
    </div>
  </nav>
  <div class="admin-main">${billingBanners(req)}${content}</div></body></html>`;
}

function loginPage(error) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Sign In — CARE 360</title><link rel="icon" type="image/svg+xml" href="/img/care-mark.svg"/>${CSS}
  <style>
  body{display:flex;align-items:center;justify-content:center;min-height:100vh;background:var(--white)}
  .login-wrap{width:100%;max-width:440px;padding:20px}
  .login-card{background:var(--paper);border-radius:24px;padding:44px 44px 40px}
  .login-logo{display:flex;flex-direction:column;align-items:flex-start;gap:10px;margin-bottom:36px}
  .login-logo-mark{height:20px;width:auto;display:block}
  .login-logo-sub{font-size:13px;color:var(--grey)}
  .login-title{font-family:'EB Garamond',Georgia,serif;font-size:34px;color:var(--ink);margin-bottom:8px;font-weight:500;letter-spacing:-1px;line-height:1.1}
  .login-sub{font-size:14px;color:var(--grey);margin-bottom:28px;line-height:1.6}
  .login-btn{width:100%;padding:14px;background:var(--ink);color:var(--cream);border:none;border-radius:999px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;transition:background 0.15s}
  .login-btn:hover{background:#20282B}
  .login-footer{text-align:center;margin-top:28px;font-size:12px;color:var(--grey)}
  .alert-error{background:#F6E7E3;color:#A94442;border-radius:12px;padding:12px 14px;font-size:13px;margin-bottom:20px}
  </style></head>
  <body><div class="login-wrap"><div class="login-card">
    <div class="login-logo">
      <img class="login-logo-mark" src="/img/igc-wordmark.svg" alt="in good company."/>
      <div class="login-logo-sub">care 360 leadership survey</div>
    </div>
    <div class="login-title">Recovery sign in</div>
    <div class="login-sub">This is the legacy shared password. Most people should <a href="/signin">sign in with their email</a> instead.</div>
    ${error ? '<div class="alert-error">Incorrect password. Please try again.</div>' : ''}
    <form method="POST" action="/admin/login">
      <div class="form-group">
        <label class="form-label">Admin Password</label>
        <input class="form-control" type="password" name="password" autofocus required placeholder="Enter your password" style="font-size:15px;padding:12px 14px"/>
      </div>
      <button class="login-btn" type="submit">Sign In</button>
    </form>
    <div class="login-footer">Thoughtful &nbsp;·&nbsp; Innovative &nbsp;·&nbsp; Human</div>
  </div></div></body></html>`;
}

function dashboardPage(cycles, req) {
  const active = cycles.filter(c => c.status === 'active').length;
  const draft  = cycles.filter(c => c.status === 'draft').length;
  const rows   = cycles.map(c => `
    <tr>
      <td><a href="/admin/cycles/${c.id}" style="font-weight:600">${c.name}</a></td>
      <td style="color:var(--grey)">${c.client_name || c.description || '<span style="color:#ccc">&mdash;</span>'}</td>
      <td><span class="badge badge-${c.status}">${c.status}</span></td>
      <td>${c.opens_at ? new Date(c.opens_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '<span style="color:#ccc">&mdash;</span>'}</td>
      <td>${c.closes_at ? new Date(c.closes_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '<span style="color:#ccc">&mdash;</span>'}</td>
      <td><a href="/admin/cycles/${c.id}" class="btn btn-outline btn-sm">Open</a></td>
    </tr>`).join('');

  return adminShell('Dashboard', `
    <div class="page-header">
      <div>
        <div class="page-title">Groups</div>
        <div class="page-sub">Manage your CARE 360 Groups, leaders, and raters.</div>
      </div>
      <a href="/admin/cycles/new" class="btn btn-primary">+ New Group</a>
    </div>
    <div class="stats-row">
      <div class="stat-card"><div class="stat-num">${cycles.length}</div><div class="stat-lbl">Total Groups</div></div>
      <div class="stat-card" style="border-color:var(--sage)"><div class="stat-num" style="color:var(--sage)">${active}</div><div class="stat-lbl">Active</div></div>
      <div class="stat-card" style="border-color:var(--sand)"><div class="stat-num" style="color:var(--grey)">${draft}</div><div class="stat-lbl">Drafts</div></div>
    </div>
    <div class="card">
      <div class="card-header">
        <span class="card-title">All Groups</span>
        <a href="/admin/cycles/new" class="btn btn-ghost btn-sm">+ New</a>
      </div>
      ${cycles.length ? `
      <table class="data-table">
        <thead><tr><th>Group Name</th><th>Client / Notes</th><th>Status</th><th>Opens</th><th>Closes</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : `
      <div class="empty-state">
        <div class="empty-state-icon">&#128203;</div>
        <div class="empty-state-text">No Groups yet. Create your first one to get started.</div>
        <a href="/admin/cycles/new" class="btn btn-primary">Create Group</a>
      </div>`}
    </div>`, req);
}

function teamPage(teammates, invites, req) {
  const teammateRows = teammates.map(t => `
    <tr>
      <td style="font-weight:600">${t.name || '<span style="color:#ccc">&mdash;</span>'}</td>
      <td style="color:var(--grey)">${t.email}</td>
      <td><span class="badge badge-active">${t.role}</span></td>
      <td>${new Date(t.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</td>
    </tr>`).join('');

  const inviteRows = invites.map(i => `
    <tr>
      <td style="font-weight:600">${i.name || '<span style="color:#ccc">&mdash;</span>'}</td>
      <td style="color:var(--grey)">${i.email}</td>
      <td><span class="badge badge-draft">Pending</span></td>
      <td>${new Date(i.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</td>
    </tr>`).join('');

  return adminShell('Team', `
    <div class="page-header">
      <div>
        <div class="page-title">Team</div>
        <div class="page-sub">Invite a teammate to sign in and manage this same account with you.</div>
      </div>
    </div>
    <div class="card" style="margin-bottom:20px">
      <div class="card-header"><span class="card-title">Invite a teammate</span></div>
      <form method="POST" action="/admin/team/invites" class="form-row" style="display:grid;grid-template-columns:1fr 1fr auto;gap:12px;align-items:end">
        <div class="form-group" style="margin:0">
          <label class="form-label">Name</label>
          <input class="form-control" name="name" placeholder="Jane Smith"/>
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">Email *</label>
          <input class="form-control" type="email" name="email" required placeholder="jane@acme.com"/>
        </div>
        <button class="btn btn-primary" type="submit">Send invite</button>
      </form>
    </div>
    <div class="card" style="margin-bottom:20px">
      <div class="card-header"><span class="card-title">Current team</span></div>
      <table class="data-table">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Joined</th></tr></thead>
        <tbody>${teammateRows}</tbody>
      </table>
    </div>
    ${invites.length ? `
    <div class="card">
      <div class="card-header"><span class="card-title">Pending invites</span></div>
      <table class="data-table">
        <thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Sent</th></tr></thead>
        <tbody>${inviteRows}</tbody>
      </table>
    </div>` : ''}`, req);
}

function cycleFormPage(req) {
  return adminShell('New Group', `
    <div class="page-header">
      <div><div class="page-title">New Group</div>
      <div class="page-sub">A Group holds the leaders being assessed together, with one close date for everyone in it.</div></div>
    </div>
    <div class="card" style="max-width:580px">
      <form method="POST" action="/admin/cycles">
        <div class="form-group">
          <label class="form-label">Group Name *</label>
          <input class="form-control" name="name" required placeholder="e.g. 2027 Q1 Leadership Review"/>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Client / Organization</label>
            <input class="form-control" name="client_name" placeholder="e.g. Acme Corp"/>
          </div>
          <div class="form-group">
            <label class="form-label">Notes</label>
            <input class="form-control" name="description" placeholder="Optional"/>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Opens At</label>
            <input class="form-control" type="datetime-local" name="opens_at"/>
            <div class="form-hint">Leave blank to activate manually.</div>
          </div>
          <div class="form-group">
            <label class="form-label">Closes At *</label>
            <input class="form-control" type="datetime-local" name="closes_at" required/>
            <div class="form-hint">Raters cannot submit after this date. Two weeks is a good default.</div>
          </div>
        </div>
        <div class="actions-row">
          <button class="btn btn-primary" type="submit">Create Group</button>
          <a href="/admin" class="btn btn-ghost">Cancel</a>
        </div>
      </form>
    </div>`, req);
}

// Formats a stored timestamptz back into the plain "YYYY-MM-DDTHH:mm"
// string a datetime-local input expects. Both the create and edit
// forms hand that same unqualified string straight to Postgres with no
// timezone conversion on either side (the create route below does the
// same), so this has to mirror that exactly: read it back as a bare
// UTC slice, not converted through any local timezone, or resaving an
// untouched date here would silently shift it.
function toLocalInputValue(iso) {
  if (!iso) return '';
  return new Date(iso).toISOString().slice(0, 16);
}

function cycleDetailPage(cycle, leaders, req) {
  // Once at least one invite has actually been sent, we cannot know
  // whether someone out there is holding a live link. Reopening the
  // Group to draft at that point stops being a safety valve and
  // becomes a way to silently edit leaders, raters, or questions out
  // from under a survey someone may be mid-way through. So the
  // "Back to Draft" transition disappears entirely from that point on,
  // for the life of the Group. Close and Re-open stay available, since
  // neither of those retroactively unlocks anything already answered.
  const anyInviteSent = leaders.some(l => (l.raters || []).some(r => r.email_sent_at));

  const statusBtns = ({
    draft:  [['active','Activate'],['closed','Close']],
    active: [['closed','Close'],['draft','Back to Draft']],
    closed: [['active','Re-open'],['draft','Back to Draft']]
  }[cycle.status] || []).filter(([s]) => !(s === 'draft' && anyInviteSent));

  const sent   = parseInt(req.query.sent   || '0', 10);
  const failed = parseInt(req.query.failed || '0', 10);
  let flash = '';
  if (sent || failed) {
    flash = failed
      ? `<div class="flash flash-warn"><strong>${sent} invitation${sent===1?'':'s'} sent, ${failed} failed.</strong> Failures are usually a bad email address or a sending limit. Check the logs, then click Send Invites again to retry the ones that did not go.</div>`
      : `<div class="flash flash-ok">${sent} invitation${sent===1?'':'s'} sent.</div>`;
  } else if (req.query.datesUpdated === '1') {
    flash = `<div class="flash flash-ok">Dates updated.</div>`;
  }

  const rows = leaders.map(l => {
    const total     = l.raters?.length || 0;
    const completed = l.raters?.filter(r => r.completed_at).length || 0;
    const pct       = total ? Math.round(completed/total*100) : 0;
    return `<tr>
      <td><a href="/admin/leaders/${l.id}">${l.name}</a></td>
      <td style="color:var(--grey)">${l.title || '&mdash;'}</td>
      <td style="color:var(--grey)">${l.department || '&mdash;'}</td>
      <td>${total}</td>
      <td><div class="progress-wrap"><div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div><span class="progress-label">${completed}/${total}</span></div></td>
      <td><div class="actions-row">
        <a href="/admin/leaders/${l.id}" class="btn btn-ghost btn-sm">Manage</a>
        <form method="POST" action="/admin/leaders/${l.id}/send-invites" style="display:inline">
          <button class="btn btn-sage btn-sm" type="submit">Send Invites</button>
        </form>
      </div></td>
    </tr>`;
  }).join('');

  return adminShell(cycle.name, `
    <div class="page-header">
      <div>
        <div class="page-title">${cycle.name}</div>
        <div class="page-sub"><span class="badge badge-${cycle.status}">${cycle.status}</span>${cycle.client_name ? ' &nbsp;·&nbsp; ' + cycle.client_name : ''}</div>
      </div>
      <div class="actions-row">
        ${statusBtns.map(([s,l]) => `<form method="POST" action="/admin/cycles/${cycle.id}/status" style="display:inline"><input type="hidden" name="status" value="${s}"/><button class="btn ${s==='active'?'btn-sage':s==='closed'?'btn-red':'btn-ghost'}" type="submit">${l}</button></form>`).join('')}
        ${cycle.status === 'draft' ? `<a href="/admin/cycles/${cycle.id}/custom-questions" class="btn btn-ghost">Custom Questions</a>` : ''}
        <a href="/admin/cycles/${cycle.id}/leaders/new" class="btn btn-primary">+ Add Leader</a>
      </div>
    </div>
    ${flash}
    ${cycle.status === 'draft' && leaders.length ? `
    <div class="card alert-card">
      <div style="font-size:14px;font-weight:600;color:#A94442;margin-bottom:6px">This Group is not active</div>
      <div style="font-size:13px;color:var(--grey);line-height:1.7;margin-bottom:14px">Raters will not be able to open their survey until you activate this Group. If you send invites now, everyone will receive a link that does not work.</div>
      <form method="POST" action="/admin/cycles/${cycle.id}/status"><input type="hidden" name="status" value="active"/><button class="btn btn-sage" type="submit">Activate Group</button></form>
    </div>` : ''}
    <div class="card" style="max-width:580px">
      <div class="card-header"><span class="card-title">Dates</span></div>
      <form method="POST" action="/admin/cycles/${cycle.id}/dates">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Opens At</label>
            <input class="form-control" type="datetime-local" name="opens_at" value="${toLocalInputValue(cycle.opens_at)}"/>
            <div class="form-hint">Leave blank for no open-date restriction.</div>
          </div>
          <div class="form-group">
            <label class="form-label">Closes At *</label>
            <input class="form-control" type="datetime-local" name="closes_at" value="${toLocalInputValue(cycle.closes_at)}" required/>
            <div class="form-hint">Raters cannot submit after this date.</div>
          </div>
        </div>
        <div class="actions-row">
          <button class="btn btn-primary" type="submit">Save Dates</button>
        </div>
      </form>
    </div>
    <div class="card">
      <div class="card-header"><span class="card-title">Leaders</span><span style="font-size:13px;color:var(--grey)">${leaders.length} leader${leaders.length!==1?'s':''}</span></div>
      ${leaders.length ? `
      <table class="data-table">
        <thead><tr><th>Leader</th><th>Title</th><th>Department</th><th>Raters</th><th>Responses</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : `
      <div class="empty-state"><div class="empty-state-icon">&#128100;</div><div class="empty-state-text">No leaders added yet.</div><a href="/admin/cycles/${cycle.id}/leaders/new" class="btn btn-primary">Add First Leader</a></div>`}
    </div>`, req);
}

function leaderFormPage(cycleId, req) {
  return adminShell('Add Leader', `
    <div class="page-header"><div>
      <div class="page-title">Add Leader</div>
      <div class="page-sub">The leader being assessed. A self-assessment link is created automatically.</div>
    </div></div>
    <div class="card" style="max-width:580px">
      <form method="POST" action="/admin/cycles/${cycleId}/leaders">
        <div class="form-row">
          <div class="form-group"><label class="form-label">Full Name *</label><input class="form-control" name="name" required placeholder="Jane Smith"/></div>
          <div class="form-group"><label class="form-label">Title</label><input class="form-control" name="title" placeholder="VP of Operations"/></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label class="form-label">Email *</label><input class="form-control" type="email" name="email" required placeholder="jane@company.com"/></div>
          <div class="form-group"><label class="form-label">Department</label><input class="form-control" name="department" placeholder="Operations"/></div>
        </div>
        <div class="actions-row">
          <button class="btn btn-primary" type="submit">Add Leader</button>
          <a href="/admin/cycles/${cycleId}" class="btn btn-ghost">Cancel</a>
        </div>
      </form>
    </div>`, req);
}

function raterRow(prefill) {
  const n = prefill ? prefill.name  || '' : '';
  const e = prefill ? prefill.email || '' : '';
  const g = prefill ? prefill.group || '' : '';
  const incomplete = prefill && (n || e || g) && !(n && e && g);
  return `<div class="rater-row${incomplete ? ' rater-row-incomplete' : ''}">
    <div><input class="form-control" type="text" name="name" placeholder="Full name" required value="${n}"/></div>
    <div><input class="form-control" type="email" name="email" placeholder="email@company.com" required value="${e}"/></div>
    <div><select class="form-control" name="rater_group" required>
      <option value="" ${g ? '' : 'selected'}>Select relationship...</option>
      <option value="supervisor" ${g==='supervisor'?'selected':''}>Supervisor</option>
      <option value="peer" ${g==='peer'?'selected':''}>Peer</option>
      <option value="direct_report" ${g==='direct_report'?'selected':''}>Direct Report</option>
      <option value="skip_level" ${g==='skip_level'?'selected':''}>Skip-Level</option>
    </select></div>
    <button type="button" class="remove-rater-btn" onclick="this.closest('.rater-row').remove()">&#215;</button>
  </div>`;
}

function raterFormPage(leader, req, error, prevValues) {
  if (!leader) return adminShell('Error', '<p>Leader not found.</p>', req);

  const prevNames  = prevValues ? [].concat(prevValues.names  || []) : [];
  const prevEmails = prevValues ? [].concat(prevValues.emails || []) : [];
  const prevGroups = prevValues ? [].concat(prevValues.groups || []) : [];
  const rowCount = Math.max(3, prevNames.length);

  const initialRows = Array.from({ length: rowCount }, (_, i) =>
    raterRow(prevValues ? { name: prevNames[i], email: prevEmails[i], group: prevGroups[i] } : null)
  ).join('');

  return adminShell('Add Raters', `
    <div class="page-header"><div>
      <div class="page-title">Add Raters</div>
      <div class="page-sub">Adding raters for <strong>${leader.name}</strong>. Each person receives a unique anonymous survey link.</div>
    </div></div>
    ${error ? `<div class="flash flash-warn">${error}</div>` : ''}
    <div class="card">
      <form method="POST" action="/admin/leaders/${leader.id}/raters" id="rater-form">
        <div class="form-section">
          <div class="form-section-title">Rater Information</div>
          <div class="rater-row-header"><span>Full Name *</span><span>Email Address *</span><span>Relationship to Leader *</span><span></span></div>
          <div class="rater-rows" id="rater-rows">${initialRows}</div>
          <button type="button" class="add-rater-btn" onclick="addRaterRow()"><span style="font-size:18px;line-height:1">+</span> Add Another Rater</button>
          <div class="form-hint" style="margin-top:10px">All three fields are required for each rater you add. Leave a row completely blank to skip it. Three completed rater responses are needed before a report can be generated, and the self-assessment does not count toward that.</div>
        </div>
        <div class="actions-row" style="margin-top:8px">
          <button class="btn btn-primary" type="submit">Save Raters</button>
          <a href="/admin/leaders/${leader.id}" class="btn btn-ghost">Cancel</a>
        </div>
      </form>
    </div>
    <script>
    function addRaterRow() {
      const div = document.createElement('div');
      div.className = 'rater-row';
      div.innerHTML = \`
        <div><input class="form-control" type="text" name="name" placeholder="Full name" required/></div>
        <div><input class="form-control" type="email" name="email" placeholder="email@company.com" required/></div>
        <div><select class="form-control" name="rater_group" required>
          <option value="">Select relationship...</option>
          <option value="supervisor">Supervisor</option>
          <option value="peer">Peer</option>
          <option value="direct_report">Direct Report</option>
          <option value="skip_level">Skip-Level</option>
        </select></div>
        <button type="button" class="remove-rater-btn" onclick="this.closest('.rater-row').remove()">&#215;</button>
      \`;
      document.getElementById('rater-rows').appendChild(div);
    }
    </script>`, req);
}


function leaderDetailPage(leader, raters, report, completedCount, totalCount, req) {
  if (!leader) return adminShell('Error', '<p>Leader not found.</p>', req);
  const pct = totalCount ? Math.round(completedCount/totalCount*100) : 0;
  const raterCompleted = raters.filter(r => r.completed_at && r.rater_group !== 'self').length;
  const groupOrder = ['self','supervisor','peer','direct_report','skip_level'];
  const sorted = [...raters].sort((a,b) => groupOrder.indexOf(a.rater_group)-groupOrder.indexOf(b.rater_group));

  const rows = sorted.map(r => `<tr>
    <td>${r.name}</td>
    <td>${r.email}</td>
    <td><span class="badge badge-${r.rater_group}">${r.rater_group.replace(/_/g,' ')}</span></td>
    <td>${r.email_sent_at ? '<span style="color:var(--sage)">&#10003; Sent ' + new Date(r.email_sent_at).toLocaleDateString('en-US',{month:'short',day:'numeric'}) + '</span>' : '<span style="color:#ccc">Not sent</span>'}</td>
    <td><span class="badge ${r.completed_at?'badge-complete':'badge-pending'}">${r.completed_at?'Complete':'Pending'}</span></td>
    <td><div class="actions-row">
      <a href="${process.env.APP_URL||''}/survey/${r.token}" target="_blank" class="btn btn-ghost btn-sm">Open Link</a>
      ${!r.completed_at?`<form method="POST" action="/admin/raters/${r.id}/delete" style="display:inline" onsubmit="return confirm('Remove this rater?')"><button class="btn btn-red btn-sm">Remove</button></form>`:''}
    </div></td>
  </tr>`).join('');

  return adminShell(leader.name, `
    <div class="page-header">
      <div>
        <a href="/admin/cycles/${leader.cycle_id}" style="color:var(--clay);font-size:13px;font-weight:600;text-decoration:none;display:inline-block;margin-bottom:10px">&larr; Back to ${leader.cycles ? leader.cycles.name : 'Group'}</a>
        <div class="page-title">${leader.name}</div>
        <div class="page-sub">${leader.title||''}${leader.department?' &nbsp;·&nbsp; '+leader.department:''}</div>
      </div>
      <div class="actions-row">
        <a href="/admin/leaders/${leader.id}/raters/new" class="btn btn-primary">+ Add Raters</a>
        <form method="POST" action="/admin/leaders/${leader.id}/send-invites"><button class="btn btn-sage" type="submit">Send Pending Invites</button></form>
        ${raterCompleted>=3?`<form method="POST" action="/admin/leaders/${leader.id}/generate-report" onsubmit="this.querySelector('button').disabled=true;this.querySelector('button').textContent='Generating... please wait (30-60 sec)'"><button class="btn btn-ink" type="submit">Generate AI Report</button></form>`:`<span style="font-size:12px;color:var(--grey);align-self:center">Need 3+ rater responses to generate report (currently ${raterCompleted})</span>`}
        ${report?`<a href="/report/pdf/${report.id}" class="btn btn-outline" target="_blank" rel="noopener">Download PDF</a>`:''}
        <a href="/CARE_360_Leadership_Action_Plan.pptx" class="btn btn-ghost" download>Action Plan Template</a>
      </div>
    </div>
    <div class="stats-row">
      <div class="stat-card"><div class="stat-num">${totalCount}</div><div class="stat-lbl">Total Raters</div></div>
      <div class="stat-card" style="border-color:var(--sage)"><div class="stat-num" style="color:var(--sage)">${completedCount}</div><div class="stat-lbl">Completed</div></div>
      <div class="stat-card" style="border-color:var(--clay)"><div class="stat-num" style="color:var(--clay)">${pct}%</div><div class="stat-lbl">Response Rate</div></div>
    </div>
    <div class="card">
      <div class="card-header">
        <span class="card-title">Raters</span>
        <div class="progress-wrap"><div class="progress-bar" style="width:120px"><div class="progress-fill" style="width:${pct}%"></div></div><span class="progress-label">${completedCount} of ${totalCount} complete</span></div>
      </div>
      ${raters.length?`
      <table class="data-table">
        <thead><tr><th>Name</th><th>Email</th><th>Relationship</th><th>Invite</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`:`
      <div class="empty-state"><div class="empty-state-icon">&#128101;</div><div class="empty-state-text">No raters added yet.</div><a href="/admin/leaders/${leader.id}/raters/new" class="btn btn-primary">Add Raters</a></div>`}
    </div>`, req);
}

module.exports = router;
// Exposed so other routers (guide.js) can render through the exact same
// shell, real nav and real switcher included, instead of keeping their
// own separate copy that silently stops matching this one.
module.exports.adminShell = adminShell;
