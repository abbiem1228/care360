const express  = require('express');
const router   = express.Router();
const supabase = require('../db/client');

// This is the one place that deliberately looks across accounts, so it
// uses the service client rather than the signed in user's connection.
// It shows metadata only. No scores, no comments, no feedback content.

const OWNER = (process.env.OWNER_EMAIL || process.env.ADMIN_EMAIL || '').toLowerCase();

// Where a plan starts to look like it has outgrown its band.
const LEADER_CEILING = { starter: 100, growth: 250, community: 100 };
const ORG_CEILING    = 3;   // distinct client organizations on a single account

function requireOwner(req, res, next) {
  const email = req.session && req.session.email ? req.session.email.toLowerCase() : null;
  if (email && OWNER && email === OWNER) return next();
  res.redirect('/admin');
}

router.get('/', requireOwner, async (req, res) => {
  const [{ data: accounts }, { data: users }, { data: cycles }, { data: leaders }, { data: reports }] =
    await Promise.all([
      supabase.from('accounts').select('*').order('created_at', { ascending: false }),
      supabase.from('account_users').select('account_id, email, name, created_at'),
      supabase.from('cycles').select('id, account_id, client_name, status'),
      supabase.from('leaders').select('id, account_id, created_at'),
      supabase.from('reports').select('id, account_id, generated_at')
    ]);

  const byAccount = {};
  (accounts || []).forEach(a => {
    byAccount[a.id] = {
      ...a,
      users: [], surveys: 0, activeSurveys: 0, leaders: 0, reports: 0,
      orgs: new Set(), lastActivity: null
    };
  });

  (users   || []).forEach(u => { if (byAccount[u.account_id]) byAccount[u.account_id].users.push(u); });
  (cycles  || []).forEach(c => {
    const a = byAccount[c.account_id]; if (!a) return;
    a.surveys++;
    if (c.status === 'active') a.activeSurveys++;
    if (c.client_name && c.client_name.trim()) a.orgs.add(c.client_name.trim().toLowerCase());
  });
  (leaders || []).forEach(l => {
    const a = byAccount[l.account_id]; if (!a) return;
    a.leaders++;
    if (!a.lastActivity || l.created_at > a.lastActivity) a.lastActivity = l.created_at;
  });
  (reports || []).forEach(r => {
    const a = byAccount[r.account_id]; if (!a) return;
    a.reports++;
    if (r.generated_at && (!a.lastActivity || r.generated_at > a.lastActivity)) a.lastActivity = r.generated_at;
  });

  const rows = Object.values(byAccount);

  const now       = new Date();
  const monthAgo  = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const total     = rows.length;
  const trials    = rows.filter(r => r.plan === 'trial').length;
  const paying    = rows.filter(r => ['starter','growth','community','enterprise'].includes(r.plan)).length;
  const newThisMonth = rows.filter(r => new Date(r.created_at) > monthAgo).length;
  const dormant   = rows.filter(r => r.plan === 'trial' && r.leaders === 0).length;

  res.send(hqPage({ rows, total, trials, paying, newThisMonth, dormant }));
});

// ══════════════════════════════════════════════════════════════

function ago(iso) {
  if (!iso) return '<span style="color:#c9c9c9">never</span>';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30)  return days + ' days ago';
  const months = Math.floor(days / 30);
  return months + (months === 1 ? ' month ago' : ' months ago');
}

function fmt(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function flagsFor(r) {
  const out = [];
  const ceiling = LEADER_CEILING[r.plan];

  if (ceiling && r.leaders >= ceiling)            out.push(['over',  'Over band']);
  else if (ceiling && r.leaders >= ceiling * 0.8) out.push(['near',  'Near band']);

  if (r.orgs.size >= ORG_CEILING)                 out.push(['multi', r.orgs.size + ' orgs']);
  if (r.plan === 'trial' && r.leaders === 0)      out.push(['cold',  'Not started']);
  if (r.plan === 'trial' && r.reports > 0)        out.push(['warm',  'Ran a report']);

  return out;
}

function hqPage(d) {
  const rows = d.rows.map(r => {
    const flags = flagsFor(r).map(([k, label]) => `<span class="flag flag-${k}">${label}</span>`).join(' ');
    const email = r.users.length ? r.users[0].email : '<span style="color:#c9c9c9">no user</span>';
    return `<tr>
      <td>
        <div class="acct">${r.name}</div>
        <div class="acct-email">${email}</div>
      </td>
      <td><span class="plan plan-${r.plan}">${r.plan}</span></td>
      <td>${fmt(r.created_at)}</td>
      <td class="num">${r.surveys}</td>
      <td class="num">${r.leaders}</td>
      <td class="num">${r.orgs.size}</td>
      <td class="num">${r.reports}</td>
      <td>${ago(r.lastActivity)}</td>
      <td>${flags || ''}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>HQ — CARE 360</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--ink:#30383B;--clay:#A9633D;--sage:#7C8863;--sand:#D9CBB2;--cream:#F7F4EF;--warm:#EDE8DF;--grey:#595959}
body{font-family:'Inter',Arial,sans-serif;background:var(--cream);color:var(--ink);font-size:14px}
a{color:var(--clay);text-decoration:none}
.top{background:var(--ink);height:56px;display:flex;align-items:center;padding:0 32px;gap:24px}
.top-mark{width:32px;height:32px;background:var(--clay);border-radius:6px;display:flex;align-items:center;justify-content:center;font-weight:700;color:white;font-size:11px;font-family:'EB Garamond',serif}
.top-brand{color:white;font-weight:600;font-size:15px;font-family:'EB Garamond',serif}
.top-tag{color:var(--sand);font-size:10px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;background:rgba(255,255,255,0.12);padding:3px 8px;border-radius:10px}
.top-spacer{flex:1}
.top-link{color:rgba(255,255,255,0.65);font-size:13px;font-weight:500}
.top-link:hover{color:white}
.wrap{max-width:1240px;margin:0 auto;padding:32px 24px 70px}
.h1{font-family:'EB Garamond',serif;font-size:28px;font-weight:600;margin-bottom:4px}
.lede{font-size:13.5px;color:var(--grey);margin-bottom:26px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:26px}
.stat{background:white;border-radius:10px;padding:18px 20px;border-left:4px solid var(--clay);box-shadow:0 1px 4px rgba(48,56,59,.1)}
.stat-n{font-family:'EB Garamond',serif;font-size:32px;font-weight:600;line-height:1}
.stat-l{font-size:10.5px;font-weight:600;color:var(--grey);margin-top:6px;text-transform:uppercase;letter-spacing:.6px}
.card{background:white;border:1px solid var(--warm);border-radius:10px;padding:22px;box-shadow:0 1px 4px rgba(48,56,59,.1)}
.card-title{font-family:'EB Garamond',serif;font-size:18px;font-weight:600;margin-bottom:16px}
table{width:100%;border-collapse:collapse}
th{background:var(--ink);color:rgba(255,255,255,.9);padding:10px 12px;text-align:left;font-size:10.5px;font-weight:600;letter-spacing:.6px;text-transform:uppercase;white-space:nowrap}
th:first-child{border-radius:6px 0 0 0}th:last-child{border-radius:0 6px 0 0}
td{padding:12px;border-bottom:1px solid var(--warm);font-size:13px;vertical-align:top}
tr:last-child td{border-bottom:none}
tr:hover td{background:var(--cream)}
.num{text-align:center;font-variant-numeric:tabular-nums}
.acct{font-weight:600}
.acct-email{font-size:11.5px;color:var(--grey);margin-top:2px}
.plan{display:inline-block;padding:3px 10px;border-radius:20px;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
.plan-trial{background:#F0EDE8;color:#7a7a7a}
.plan-starter{background:#EEF5EE;color:#1A6B36}
.plan-growth{background:#FBF5EC;color:#8B6914}
.plan-community{background:#EDF1F5;color:#3D5A7A}
.plan-enterprise{background:var(--ink);color:white}
.flag{display:inline-block;padding:2px 8px;border-radius:20px;font-size:10.5px;font-weight:600;white-space:nowrap;margin-bottom:3px}
.flag-over{background:#FDECEA;color:#A94442}
.flag-near{background:#FBF5EC;color:#8B6914}
.flag-multi{background:#EDF1F5;color:#3D5A7A}
.flag-cold{background:#F0EDE8;color:#8a8a8a}
.flag-warm{background:#EEF5EE;color:#1A6B36}
.legend{margin-top:18px;font-size:12px;color:var(--grey);line-height:1.9}
@media(max-width:800px){.wrap{padding:18px 12px}td,th{padding:8px}}
</style></head><body>

<div class="top">
  <div class="top-mark">C</div>
  <span class="top-brand">in good company.</span>
  <span class="top-tag">HQ</span>
  <div class="top-spacer"></div>
  <a href="/admin" class="top-link">Back to surveys</a>
  <a href="/signout" class="top-link">Sign out</a>
</div>

<div class="wrap">
  <div class="h1">Accounts</div>
  <p class="lede">Everyone using CARE 360, and how far they have actually got. Metadata only, no feedback content.</p>

  <div class="stats">
    <div class="stat"><div class="stat-n">${d.total}</div><div class="stat-l">Total accounts</div></div>
    <div class="stat" style="border-color:var(--sage)"><div class="stat-n" style="color:var(--sage)">${d.paying}</div><div class="stat-l">Paying</div></div>
    <div class="stat" style="border-color:var(--sand)"><div class="stat-n" style="color:var(--grey)">${d.trials}</div><div class="stat-l">On trial</div></div>
    <div class="stat"><div class="stat-n">${d.newThisMonth}</div><div class="stat-l">New in 30 days</div></div>
    <div class="stat" style="border-color:#A94442"><div class="stat-n" style="color:#A94442">${d.dormant}</div><div class="stat-l">Trials not started</div></div>
  </div>

  <div class="card">
    <div class="card-title">All accounts</div>
    <table>
      <thead><tr>
        <th>Account</th><th>Plan</th><th>Signed up</th>
        <th class="num">Surveys</th><th class="num">Leaders</th><th class="num">Orgs</th><th class="num">Reports</th>
        <th>Last activity</th><th>Flags</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <div class="legend">
      <strong>Not started</strong> is a trial that signed up but never added a leader. Worth a follow up email.<br/>
      <strong>Ran a report</strong> is a trial that completed a full 360. The best conversion conversation you will get.<br/>
      <strong>Near band</strong> means 80% of the expected leader count for the plan. <strong>Over band</strong> means past it.<br/>
      <strong>Multiple orgs</strong> means the account is running 360s for more than ${ORG_CEILING - 1} client organizations, which usually means a consultancy on the wrong plan.
    </div>
  </div>
</div>

</body></html>`;
}

module.exports = router;
