const express  = require('express');
const router   = express.Router();
const supabase = require('../db/client');
const { nanoid } = require('nanoid');
const { sendRaterInvite, sendTeammateInvite } = require('../email');
const { generateHandoffToken } = require('../auth');
const { icon } = require('../icons');

const ELEMENT_PROFILE_URL = process.env.ELEMENT_PROFILE_URL || 'https://element.ingoodcocollective.com';

// Every query below runs on the signed in user's own connection, so the
// database refuses to return another account's rows.
function db(req) { return req.userDb || supabase; }

function requireAuth(req, res, next) {
  if (req.isAdmin) return next();
  res.redirect('/signin');
}

// The addresses whose email just failed to send, carried to the next page
// in a short-lived signed cookie (never the page address) and shown once.
const FAILED_EMAILS_COOKIE = 'failedEmails';
const FAILED_EMAILS_OPTS = { signed: true, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/admin' };
function setFailedEmails(res, emails) {
  if (emails.length) res.cookie(FAILED_EMAILS_COOKIE, JSON.stringify(emails.slice(0, 25)), { ...FAILED_EMAILS_OPTS, maxAge: 5 * 60 * 1000 });
}
function takeFailedEmails(req, res) {
  const raw = req.signedCookies && req.signedCookies[FAILED_EMAILS_COOKIE];
  if (!raw) return [];
  res.clearCookie(FAILED_EMAILS_COOKIE, FAILED_EMAILS_OPTS);
  try { const list = JSON.parse(raw); return Array.isArray(list) ? list.filter(e => typeof e === 'string') : []; } catch (e) { return []; }
}
const failedEmailsList = emails => emails.map(e => `<strong>${escapeHtml(e)}</strong>`).join(', ');

// The old shared-password login is gone. This still clears its cookie from
// any browser that has one left over.
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
// The team itself lives on the account page now (routes/account-settings.js);
// the old address still works.
router.get('/team', requireAuth, (req, res) => res.redirect('/admin/account#team'));

router.post('/team/invites', requireAuth, async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const name  = (req.body.name || '').trim();

  if (!email) return res.redirect('/admin/account#team');

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
    return res.redirect('/admin/account#team');
  }

  try {
    const inviterName = (req.session && req.session.name) || 'A teammate';
    await sendTeammateInvite(inviteRow, inviterName, req.account ? req.account.name : 'care 360');
  } catch (e) {
    console.error('Teammate invite email failed:', e.message);
    // Nobody received the link, so the invite is taken back rather than
    // left looking pending; sending it again starts fresh.
    const { error: undoError } = await db(req).from('account_invites').delete().eq('token', inviteRow.token);
    if (undoError) console.error('Could not remove the unsent teammate invite:', undoError.message);
    return res.redirect('/admin/account?error=invite-failed#team');
  }

  res.redirect('/admin/account?done=invite-sent#team');
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
  req.failedEmails = takeFailedEmails(req, res);
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
          <div style="font-size:13px;color:var(--grey);line-height:1.75;margin-bottom:18px">Your trial covers one leader, and you've already run one. Upgrade to add more leaders, unlimited Groups, and everything else care 360 offers.</div>
          <a href="${req.account.is_coach ? '/coach?product=care360' : '/plans'}" class="btn btn-primary">See plans</a>
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
    const { data: leaderFull, error: leaderErr } = await db(req).from('leaders').select('*').eq('id', leaderId).maybeSingle();
    // Found a moment ago, so a miss now is a failed lookup, not a missing leader.
    if (!leaderFull) {
      console.error('Rater form reload failed:', leaderErr ? leaderErr.message : 'leader not returned');
      return res.status(500).send(adminShell('Something went wrong', `<div class="card alert-card" style="max-width:520px"><div style="font-size:13px;color:var(--grey);line-height:1.7;margin-bottom:16px">We couldn't reload this leader just now, so the raters were not saved. Please go back and try again.</div><a href="/admin/leaders/${encodeURIComponent(leaderId)}" class="btn btn-ghost">Back to leader</a></div>`, req));
    }
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

  // A rater is marked sent only once Resend has accepted their email, so
  // Send Invites again retries exactly the ones that didn't go.
  let sent = 0, failed = 0;
  const failedEmails = [];
  for (const rater of (raters || [])) {
    try {
      await sendRaterInvite(rater, leader);
      await db(req).from('raters').update({ email_sent_at: new Date().toISOString() }).eq('id', rater.id);
      sent++;
    } catch (e) {
      failed++;
      failedEmails.push(rater.email);
      console.error('Email failed for', rater.email, e.message);
    }
  }
  if (failed) console.error(`INVITES: ${sent} sent, ${failed} failed for leader ${leaderId}`);
  setFailedEmails(res, failedEmails);

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
:root{
  --ink:#30383B;--ink-deep:#20282B;--grey:#637074;
  --clay:#A9633D;--clay-dark:#925433;--clay-tint:#F7ECE5;
  --ochre:#A87B2C;--ochre-light:#E3C785;--ochre-tint:#FBF5E6;--ochre-line:#EEDFB8;
  --sage:#6E7A55;--sage-tint:#EEF1E8;
  --danger:#A94442;--danger-tint:#FBEFED;--danger-line:#F1D3CF;
  --sand:#D9CBB2;--cream:#F7F3EA;--warm:#EDE8DF;--lgrey:#EAE6DE;
  --white:#ffffff;--wash:#FAF8F4;
  --line:rgba(48,56,59,0.09);--line-strong:rgba(48,56,59,0.18);
  --shadow:0 1px 2px rgba(48,56,59,0.04),0 2px 10px rgba(48,56,59,0.04);
  --shadow-lift:0 2px 4px rgba(48,56,59,0.05),0 14px 32px rgba(48,56,59,0.09);
  --shadow-md:0 16px 40px rgba(48,56,59,0.14);
  --ease:cubic-bezier(.2,.7,.2,1);
}
body{font-family:'Noto Sans',Arial,sans-serif;background:var(--white);color:var(--ink);font-size:14px;line-height:1.6;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:var(--ink);text-decoration:underline;text-decoration-color:var(--line-strong);text-underline-offset:3px;transition:color .15s,text-decoration-color .15s}a:hover{color:var(--clay);text-decoration-color:currentColor}
:focus-visible{outline:2px solid var(--clay);outline-offset:2px}
::selection{background:var(--ochre-light);color:var(--ink)}

/* ── Header: sticky, frosted ───────────────────────────────── */
.admin-nav{background:rgba(255,255,255,0.78);-webkit-backdrop-filter:saturate(180%) blur(16px);backdrop-filter:saturate(180%) blur(16px);height:72px;display:flex;align-items:center;padding:0 40px;gap:28px;box-shadow:0 1px 0 var(--line);position:sticky;top:0;z-index:100;transition:box-shadow .25s var(--ease)}
.admin-nav.scrolled{box-shadow:0 1px 0 var(--line),0 10px 30px rgba(48,56,59,0.06)}
.nav-logo{display:flex;align-items:center;gap:10px}
.nav-logo-mark{width:30px;height:30px;display:block;flex-shrink:0}
.nav-brand{color:var(--ink);font-weight:500;font-size:23px;font-family:'EB Garamond',Georgia,serif;letter-spacing:-0.5px;line-height:1}
.nav-logo-switcher{position:relative;cursor:pointer}
.nav-logo-switcher summary{list-style:none}
.nav-logo-switcher summary::-webkit-details-marker{display:none}
.nav-logo-switcher summary::after{content:'';width:6px;height:6px;border-right:1.5px solid var(--ink);border-bottom:1.5px solid var(--ink);transform:rotate(45deg);margin:-4px 0 0 4px;opacity:0.5;transition:transform .2s var(--ease)}
.nav-logo-switcher[open] summary::after{transform:rotate(225deg);margin-top:4px}
.nav-logo-switcher summary:focus-visible{outline:2px solid var(--clay);outline-offset:4px;border-radius:6px}
.nav-logo-dropdown{position:absolute;top:100%;left:0;margin-top:14px;background:var(--white);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow-md);padding:6px;min-width:230px;z-index:200;animation:igc-pop .18s var(--ease) both}
.nav-logo-dropdown-item{display:block;padding:10px 14px;font-size:14px;font-weight:500;color:var(--ink);border-radius:10px;white-space:nowrap;text-decoration:none}
.nav-logo-dropdown-item:hover{background:var(--wash);color:var(--ink)}
.nav-link{position:relative;color:var(--ink);font-size:14px;font-weight:400;text-transform:lowercase;text-decoration:none;opacity:0.72;transition:opacity .15s}
.nav-link:hover{opacity:1;color:var(--ink)}
.nav-link::after{content:'';position:absolute;left:0;right:0;bottom:-6px;height:1.5px;background:var(--clay);border-radius:2px;transform:scaleX(0);transform-origin:left;transition:transform .25s var(--ease)}
.nav-link:hover::after{transform:scaleX(1)}
.nav-link-accent{color:var(--clay);font-weight:600;opacity:1}
.nav-link-btn{background:none;border:none;font-family:inherit;padding:0;cursor:pointer}
.nav-spacer{flex:1}
.nav-user{display:flex;align-items:center;gap:14px;color:var(--grey);font-size:14px}
.nav-acct{color:var(--ink);font-size:14px;font-weight:500;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nav-plan{font-size:12px;font-weight:600;background:var(--ochre-tint);color:var(--ochre);border:1px solid var(--ochre-line);padding:2px 10px;border-radius:999px}
.nav-avatar{width:32px;height:32px;border-radius:50%;background:var(--ink);color:var(--cream);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;flex-shrink:0;box-shadow:0 0 0 2px var(--white),0 0 0 3px var(--line)}

/* ── Page ──────────────────────────────────────────────────── */
@keyframes igc-rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes igc-pop{from{opacity:0;transform:translateY(-4px) scale(.98)}to{opacity:1;transform:none}}
.admin-main{max-width:1120px;margin:0 auto;padding:52px 40px 104px}
.admin-main>*{animation:igc-rise .55s var(--ease) both}
.admin-main>*:nth-child(2){animation-delay:.05s}.admin-main>*:nth-child(3){animation-delay:.1s}.admin-main>*:nth-child(4){animation-delay:.15s}.admin-main>*:nth-child(5){animation-delay:.2s}.admin-main>*:nth-child(n+6){animation-delay:.25s}
.page-header{position:relative;z-index:10;display:flex;align-items:flex-end;justify-content:space-between;flex-wrap:wrap;gap:16px;margin-bottom:36px}
.page-title{font-family:'EB Garamond',Georgia,serif;font-size:50px;font-weight:500;color:var(--ink);letter-spacing:-1.8px;line-height:1.04;margin-bottom:10px;font-feature-settings:"lnum" 1}
.page-sub{font-size:15px;color:var(--grey)}
.person{display:inline-flex;align-items:center;gap:10px;font-weight:600;white-space:nowrap}
.avatar{width:30px;height:30px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11.5px;font-weight:600;letter-spacing:.02em;flex-shrink:0}
.avatar-0{background:var(--clay-tint);color:var(--clay-dark)}
.avatar-1{background:var(--ochre-tint);color:var(--ochre);box-shadow:inset 0 0 0 1px var(--ochre-line)}
.avatar-2{background:var(--sage-tint);color:#56603F}
.avatar-3{background:#EEF0F0;color:var(--ink)}
.when{display:inline-flex;align-items:center;gap:5px;margin-top:3px;font-size:12px;color:var(--grey);white-space:nowrap}
.when .i{width:13px;height:13px}
.when-soon{color:var(--ochre);font-weight:600}
.when-past{color:var(--danger)}
.page-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px}
.page-meta .when{margin-top:0}
.greeting{font-size:14px;font-weight:500;color:var(--clay);margin-bottom:6px}
.next-step{display:flex;align-items:center;gap:18px;background:var(--white);border:1px solid var(--line);border-radius:20px;padding:18px 20px 18px 18px;margin-bottom:20px;box-shadow:var(--shadow)}
.next-icon{width:44px;height:44px;border-radius:14px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.next-icon .i{width:20px;height:20px}
.next-ochre .next-icon{background:var(--ochre-tint);color:var(--ochre);border:1px solid var(--ochre-line)}
.next-clay .next-icon{background:var(--clay-tint);color:var(--clay)}
.next-text{flex:1;min-width:0}
.next-label{font-size:11.5px;font-weight:600;letter-spacing:.05em;color:var(--grey);margin-bottom:2px}
.next-text p{font-size:15px;line-height:1.5}
.next-text strong{font-weight:600}
.next-step .btn .i{margin-left:2px}
@media(max-width:700px){.next-step{flex-wrap:wrap}.next-step .btn{width:100%}}
.eyebrow{font-size:12px;font-weight:600;letter-spacing:.06em;color:var(--grey);text-transform:lowercase}

/* ── Cards: white on white ─────────────────────────────────── */
.card{background:var(--white);border:1px solid var(--line);border-radius:20px;padding:28px 30px;margin-bottom:20px;box-shadow:var(--shadow);overflow-x:auto}
.card-header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}
.card-title{text-transform:lowercase;font-family:'EB Garamond',Georgia,serif;font-size:26px;font-weight:500;color:var(--ink);letter-spacing:-0.6px}
.card-meta{font-size:13px;color:var(--grey)}

/* ── Stat tiles ────────────────────────────────────────────── */
.stats-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:20px}
.stat-card{position:relative;background:var(--white);border:1px solid var(--line);border-radius:20px;padding:24px 26px 22px;box-shadow:var(--shadow);transition:transform .25s var(--ease),box-shadow .25s var(--ease)}
.stat-card:hover{transform:translateY(-2px);box-shadow:var(--shadow-lift)}
.i{width:1.15em;height:1.15em;flex-shrink:0;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round;vertical-align:-0.2em}
.btn .i{width:15px;height:15px;margin:0 -1px}
.btn-sm .i{width:13px;height:13px}
.stat-card>.i{position:absolute;top:22px;right:22px;width:18px;height:18px;color:var(--grey);opacity:.55}
.sent{display:inline-flex;align-items:center;gap:5px;color:#56603F;white-space:nowrap}.sent .i{width:14px;height:14px}
.remove-rater-btn .i{width:15px;height:15px}
.add-rater-btn .i{width:16px;height:16px}
.stat-card-ring{display:flex;align-items:center;justify-content:space-between;gap:12px}
.stat-num{font-family:'EB Garamond',Georgia,serif;font-size:56px;font-weight:500;color:var(--ink);line-height:.95;letter-spacing:-1.6px;font-feature-settings:"lnum" 1,"tnum" 1}
.stat-num small{font-size:28px;letter-spacing:-0.5px;margin-left:2px;color:var(--grey)}
.stat-lbl{text-transform:lowercase;font-size:13px;font-weight:500;color:var(--grey);margin-top:10px}
.stat-bar{height:4px;border-radius:999px;background:rgba(48,56,59,0.07);margin-top:16px;overflow:hidden}
.stat-bar span{display:block;height:100%;border-radius:999px;background:var(--ink);transform-origin:left;animation:igc-grow .9s .2s var(--ease) both}
.stat-bar-clay span{background:var(--clay)}.stat-bar-ochre span{background:var(--ochre-light)}.stat-bar-sage span{background:var(--sage)}
@keyframes igc-grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
.stat-ring{flex-shrink:0}
.stat-ring .ring-value{stroke-dashoffset:0;animation:igc-ring 1.1s .2s var(--ease) both}
@keyframes igc-ring{from{stroke-dashoffset:var(--ring-len)}to{stroke-dashoffset:0}}

/* ── Buttons ───────────────────────────────────────────────── */
.btn{text-transform:lowercase;display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:11px 20px;border-radius:999px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid transparent;transition:background .15s,color .15s,border-color .15s,box-shadow .2s var(--ease),transform .12s var(--ease);line-height:1.1;font-family:inherit;text-decoration:none;white-space:nowrap}
.btn:hover{text-decoration:none}
.btn:active{transform:translateY(1px) scale(.98)}
.btn-primary,.btn-ink{background:var(--ink);color:var(--cream);box-shadow:0 1px 2px rgba(32,40,43,0.2),inset 0 1px 0 rgba(255,255,255,0.08)}
.btn-primary:hover,.btn-ink:hover{background:var(--ink-deep);color:var(--cream);box-shadow:0 6px 16px rgba(32,40,43,0.18)}
.btn-sage{background:var(--clay);color:var(--white);box-shadow:0 1px 2px rgba(146,84,51,0.25),inset 0 1px 0 rgba(255,255,255,0.12)}
.btn-sage:hover{background:var(--clay-dark);color:var(--white);box-shadow:0 6px 16px rgba(146,84,51,0.22)}
.btn-red{background:var(--white);color:var(--danger);border-color:var(--danger-line)}
.btn-red:hover{background:var(--danger);color:var(--white);border-color:var(--danger)}
.btn-outline{background:var(--white);color:var(--ink);border-color:var(--ink)}
.btn-outline:hover{background:var(--ink);color:var(--cream)}
.btn-ghost{background:var(--white);color:var(--ink);border-color:var(--line-strong)}
.btn-ghost:hover{border-color:var(--ink);color:var(--ink)}
.btn-sm{padding:7px 14px;font-size:12px}

/* ── Tables ────────────────────────────────────────────────── */
.data-table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.data-table th{background:transparent;color:var(--grey);padding:0 14px 12px;text-align:left;font-size:11.5px;font-weight:600;letter-spacing:.05em;text-transform:lowercase;border-bottom:1px solid var(--line)}
.data-table td{padding:16px 14px;border-bottom:1px solid var(--line);font-size:14px;vertical-align:middle;transition:background .15s}
.data-table tr:last-child td{border-bottom:none}
.data-table tbody tr:hover td{background:var(--wash)}
.data-table tbody tr:hover td:first-child{border-radius:12px 0 0 12px}
.data-table tbody tr:hover td:last-child{border-radius:0 12px 12px 0}
.data-table td a:not(.btn){font-weight:600;text-decoration:none}
.data-table td a:not(.btn):hover{color:var(--clay)}
.row-actions{text-align:right;white-space:nowrap}
.row-actions .actions-row{justify-content:flex-end}
@media(hover:hover){
  .row-actions>*{opacity:0;transform:translateX(4px);transition:opacity .2s var(--ease),transform .2s var(--ease)}
  .data-table tbody tr:hover .row-actions>*,.data-table tbody tr:focus-within .row-actions>*{opacity:1;transform:none}
}

/* ── Badges ────────────────────────────────────────────────── */
.badge{display:inline-flex;align-items:center;gap:6px;padding:3px 11px 3px 9px;border-radius:999px;font-size:12px;font-weight:500;text-transform:lowercase;white-space:nowrap;border:1px solid transparent}
.badge::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor}
.badge-active{background:var(--clay-tint);color:var(--clay-dark)}
.badge-draft{background:#F3F2EF;color:var(--grey)}
.badge-closed{background:#F3F2EF;color:var(--ink)}
.badge-complete{background:var(--sage-tint);color:#56603F}
.badge-pending{background:var(--ochre-tint);color:var(--ochre);border-color:var(--ochre-line)}
.badge-pending::before{background:var(--ochre-light);box-shadow:0 0 0 1px var(--ochre)}
.badge-self{background:#EEF0F0;color:var(--ink)}
.badge-supervisor{background:var(--clay-tint);color:var(--clay-dark)}
.badge-peer{background:var(--sage-tint);color:#56603F}
.badge-direct_report{background:var(--ochre-tint);color:var(--ochre)}
.badge-skip_level{background:#F3F2EF;color:var(--grey)}

/* ── Progress ──────────────────────────────────────────────── */
.progress-wrap{display:flex;align-items:center;gap:10px}
.progress-bar{height:5px;background:rgba(48,56,59,0.08);border-radius:999px;overflow:hidden;width:80px;flex-shrink:0}
.progress-fill{height:100%;background:var(--clay);border-radius:999px;transition:width .4s var(--ease)}
.progress-label{font-size:12px;color:var(--grey);white-space:nowrap;font-variant-numeric:tabular-nums}

/* ── Forms ─────────────────────────────────────────────────── */
.form-section{margin-bottom:28px}
.form-section-title{text-transform:lowercase;font-family:'EB Garamond',Georgia,serif;font-size:24px;font-weight:500;color:var(--ink);letter-spacing:-0.5px;margin-bottom:16px}
.form-group{margin-bottom:18px}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.form-label{display:block;font-size:13px;font-weight:600;color:var(--ink);margin-bottom:7px}
.form-control{width:100%;padding:11px 14px;border:1px solid var(--line-strong);border-radius:12px;font-size:14px;font-family:inherit;color:var(--ink);background:var(--white);box-shadow:0 1px 2px rgba(48,56,59,0.04);transition:border-color .15s,box-shadow .15s}
.form-control::placeholder{color:#9AA2A4}
.form-control:hover{border-color:rgba(48,56,59,0.3)}
.form-control:focus{outline:none;border-color:var(--clay);box-shadow:0 0 0 4px rgba(169,99,61,0.12)}
select.form-control{cursor:pointer}
.form-hint{font-size:12px;color:var(--grey);margin-top:7px;line-height:1.55}

.rater-rows{display:flex;flex-direction:column;gap:10px}
.rater-row{display:grid;grid-template-columns:1fr 1fr 180px 40px;gap:10px;align-items:center;background:var(--wash);border-radius:16px;padding:12px 14px;border:1px solid var(--line);animation:igc-rise .35s var(--ease) both}
.rater-row-incomplete{border-color:var(--danger-line);background:var(--danger-tint)}
.rater-row-header{display:grid;grid-template-columns:1fr 1fr 180px 40px;gap:10px;padding:0 14px 8px}
.rater-row-header span{font-size:12px;font-weight:600;color:var(--grey)}
.remove-rater-btn{width:34px;height:34px;border-radius:50%;border:1px solid var(--line-strong);background:var(--white);color:var(--grey);cursor:pointer;font-size:17px;display:flex;align-items:center;justify-content:center;transition:all .15s;font-family:inherit}
.remove-rater-btn:hover{background:var(--danger);border-color:var(--danger);color:var(--white)}
.add-rater-btn{text-transform:lowercase;display:inline-flex;align-items:center;gap:8px;padding:10px 18px;border:1px dashed var(--line-strong);border-radius:999px;color:var(--ink);background:var(--white);cursor:pointer;font-size:13px;font-weight:600;font-family:inherit;margin-top:12px;transition:all .15s}
.add-rater-btn:hover{border-color:var(--clay);color:var(--clay)}

.actions-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.btn-icon{padding:11px 13px}
.btn-locked{background:var(--wash);color:var(--grey);border-color:var(--line);cursor:not-allowed;gap:8px}
.btn-locked:active{transform:none}
.lock-count{color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums;text-transform:none}
.lock-bar{display:inline-block;width:36px;height:4px;border-radius:999px;background:rgba(48,56,59,0.1);overflow:hidden}
.lock-bar i{display:block;height:100%;background:var(--ochre-light);border-radius:999px}
.menu{position:relative}
.menu>summary{list-style:none}
.menu>summary::-webkit-details-marker{display:none}
.menu[open]>summary{border-color:var(--ink)}
.menu-list{position:absolute;right:0;top:calc(100% + 8px);min-width:250px;background:var(--white);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow-md);padding:6px;z-index:60;animation:igc-pop .18s var(--ease) both}
.menu-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;font-size:14px;color:var(--ink);text-decoration:none;white-space:nowrap}
.menu-item:hover{background:var(--wash);color:var(--ink)}
.menu-item .i{width:16px;height:16px;color:var(--grey)}
.menu-item small{margin-left:auto;padding-left:12px;font-size:12px;color:var(--grey)}
.menu-item-off{color:var(--grey);cursor:default}
.menu-item-off:hover{background:none;color:var(--grey)}

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
/* ── Toasts and busy buttons ─────────────────────────────── */
.admin-main>.flash-ok{position:fixed;left:50%;bottom:calc(28px + env(safe-area-inset-bottom,0px));z-index:300;margin:0;width:max-content;max-width:min(560px,calc(100% - 32px));background:var(--ink);color:var(--cream);border-color:var(--ink);border-radius:999px;padding:12px 22px 12px 40px;box-shadow:0 16px 40px rgba(32,40,43,0.28);pointer-events:none;animation:igc-toast-in .45s var(--ease) both,igc-toast-out .4s 4.6s var(--ease) forwards}
.admin-main>.flash-ok::before{background:var(--ochre-light);box-shadow:none;top:50%;margin-top:-4px}
@keyframes igc-toast-in{from{opacity:0;transform:translate(-50%,18px) scale(.97)}to{opacity:1;transform:translate(-50%,0)}}
@keyframes igc-toast-out{to{opacity:0;transform:translate(-50%,18px)}}
@keyframes igc-spin{to{transform:rotate(360deg)}}
.btn.is-loading{position:relative;color:transparent!important;pointer-events:none}
.btn.is-loading .i{visibility:hidden}
.btn.is-loading::after{content:'';position:absolute;inset:0;margin:auto;width:16px;height:16px;border-radius:50%;border:2px solid rgba(247,243,234,0.35);border-top-color:#F7F3EA;animation:igc-spin .7s linear infinite}
.btn-ghost.is-loading::after,.btn-outline.is-loading::after,.btn-red.is-loading::after{border-color:rgba(48,56,59,0.18);border-top-color:var(--ink)}
.btn.is-loading.keep-label{color:var(--white)!important;padding-left:42px}
.btn.is-loading.keep-label::after{right:auto;left:17px}
/* ── Empty states ──────────────────────────────────────────── */
.empty-state{text-align:center;padding:56px 24px 52px;color:var(--grey)}
.empty-state-mark{width:52px;height:52px;opacity:0.22;margin:0 auto 18px;display:block;filter:grayscale(1)}
.empty-state-text{font-family:'EB Garamond',Georgia,serif;font-size:26px;letter-spacing:-0.5px;color:var(--ink);text-transform:lowercase;margin-bottom:20px}

/* ── Callouts ──────────────────────────────────────────────── */
.flash{position:relative;border-radius:14px;padding:14px 18px 14px 40px;margin-bottom:20px;font-size:14px;line-height:1.6;border:1px solid transparent}
.flash::before{content:'';position:absolute;left:18px;top:21px;width:8px;height:8px;border-radius:50%;background:currentColor}
.flash-ok{background:var(--ochre-tint);border-color:var(--ochre-line);color:var(--ink)}
.flash-ok::before{background:var(--ochre-light);box-shadow:0 0 0 1px var(--ochre)}
.flash-warn{background:var(--danger-tint);border-color:var(--danger-line);color:var(--danger)}
.alert-card{background:var(--danger-tint);border-color:var(--danger-line);box-shadow:none}
.notice-card{background:var(--ochre-tint);border-color:var(--ochre-line);box-shadow:none}

@media(max-width:900px){.admin-nav{height:auto;flex-wrap:wrap;padding:14px 20px;gap:10px 20px}.nav-spacer{display:none}.nav-user{width:100%;flex-wrap:wrap;gap:8px 14px}}
@media(max-width:700px){.admin-main{padding:28px 16px 64px}.page-title{font-size:38px}.stat-num{font-size:46px}.form-row{grid-template-columns:1fr}.rater-row{grid-template-columns:1fr}.rater-row-header{display:none}.card{padding:22px 18px;overflow-x:auto}.data-table{font-size:13px}.data-table td,.data-table th{padding:10px}.nav-acct{display:none}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}.admin-main>.flash-ok{position:static;transform:none;width:auto;max-width:none;border-radius:14px;margin-bottom:20px;box-shadow:none}.btn.is-loading::after{animation:igc-spin 1.4s linear infinite!important}}
</style>`;

// Shown at the top of every adminShell page while CARE 360 is past due,
// or while a CARE 360 payment awaits card verification (both set per
// request by src/routes/access-gate.js).
function billingBanner(message, req) {
  return `<div style="background:#FBF5E6;border:1px solid #EEDFB8;border-radius:14px;padding:14px 18px;margin-bottom:20px;font-size:14px;color:#30383B;display:flex;gap:14px;align-items:center;flex-wrap:wrap">
    <span style="flex:1;min-width:220px">${message}</span>
    ${req.account && req.account.stripe_customer_id ? '<a href="/billing/portal" style="font-weight:700;color:#A9633D">Manage billing</a>' : ''}
  </div>`;
}

function billingBanners(req) {
  if (!req) return '';
  return (req.care360Access === 'past_due' ? billingBanner('Your last payment didn\'t go through. Update your billing to keep making changes.', req) : '')
       + (req.care360Pending ? billingBanner('Your payment is pending verification.', req) : '');
}

// Thin bar under a stat tile showing value as a share of total.
function statBar(value, total, tone) {
  const pct = total ? Math.round(value / total * 100) : 0;
  return `<div class="stat-bar${tone ? ' stat-bar-' + tone : ''}"><span style="width:${pct}%"></span></div>`;
}

// Clay ring that fills to pct, echoing the care 360 mark.
function ring(pct) {
  const c = 2 * Math.PI * 22;
  const len = (c * Math.min(100, Math.max(0, pct)) / 100).toFixed(1);
  return `<svg class="stat-ring" viewBox="0 0 60 60" width="60" height="60" aria-hidden="true">
    <circle cx="30" cy="30" r="22" fill="none" stroke="rgba(48,56,59,0.08)" stroke-width="6"/>
    ${pct > 0 ? `<circle class="ring-value" cx="30" cy="30" r="22" fill="none" stroke="#A9633D" stroke-width="6" stroke-linecap="round" stroke-dasharray="${len} ${c.toFixed(1)}" style="--ring-len:${len}" transform="rotate(-90 30 30)"/>` : ''}
  </svg>`;
}

// Account names are typed by the account owner at sign-up, so anything
// that prints one into a page has to escape it.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function adminShell(title, content, req) {
  const acct    = req && req.account ? req.account : null;
  const rawAcctName = acct && acct.name ? String(acct.name) : '';
  const acctName = escapeHtml(rawAcctName);
  const plan     = acct ? acct.plan : '';
  const initial  = escapeHtml(rawAcctName.trim().charAt(0).toUpperCase()) || 'A';

  // Entitlement-aware reminder: only when the account genuinely has
  // exactly one of the two products, read straight from its real,
  // current has_care360/has_element_profile flags. No dismissal state
  // to track, it just stops rendering the moment both are true.
  const missingElementProfile = !!(acct && acct.has_care360 && !acct.has_element_profile);
  const missingCare360        = !!(acct && acct.has_element_profile && !acct.has_care360);
  const bundleReminder = missingElementProfile
    ? 'Upgrade to the Bundle and get Element Profile too'
    : missingCare360
      ? 'Upgrade to the Bundle and get care 360 too'
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
  <title>${title} | care 360</title><link rel="icon" type="image/svg+xml" href="/img/care-mark.svg"/>${CSS}</head><body>
  <nav class="admin-nav">
    ${navLogo}
    <a href="/admin" class="nav-link">Groups</a>
    <a href="/admin/account" class="nav-link">Account</a>
    <a href="/guide" class="nav-link">How it works</a>
    <div class="nav-spacer"></div>
    <div class="nav-user">
      <div class="nav-avatar">${initial}</div>
      ${acctName ? `<span class="nav-acct">${acctName}</span>` : ''}
      ${['trial', 'community', 'enterprise'].includes(plan) ? `<span class="nav-plan">${plan}</span>` : ''}
      ${acct && acct.plan === 'trial' ? `<a href="${acct.is_coach ? '/coach?product=care360' : '/plans'}" class="nav-link nav-link-accent">Upgrade</a>` : ''}
      ${bundleReminder ? `<a href="/billing/upgrade-to-bundle" class="nav-link nav-link-accent">${bundleReminder}</a>` : ''}
      ${acct && acct.stripe_customer_id ? '<a href="/billing/portal" class="nav-link">Manage billing</a>' : ''}
      <a href="/signout" class="nav-link">Sign out</a>
    </div>
  </nav>
  <div class="admin-main">${billingBanners(req)}${content}</div>
  <script>(function(){var n=document.querySelector('.admin-nav');function f(){n.classList.toggle('scrolled',window.scrollY>4)}window.addEventListener('scroll',f,{passive:true});f();document.addEventListener('submit',function(e){if(e.defaultPrevented)return;var b=e.submitter||e.target.querySelector('button[type=submit],button:not([type])');if(!b||b.classList.contains('is-loading'))return;b.classList.add('is-loading');b.setAttribute('aria-busy','true');setTimeout(function(){b.disabled=true},0)});window.addEventListener('pageshow',function(e){if(e.persisted)document.querySelectorAll('.is-loading').forEach(function(b){b.classList.remove('is-loading');b.disabled=false;b.removeAttribute('aria-busy')})});document.addEventListener('click',function(e){document.querySelectorAll('details.menu[open],details.nav-logo-switcher[open]').forEach(function(d){if(!d.contains(e.target))d.removeAttribute('open')})})})();</script>
  </body></html>`;
}

// Whole days from now until an ISO date (negative once it has passed).
function daysUntil(iso) {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
}

function inDays(n) {
  return n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`;
}

// The single most useful thing to do next, read from the account's Groups.
function nextStep(cycles) {
  const open = cycles
    .filter(c => c.status === 'active' && c.closes_at && daysUntil(c.closes_at) >= 0)
    .sort((a, b) => daysUntil(a.closes_at) - daysUntil(b.closes_at));
  const closing = open[0];
  const draft = cycles.find(c => c.status === 'draft');

  if (!cycles.length)
    return { tone: 'clay', icon: 'plus', text: 'Create your first Group to start a 360.', cta: 'New Group', href: '/admin/cycles/new' };
  if (closing && daysUntil(closing.closes_at) <= 3)
    return { tone: 'ochre', icon: 'calendar', text: `<strong>${closing.name}</strong> closes ${inDays(daysUntil(closing.closes_at))}. Check who still needs to respond, or move the close date.`, cta: 'Open Group', href: `/admin/cycles/${closing.id}` };
  if (draft)
    return { tone: 'ochre', icon: 'play', text: `<strong>${draft.name}</strong> is still a draft. Activate it so raters can open their surveys.`, cta: 'Review and activate', href: `/admin/cycles/${draft.id}` };
  if (closing)
    return { tone: 'clay', icon: 'activity', text: `<strong>${closing.name}</strong> is open and closes ${inDays(daysUntil(closing.closes_at))}.`, cta: 'Check responses', href: `/admin/cycles/${closing.id}` };
  return { tone: 'clay', icon: 'plus', text: 'Every Group is closed. Start a new one when you’re ready.', cta: 'New Group', href: '/admin/cycles/new' };
}

// Small initials circle shown before a person's name. The tint is picked
// from the name so the same person always gets the same color.
function avatar(name) {
  const clean = String(name || '').replace(/<[^>]*>/g, '').trim();
  const parts = clean.split(/[\s@._-]+/).filter(Boolean);
  const initials = ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  let h = 0; for (const ch of clean) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `<span class="avatar avatar-${h % 4}" aria-hidden="true">${initials}</span>`;
}

// "closes in 3 days" chip for Groups that are still open or in draft.
function closesChip(c) {
  if (!c.closes_at || c.status === 'closed') return '';
  const n = daysUntil(c.closes_at);
  if (n < 0) return '<span class="when when-past">past close date</span>';
  return `<span class="when${n <= 3 ? ' when-soon' : ''}">${icon('calendar')}closes ${inDays(n)}</span>`;
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
      <td>${c.closes_at ? `<div>${new Date(c.closes_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</div>${closesChip(c)}` : '<span style="color:#ccc">&mdash;</span>'}</td>
      <td class="row-actions"><a href="/admin/cycles/${c.id}" class="btn btn-outline btn-sm">Open</a></td>
    </tr>`).join('');

  const step = nextStep(cycles);
  const acctName = req && req.account ? escapeHtml(req.account.name) : '';

  return adminShell('Dashboard', `
    <div class="page-header">
      <div>
        <div class="greeting" data-greeting><span>welcome back</span>${acctName ? `, ${acctName}` : ''}.</div>
        <div class="page-title">groups.</div>
        <div class="page-sub">Manage your care 360 groups, leaders and raters.</div>
      </div>
      <a href="/admin/cycles/new" class="btn btn-primary">${icon('plus')}New Group</a>
    </div>
    <div class="next-step next-${step.tone}">
      <span class="next-icon">${icon(step.icon)}</span>
      <div class="next-text"><div class="next-label">next step</div><p>${step.text}</p></div>
      <a href="${step.href}" class="btn btn-primary btn-sm">${step.cta}${icon('arrow-right')}</a>
    </div>
    <script>(function(){var g=document.querySelector('[data-greeting] span');if(!g)return;var h=new Date().getHours();g.textContent=h<12?'good morning':h<18?'good afternoon':'good evening';})();</script>
    <div class="stats-row">
      <div class="stat-card">${icon('folder')}<div class="stat-num">${cycles.length}</div><div class="stat-lbl">Total Groups</div>${statBar(cycles.length, cycles.length, '')}</div>
      <div class="stat-card">${icon('activity')}<div class="stat-num">${active}</div><div class="stat-lbl">Active</div>${statBar(active, cycles.length, 'clay')}</div>
      <div class="stat-card">${icon('pencil')}<div class="stat-num">${draft}</div><div class="stat-lbl">Drafts</div>${statBar(draft, cycles.length, 'ochre')}</div>
    </div>
    <div class="card">
      <div class="card-header">
        <span class="card-title">All Groups</span>
        <a href="/admin/cycles/new" class="btn btn-ghost btn-sm">${icon('plus')}New</a>
      </div>
      ${cycles.length ? `
      <table class="data-table">
        <thead><tr><th>Group Name</th><th>Client / Notes</th><th>Status</th><th>Opens</th><th>Closes</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : `
      <div class="empty-state">
        <img class="empty-state-mark" src="/img/care-mark.svg" alt=""/>
        <div class="empty-state-text">no groups yet.</div>
        <a href="/admin/cycles/new" class="btn btn-primary">${icon('plus')}Create Group</a>
      </div>`}
    </div>`, req);
}

function cycleFormPage(req) {
  return adminShell('New Group', `
    <div class="page-header">
      <div><div class="page-title">new group.</div>
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
          <button class="btn btn-primary" type="submit">${icon('plus')}Create Group</button>
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
    const failedTo = (req.failedEmails || []).length ? ` The email to ${failedEmailsList(req.failedEmails)} didn't send. Check the address, then click Send Invites again to try again.` : ' Failures are usually a bad email address or a sending limit. Click Send Invites again to retry the ones that did not go.';
    flash = failed
      ? `<div class="flash flash-warn" role="alert"><strong>${sent} invitation${sent===1?'':'s'} sent, ${failed} failed.</strong>${failedTo}</div>`
      : `<div class="flash flash-ok" role="status">${sent} invitation${sent===1?'':'s'} sent.</div>`;
  } else if (req.query.datesUpdated === '1') {
    flash = `<div class="flash flash-ok" role="status">Dates updated.</div>`;
  }

  const rows = leaders.map(l => {
    const total     = l.raters?.length || 0;
    const completed = l.raters?.filter(r => r.completed_at).length || 0;
    const pct       = total ? Math.round(completed/total*100) : 0;
    return `<tr>
      <td><span class="person">${avatar(l.name)}<a href="/admin/leaders/${l.id}">${l.name}</a></span></td>
      <td style="color:var(--grey)">${l.title || '&mdash;'}</td>
      <td style="color:var(--grey)">${l.department || '&mdash;'}</td>
      <td>${total}</td>
      <td><div class="progress-wrap"><div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div><span class="progress-label">${completed}/${total}</span></div></td>
      <td class="row-actions"><div class="actions-row">
        <a href="/admin/leaders/${l.id}" class="btn btn-ghost btn-sm">Manage${icon('arrow-right')}</a>
        <form method="POST" action="/admin/leaders/${l.id}/send-invites" style="display:inline">
          <button class="btn btn-sage btn-sm" type="submit">${icon('send')}Send Invites</button>
        </form>
      </div></td>
    </tr>`;
  }).join('');

  return adminShell(cycle.name, `
    <div class="page-header">
      <div>
        <div class="page-title">${cycle.name}</div>
        <div class="page-sub page-meta"><span class="badge badge-${cycle.status}">${cycle.status}</span>${closesChip(cycle)}${cycle.client_name ? `<span>${cycle.client_name}</span>` : ''}</div>
      </div>
      <div class="actions-row">
        ${statusBtns.map(([s,l]) => `<form method="POST" action="/admin/cycles/${cycle.id}/status" style="display:inline"><input type="hidden" name="status" value="${s}"/><button class="btn ${s==='active'?'btn-sage':s==='closed'?'btn-red':'btn-ghost'}" type="submit">${icon({ active: 'play', closed: 'circle-x', draft: 'rotate' }[s])}${l}</button></form>`).join('')}
        ${cycle.status === 'draft' ? `<a href="/admin/cycles/${cycle.id}/custom-questions" class="btn btn-ghost">${icon('list-checks')}Custom Questions</a>` : ''}
        <a href="/admin/cycles/${cycle.id}/leaders/new" class="btn btn-primary">${icon('plus')}Add Leader</a>
      </div>
    </div>
    ${flash}
    ${cycle.status === 'draft' && leaders.length ? `
    <div class="card alert-card">
      <div style="font-size:14px;font-weight:600;color:#A94442;margin-bottom:6px">This Group is not active</div>
      <div style="font-size:13px;color:var(--grey);line-height:1.7;margin-bottom:14px">Raters will not be able to open their survey until you activate this Group. If you send invites now, everyone will receive a link that does not work.</div>
      <form method="POST" action="/admin/cycles/${cycle.id}/status"><input type="hidden" name="status" value="active"/><button class="btn btn-sage" type="submit">${icon('play')}Activate Group</button></form>
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
          <button class="btn btn-primary" type="submit">${icon('calendar')}Save Dates</button>
        </div>
      </form>
    </div>
    <div class="card">
      <div class="card-header"><span class="card-title">Leaders</span><span class="card-meta">${leaders.length} leader${leaders.length!==1?'s':''}</span></div>
      ${leaders.length ? `
      <table class="data-table">
        <thead><tr><th>Leader</th><th>Title</th><th>Department</th><th>Raters</th><th>Responses</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : `
      <div class="empty-state"><img class="empty-state-mark" src="/img/care-mark.svg" alt=""/><div class="empty-state-text">no leaders yet.</div><a href="/admin/cycles/${cycle.id}/leaders/new" class="btn btn-primary">${icon('plus')}Add First Leader</a></div>`}
    </div>`, req);
}

function leaderFormPage(cycleId, req) {
  return adminShell('Add Leader', `
    <div class="page-header"><div>
      <div class="page-title">add a leader.</div>
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
    <button type="button" class="remove-rater-btn" onclick="this.closest('.rater-row').remove()" aria-label="Remove this row">${icon('x')}</button>
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
      <div class="page-title">add raters.</div>
      <div class="page-sub">Adding raters for <strong>${leader.name}</strong>. Each person receives a unique anonymous survey link.</div>
    </div></div>
    ${error ? `<div class="flash flash-warn">${error}</div>` : ''}
    <div class="card">
      <form method="POST" action="/admin/leaders/${leader.id}/raters" id="rater-form">
        <div class="form-section">
          <div class="form-section-title">Rater Information</div>
          <div class="rater-row-header"><span>Full Name *</span><span>Email Address *</span><span>Relationship to Leader *</span><span></span></div>
          <div class="rater-rows" id="rater-rows">${initialRows}</div>
          <button type="button" class="add-rater-btn" onclick="addRaterRow()">${icon('user-plus')}Add Another Rater</button>
          <div class="form-hint" style="margin-top:10px">All three fields are required for each rater you add. Leave a row completely blank to skip it. Three completed rater responses are needed before a report can be generated, and the self-assessment does not count toward that.</div>
        </div>
        <div class="actions-row" style="margin-top:8px">
          <button class="btn btn-primary" type="submit">${icon('check')}Save Raters</button>
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
        <button type="button" class="remove-rater-btn" onclick="this.closest('.rater-row').remove()" aria-label="Remove this row">${icon('x')}</button>
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
    <td><span class="person">${avatar(r.name)}${r.name}</span></td>
    <td>${r.email}</td>
    <td><span class="badge badge-${r.rater_group}">${r.rater_group.replace(/_/g,' ')}</span></td>
    <td>${r.email_sent_at ? '<span class="sent">' + icon('check') + 'Sent ' + new Date(r.email_sent_at).toLocaleDateString('en-US',{month:'short',day:'numeric'}) + '</span>' : '<span style="color:#ccc">Not sent</span>'}</td>
    <td><span class="badge ${r.completed_at?'badge-complete':'badge-pending'}">${r.completed_at?'Complete':'Pending'}</span></td>
    <td class="row-actions"><div class="actions-row">
      <a href="${process.env.APP_URL||''}/survey/${r.token}" target="_blank" class="btn btn-ghost btn-sm">${icon('external-link')}Open Link</a>
      ${!r.completed_at?`<form method="POST" action="/admin/raters/${r.id}/delete" style="display:inline" onsubmit="return confirm('Remove this rater?')"><button class="btn btn-red btn-sm">${icon('trash')}Remove</button></form>`:''}
    </div></td>
  </tr>`).join('');

  return adminShell(leader.name, `
    <div class="page-header">
      <div>
        <a href="/admin/cycles/${leader.cycle_id}" style="color:var(--clay);font-size:13px;font-weight:600;text-decoration:none;display:inline-block;margin-bottom:10px">${icon('arrow-left')} Back to ${leader.cycles ? leader.cycles.name : 'Group'}</a>
        <div class="page-title">${leader.name}</div>
        <div class="page-sub">${leader.title||''}${leader.department?' &nbsp;·&nbsp; '+leader.department:''}</div>
      </div>
      <div class="actions-row">
        <form method="POST" action="/admin/leaders/${leader.id}/send-invites"><button class="btn btn-ghost" type="submit">${icon('send')}Send Invites</button></form>
        <a href="/admin/leaders/${leader.id}/raters/new" class="btn ${raterCompleted>=3?'btn-ghost':'btn-primary'}">${icon('user-plus')}Add Raters</a>
        ${raterCompleted>=3
          ? `<form method="POST" action="/admin/leaders/${leader.id}/generate-report" onsubmit="this.querySelector('button').disabled=true;this.querySelector('button').textContent='Generating report… (30–60 sec)'"><button class="btn btn-sage keep-label" type="submit">${icon('sparkles')}${report ? 'Regenerate Report' : 'Generate Report'}</button></form>`
          : `<span class="btn btn-locked" aria-disabled="true" title="The report unlocks after 3 rater responses. The self-assessment doesn't count.">${icon('lock')}Report<span class="lock-count">${raterCompleted} of 3</span><span class="lock-bar"><i style="width:${Math.round(Math.min(raterCompleted, 3) / 3 * 100)}%"></i></span></span>`}
        <details class="menu">
          <summary class="btn btn-ghost btn-icon" aria-label="More actions">${icon('more')}</summary>
          <div class="menu-list">
            ${report ? `<a href="/report/pdf/${report.id}" class="menu-item" target="_blank" rel="noopener">${icon('download')}Download PDF report</a>` : `<span class="menu-item menu-item-off">${icon('download')}PDF report<small>after the report runs</small></span>`}
            <a href="/CARE_360_Leadership_Action_Plan.pptx" class="menu-item" download>${icon('presentation')}Action plan template</a>
          </div>
        </details>
      </div>
    </div>
    <div class="stats-row">
      <div class="stat-card">${icon('users')}<div class="stat-num">${totalCount}</div><div class="stat-lbl">Total Raters</div>${statBar(totalCount - completedCount, totalCount, 'ochre')}</div>
      <div class="stat-card">${icon('check-circle')}<div class="stat-num">${completedCount}</div><div class="stat-lbl">Completed</div>${statBar(completedCount, totalCount, 'sage')}</div>
      <div class="stat-card stat-card-ring"><div><div class="stat-num">${pct}<small>%</small></div><div class="stat-lbl">Response Rate</div></div>${ring(pct)}</div>
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
      <div class="empty-state"><img class="empty-state-mark" src="/img/care-mark.svg" alt=""/><div class="empty-state-text">no raters yet.</div><a href="/admin/leaders/${leader.id}/raters/new" class="btn btn-primary">${icon('plus')}Add Raters</a></div>`}
    </div>`, req);
}

module.exports = router;
// Exposed so other routers (guide.js) can render through the exact same
// shell, real nav and real switcher included, instead of keeping their
// own separate copy that silently stops matching this one.
module.exports.adminShell = adminShell;
module.exports.escapeHtml = escapeHtml;
module.exports.avatar = avatar;
