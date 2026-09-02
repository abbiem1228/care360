const express  = require('express');
const router   = express.Router();
const supabase = require('../db/client');
const { nanoid } = require('nanoid');
const { sendRaterInvite } = require('../email');

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
router.get('/', requireAuth, async (req, res) => {
  const { data: cycles } = await db(req).from('cycles').select('*').order('created_at', { ascending: false });
  res.send(dashboardPage(cycles || [], req));
});

// ── Cycles ────────────────────────────────────────────────────
router.get('/cycles/new', requireAuth, (req, res) => res.send(cycleFormPage(req)));

router.post('/cycles', requireAuth, async (req, res) => {
  const { name, description, client_name, opens_at, closes_at } = req.body;
  if (!closes_at) return res.send(adminShell('Error', '<div class="card"><p>A close date is required. <a href="/admin/cycles/new">Go back</a></p></div>', req));
  if (new Date(closes_at) <= new Date()) return res.send(adminShell('Error', '<div class="card"><p>The close date must be in the future. <a href="/admin/cycles/new">Go back</a></p></div>', req));

  const row = { name, description, client_name, opens_at: opens_at || null, closes_at };
  if (req.accountId) row.account_id = req.accountId;

  const { error } = await db(req).from('cycles').insert([row]);
  if (error) {
    console.error('CYCLE CREATE FAILED', error.message);
    return res.send(adminShell('Error', `<div class="card"><p>The survey could not be created. <a href="/admin/cycles/new">Go back</a></p></div>`, req));
  }
  res.redirect('/admin');
});

router.post('/cycles/:id/status', requireAuth, async (req, res) => {
  await db(req).from('cycles').update({ status: req.body.status }).eq('id', req.params.id);
  res.redirect(`/admin/cycles/${req.params.id}`);
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

  // Confirm the survey belongs to this account before adding to it.
  const { data: cycle } = await db(req).from('cycles').select('id').eq('id', req.params.cycleId).maybeSingle();
  if (!cycle) return res.redirect('/admin');
    if (req.account && req.account.plan === 'trial') {
    const { count } = await db(req).from('leaders').select('id', { count: 'exact', head: true });
    if ((count || 0) >= 1) {
      return res.send(adminShell('Trial limit reached', `
        <div class="card" style="border-left:4px solid #A9633D;background:#FBF5EC;max-width:520px">
          <div style="font-size:16px;font-weight:600;color:#30383B;margin-bottom:8px">You've used your free trial</div>
          <div style="font-size:13px;color:var(--grey);line-height:1.75;margin-bottom:18px">Your trial covers one leader, and you've already run one. Upgrade to add more leaders, unlimited surveys, and everything else CARE 360 offers.</div>
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
  const rows   = [];
  for (let i = 0; i < names.length; i++) {
    const n = (names[i]  || '').trim();
    const e = (emails[i] || '').trim();
    const g = (groups[i] || '').trim();
    if (n && e && g) {
      const row = { leader_id: leaderId, name: n, email: e, rater_group: g, token: nanoid(24) };
      if (req.accountId) row.account_id = req.accountId;
      rows.push(row);
    }
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
    return res.send(adminShell('Cannot remove rater', `<div class="card" style="border-left:4px solid #A94442;background:#FFF7F6">
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
@import url('https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--ink:#30383B;--clay:#A9633D;--sage:#7C8863;--sand:#D9CBB2;--cream:#F7F4EF;--warm:#EDE8DF;--white:#ffffff;--grey:#595959;--lgrey:#EAE6DE;--shadow:0 1px 4px rgba(48,56,59,0.10);--shadow-md:0 4px 16px rgba(48,56,59,0.12)}
body{font-family:'Inter',Arial,sans-serif;background:var(--cream);color:var(--ink);font-size:14px}
a{color:var(--clay);text-decoration:none}a:hover{text-decoration:underline}

.admin-nav{background:var(--ink);height:56px;display:flex;align-items:center;padding:0 32px;gap:28px;box-shadow:0 2px 8px rgba(0,0,0,0.2);position:sticky;top:0;z-index:100}
.nav-logo{display:flex;align-items:center;gap:10px}
.nav-logo-mark{width:32px;height:32px;background:var(--clay);border-radius:6px;display:flex;align-items:center;justify-content:center;font-weight:700;color:white;font-size:11px;font-family:'EB Garamond',serif;letter-spacing:0}
.nav-brand{color:white;font-weight:600;font-size:15px;font-family:'EB Garamond',serif;letter-spacing:0.3px}
.nav-link{color:rgba(255,255,255,0.6);font-size:13px;font-weight:500;transition:color 0.15s}
.nav-link:hover{color:white;text-decoration:none}
.nav-spacer{flex:1}
.nav-user{display:flex;align-items:center;gap:9px;color:rgba(255,255,255,0.6);font-size:13px}
.nav-acct{color:rgba(255,255,255,0.85);font-size:13px;font-weight:500;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nav-plan{font-size:9px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;background:rgba(255,255,255,0.14);color:rgba(255,255,255,0.75);padding:3px 7px;border-radius:10px}
.nav-avatar{width:28px;height:28px;border-radius:50%;background:var(--clay);color:white;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0}

.admin-main{max-width:1100px;margin:0 auto;padding:32px 24px}
.page-header{display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:16px;margin-bottom:28px}
.page-title{font-family:'EB Garamond',serif;font-size:28px;font-weight:600;color:var(--ink);margin-bottom:4px}
.page-sub{font-size:14px;color:var(--grey)}

.card{background:white;border-radius:10px;padding:24px;margin-bottom:20px;box-shadow:var(--shadow);border:1px solid var(--warm)}
.card-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}
.card-title{font-family:'EB Garamond',serif;font-size:18px;font-weight:600;color:var(--ink)}

.stats-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin-bottom:24px}
.stat-card{background:white;border-radius:10px;padding:20px;border-left:4px solid var(--clay);box-shadow:var(--shadow)}
.stat-num{font-family:'EB Garamond',serif;font-size:36px;font-weight:600;color:var(--ink);line-height:1}
.stat-lbl{font-size:11px;font-weight:600;color:var(--grey);margin-top:6px;text-transform:uppercase;letter-spacing:0.6px}

.btn{display:inline-flex;align-items:center;gap:7px;padding:9px 18px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;border:none;transition:all 0.15s;line-height:1;font-family:inherit;text-decoration:none}
.btn:hover{opacity:0.88;text-decoration:none}
.btn-primary{background:var(--clay);color:white;box-shadow:0 2px 6px rgba(169,99,61,0.3)}
.btn-ink{background:var(--ink);color:white}
.btn-sage{background:var(--sage);color:white}
.btn-red{background:#A94442;color:white}
.btn-outline{background:transparent;color:var(--clay);border:1.5px solid var(--clay)}
.btn-ghost{background:var(--warm);color:var(--ink);border:1.5px solid var(--sand)}
.btn-sm{padding:6px 12px;font-size:12px}

.data-table{width:100%;border-collapse:collapse}
.data-table th{background:var(--ink);color:rgba(255,255,255,0.9);padding:11px 14px;text-align:left;font-size:11px;font-weight:600;letter-spacing:0.6px;text-transform:uppercase}
.data-table th:first-child{border-radius:6px 0 0 0}.data-table th:last-child{border-radius:0 6px 0 0}
.data-table td{padding:12px 14px;border-bottom:1px solid var(--warm);font-size:13px}
.data-table tr:last-child td{border-bottom:none}
.data-table tr:hover td{background:var(--cream)}

.badge{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px}
.badge::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor}
.badge-draft{background:#F0EDE8;color:#888}
.badge-active{background:#EEF5EE;color:#1A6B36}
.badge-closed{background:#FDECEA;color:#A94442}
.badge-complete{background:#EEF5EE;color:#1A6B36}
.badge-pending{background:#FBF5EC;color:#8B6914}
.badge-self{background:var(--warm);color:var(--ink)}
.badge-supervisor{background:#FDECEA;color:#A94442}
.badge-peer{background:#EEF5EE;color:#1A6B36}
.badge-direct_report{background:#FBF5EC;color:#8B6914}
.badge-skip_level{background:#F0EDE8;color:#595959}

.progress-wrap{display:flex;align-items:center;gap:10px}
.progress-bar{height:6px;background:var(--warm);border-radius:3px;overflow:hidden;width:80px;flex-shrink:0}
.progress-fill{height:100%;background:var(--clay);border-radius:3px;transition:width 0.3s}
.progress-label{font-size:12px;color:var(--grey);white-space:nowrap}

.form-section{margin-bottom:28px}
.form-section-title{font-size:12px;font-weight:600;color:var(--ink);text-transform:uppercase;letter-spacing:0.6px;margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid var(--sand)}
.form-group{margin-bottom:18px}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.form-label{display:block;font-size:12px;font-weight:600;color:var(--ink);margin-bottom:6px}
.form-control{width:100%;padding:9px 12px;border:1.5px solid var(--sand);border-radius:6px;font-size:14px;font-family:inherit;color:var(--ink);background:white;transition:border-color 0.15s,box-shadow 0.15s}
.form-control:focus{outline:none;border-color:var(--clay);box-shadow:0 0 0 3px rgba(169,99,61,0.12)}
select.form-control{cursor:pointer}
.form-hint{font-size:11px;color:var(--grey);margin-top:5px}

.rater-rows{display:flex;flex-direction:column;gap:10px}
.rater-row{display:grid;grid-template-columns:1fr 1fr 180px 40px;gap:10px;align-items:end;background:var(--cream);border-radius:8px;padding:12px 14px;border:1.5px solid var(--sand)}
.rater-row-header{display:grid;grid-template-columns:1fr 1fr 180px 40px;gap:10px;padding:0 14px}
.rater-row-header span{font-size:11px;font-weight:600;color:var(--grey);text-transform:uppercase;letter-spacing:0.5px}
.remove-rater-btn{width:32px;height:32px;border-radius:6px;border:1.5px solid #FDECEA;background:#FDECEA;color:#A94442;cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;transition:all 0.15s;font-family:inherit}
.remove-rater-btn:hover{background:#A94442;color:white}
.add-rater-btn{display:inline-flex;align-items:center;gap:8px;padding:9px 16px;border:1.5px dashed var(--clay);border-radius:6px;color:var(--clay);background:transparent;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit;margin-top:4px;transition:all 0.15s}
.add-rater-btn:hover{background:var(--warm)}

.actions-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.empty-state{text-align:center;padding:48px 24px;color:var(--grey)}
.empty-state-icon{font-size:36px;margin-bottom:12px;opacity:0.4}
.empty-state-text{font-size:14px;margin-bottom:16px}

.flash{border-radius:8px;padding:12px 16px;margin-bottom:18px;font-size:13px;line-height:1.6}
.flash-ok{background:#EEF5EE;border:1px solid #CFE3D2;color:#1A6B36}
.flash-warn{background:#FFF7F6;border:1px solid #FDDDD9;color:#A94442}

@media(max-width:700px){.admin-main{padding:16px 12px}.form-row{grid-template-columns:1fr}.rater-row{grid-template-columns:1fr}.rater-row-header{display:none}.data-table{font-size:12px}.data-table td,.data-table th{padding:8px 10px}.nav-acct{display:none}}
</style>`;

function adminShell(title, content, req) {
  const acct    = req && req.account ? req.account : null;
  const acctName = acct ? acct.name : '';
  const plan     = acct ? acct.plan : '';
  const initial  = acctName ? acctName.trim().charAt(0).toUpperCase() : 'A';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title} — CARE 360</title>${CSS}</head><body>
  <nav class="admin-nav">
    <div class="nav-logo">
      <div class="nav-logo-mark">C</div>
      <span class="nav-brand">in good company.</span>
    </div>
    <a href="/admin" class="nav-link">Surveys</a>
    <a href="/guide" class="nav-link">How it works</a>
    <div class="nav-spacer"></div>
    <div class="nav-user">
      <div class="nav-avatar">${initial}</div>
      ${acctName ? `<span class="nav-acct">${acctName}</span>` : ''}
      ${plan ? `<span class="nav-plan">${plan}</span>` : ''}
      <a href="/signout" class="nav-link">Sign out</a>
    </div>
  </nav>
  <div class="admin-main">${content}</div></body></html>`;
}

function loginPage(error) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Sign In — CARE 360</title>${CSS}
  <style>
  body{display:flex;align-items:center;justify-content:center;min-height:100vh;background:var(--ink)}
  .login-wrap{width:100%;max-width:420px;padding:20px}
  .login-card{background:white;border-radius:14px;padding:48px;box-shadow:0 20px 60px rgba(0,0,0,0.25)}
  .login-logo{display:flex;align-items:center;gap:12px;margin-bottom:36px}
  .login-logo-mark{width:46px;height:46px;background:var(--clay);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:22px;font-family:'EB Garamond',serif;color:white;font-weight:600}
  .login-logo-name{font-family:'EB Garamond',serif;font-size:20px;color:var(--ink);line-height:1.2}
  .login-logo-sub{font-size:12px;color:var(--grey)}
  .login-title{font-family:'EB Garamond',serif;font-size:26px;color:var(--ink);margin-bottom:6px;font-weight:600}
  .login-sub{font-size:14px;color:var(--grey);margin-bottom:28px;line-height:1.6}
  .login-btn{width:100%;padding:13px;background:var(--ink);color:white;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;transition:background 0.15s}
  .login-btn:hover{background:var(--clay)}
  .login-footer{text-align:center;margin-top:28px;font-size:11px;color:var(--grey);letter-spacing:0.5px}
  .alert-error{background:#FFF0EE;color:#A94442;border:1px solid #FDDDD9;border-radius:6px;padding:10px 14px;font-size:13px;margin-bottom:20px}
  </style></head>
  <body><div class="login-wrap"><div class="login-card">
    <div class="login-logo">
      <div class="login-logo-mark">C</div>
      <div>
        <div class="login-logo-name">in good company.</div>
        <div class="login-logo-sub">CARE 360 Leadership Survey</div>
      </div>
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
        <div class="page-title">Surveys</div>
        <div class="page-sub">Manage your CARE 360 survey rounds, leaders, and raters.</div>
      </div>
      <a href="/admin/cycles/new" class="btn btn-primary">+ New Survey</a>
    </div>
    <div class="stats-row">
      <div class="stat-card"><div class="stat-num">${cycles.length}</div><div class="stat-lbl">Total Surveys</div></div>
      <div class="stat-card" style="border-color:var(--sage)"><div class="stat-num" style="color:var(--sage)">${active}</div><div class="stat-lbl">Active</div></div>
      <div class="stat-card" style="border-color:var(--sand)"><div class="stat-num" style="color:var(--grey)">${draft}</div><div class="stat-lbl">Drafts</div></div>
    </div>
    <div class="card">
      <div class="card-header">
        <span class="card-title">All Surveys</span>
        <a href="/admin/cycles/new" class="btn btn-ghost btn-sm">+ New</a>
      </div>
      ${cycles.length ? `
      <table class="data-table">
        <thead><tr><th>Survey Name</th><th>Client / Notes</th><th>Status</th><th>Opens</th><th>Closes</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : `
      <div class="empty-state">
        <div class="empty-state-icon">&#128203;</div>
        <div class="empty-state-text">No surveys yet. Create your first one to get started.</div>
        <a href="/admin/cycles/new" class="btn btn-primary">Create Survey</a>
      </div>`}
    </div>`, req);
}

function cycleFormPage(req) {
  return adminShell('New Survey', `
    <div class="page-header">
      <div><div class="page-title">New Survey</div>
      <div class="page-sub">A survey round groups the leaders being assessed at the same time.</div></div>
    </div>
    <div class="card" style="max-width:580px">
      <form method="POST" action="/admin/cycles">
        <div class="form-group">
          <label class="form-label">Survey Name *</label>
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
          <button class="btn btn-primary" type="submit">Create Survey</button>
          <a href="/admin" class="btn btn-ghost">Cancel</a>
        </div>
      </form>
    </div>`, req);
}

function cycleDetailPage(cycle, leaders, req) {
  const statusBtns = {
    draft:  [['active','Activate'],['closed','Close']],
    active: [['closed','Close'],['draft','Back to Draft']],
    closed: [['active','Re-open'],['draft','Back to Draft']]
  }[cycle.status] || [];

  const sent   = parseInt(req.query.sent   || '0', 10);
  const failed = parseInt(req.query.failed || '0', 10);
  let flash = '';
  if (sent || failed) {
    flash = failed
      ? `<div class="flash flash-warn"><strong>${sent} invitation${sent===1?'':'s'} sent, ${failed} failed.</strong> Failures are usually a bad email address or a sending limit. Check the logs, then click Send Invites again to retry the ones that did not go.</div>`
      : `<div class="flash flash-ok">${sent} invitation${sent===1?'':'s'} sent.</div>`;
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
        <a href="/admin/cycles/${cycle.id}/leaders/new" class="btn btn-primary">+ Add Leader</a>
      </div>
    </div>
    ${flash}
    ${cycle.status === 'draft' && leaders.length ? `
    <div class="card" style="border-left:4px solid #A94442;background:#FFF7F6">
      <div style="font-size:14px;font-weight:600;color:#A94442;margin-bottom:6px">This survey is not active</div>
      <div style="font-size:13px;color:var(--grey);line-height:1.7;margin-bottom:14px">Raters will not be able to open their survey until you activate it. If you send invites now, everyone will receive a link that does not work.</div>
      <form method="POST" action="/admin/cycles/${cycle.id}/status"><input type="hidden" name="status" value="active"/><button class="btn btn-sage" type="submit">Activate Survey</button></form>
    </div>` : ''}
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

function raterRow() {
  return `<div class="rater-row">
    <div><input class="form-control" type="text" name="name" placeholder="Full name"/></div>
    <div><input class="form-control" type="email" name="email" placeholder="email@company.com"/></div>
    <div><select class="form-control" name="rater_group">
      <option value="">Select relationship...</option>
      <option value="supervisor">Supervisor</option>
      <option value="peer">Peer</option>
      <option value="direct_report">Direct Report</option>
      <option value="skip_level">Skip-Level</option>
    </select></div>
    <button type="button" class="remove-rater-btn" onclick="this.closest('.rater-row').remove()">&#215;</button>
  </div>`;
}

function raterFormPage(leader, req) {
  if (!leader) return adminShell('Error', '<p>Leader not found.</p>', req);
  return adminShell('Add Raters', `
    <div class="page-header"><div>
      <div class="page-title">Add Raters</div>
      <div class="page-sub">Adding raters for <strong>${leader.name}</strong>. Each person receives a unique anonymous survey link.</div>
    </div></div>
    <div class="card">
      <form method="POST" action="/admin/leaders/${leader.id}/raters" id="rater-form">
        <div class="form-section">
          <div class="form-section-title">Rater Information</div>
          <div class="rater-row-header"><span>Full Name</span><span>Email Address</span><span>Relationship to Leader</span><span></span></div>
          <div class="rater-rows" id="rater-rows">${[1,2,3].map(() => raterRow()).join('')}</div>
          <button type="button" class="add-rater-btn" onclick="addRaterRow()"><span style="font-size:18px;line-height:1">+</span> Add Another Rater</button>
          <div class="form-hint" style="margin-top:10px">Three completed rater responses are needed before a report can be generated. The self-assessment does not count toward that.</div>
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
        <div><input class="form-control" type="text" name="name" placeholder="Full name"/></div>
        <div><input class="form-control" type="email" name="email" placeholder="email@company.com"/></div>
        <div><select class="form-control" name="rater_group">
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
