const express  = require('express');
const router   = express.Router();
const supabase = require('../db/client');

// This is the one place that deliberately looks across accounts, so it
// uses the service client rather than the signed in user's connection.
// It shows metadata only. No scores, no comments, no feedback content.

const OWNER = (process.env.OWNER_EMAIL || process.env.ADMIN_EMAIL || '').toLowerCase();

// No plan has a size limit, so leader count never flags an account.
const ORG_CEILING    = 3;   // distinct client organizations on a single account

function requireOwner(req, res, next) {
  const email = req.session && req.session.email ? req.session.email.toLowerCase() : null;
  if (email && OWNER && email === OWNER) return next();
  res.redirect('/admin');
}

router.get('/', requireOwner, async (req, res) => {
  const [
    { data: accounts }, { data: users }, { data: cycles }, { data: leaders }, { data: reports },
    { data: organizations }, { data: elementTeams }, { data: people }, { data: elementSessions }, { data: elementRoles }
  ] = await Promise.all([
    supabase.from('accounts').select('*').order('created_at', { ascending: false }),
    supabase.from('account_users').select('account_id, email, name, created_at'),
    supabase.from('cycles').select('id, account_id, client_name, status'),
    supabase.from('leaders').select('id, account_id, cycle_id, created_at'),
    supabase.from('reports').select('id, account_id, generated_at'),
    // Element Profile's tables key off organization_id, not account_id
    // directly the way cycles/leaders/reports do, so organizations is
    // queried purely as the bridge used to credit each org's activity
    // back to the account that owns it, below.
    supabase.from('organizations').select('id, account_id'),
    supabase.from('element_teams').select('id, organization_id'),
    supabase.from('people').select('id, organization_id'),
    supabase.from('element_sessions').select('id, organization_id, completed_at').not('completed_at', 'is', null),
    supabase.from('element_roles').select('id, organization_id')
  ]);

  const byAccount = {};
  (accounts || []).forEach(a => {
    byAccount[a.id] = {
      ...a,
      users: [], surveys: 0, activeSurveys: 0, leaders: 0, activeLeaders: 0, reports: 0,
      orgs: new Set(), lastActivity: null,
      epTeams: 0, epPeople: 0, epAssessments: 0, epRoles: 0
    };
  });

  (users   || []).forEach(u => { if (byAccount[u.account_id]) byAccount[u.account_id].users.push(u); });
  const activeCycle = new Set((cycles || []).filter(c => c.status === 'active').map(c => c.id));
  (cycles  || []).forEach(c => {
    const a = byAccount[c.account_id]; if (!a) return;
    a.surveys++;
    if (c.status === 'active') a.activeSurveys++;
    if (c.client_name && c.client_name.trim()) a.orgs.add(c.client_name.trim().toLowerCase());
  });
  (leaders || []).forEach(l => {
    const a = byAccount[l.account_id]; if (!a) return;
    a.leaders++;
    if (activeCycle.has(l.cycle_id)) a.activeLeaders++;
    if (!a.lastActivity || l.created_at > a.lastActivity) a.lastActivity = l.created_at;
  });
  (reports || []).forEach(r => {
    const a = byAccount[r.account_id]; if (!a) return;
    a.reports++;
    if (r.generated_at && (!a.lastActivity || r.generated_at > a.lastActivity)) a.lastActivity = r.generated_at;
  });

  // Bridges organization_id -> account_id for the four Element Profile
  // aggregations below. An account with more than one organizations row
  // (none do today) would simply sum across all of them.
  const orgToAccount = {};
  (organizations || []).forEach(o => { orgToAccount[o.id] = o.account_id; });

  (elementTeams || []).forEach(t => {
    const a = byAccount[orgToAccount[t.organization_id]]; if (!a) return;
    a.epTeams++;
  });
  (people || []).forEach(p => {
    const a = byAccount[orgToAccount[p.organization_id]]; if (!a) return;
    a.epPeople++;
  });
  (elementSessions || []).forEach(s => {
    const a = byAccount[orgToAccount[s.organization_id]]; if (!a) return;
    a.epAssessments++;
  });
  (elementRoles || []).forEach(r => {
    const a = byAccount[orgToAccount[r.organization_id]]; if (!a) return;
    a.epRoles++;
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
  if (r.orgs.size >= ORG_CEILING)                 out.push(['multi', r.orgs.size + ' orgs']);
  if (r.plan === 'trial' && r.leaders === 0)      out.push(['cold',  'Not started']);
  if (r.plan === 'trial' && r.reports > 0)        out.push(['warm',  'Ran a report']);

  return out;
}

// Driven only by the account's real has_care360/has_element_profile
// flags, not the legacy accounts.plan column (which was never reliably
// updated once Element Profile got its own subscriptions).
function productFor(r) {
  if (r.has_care360 && r.has_element_profile) return ['bundle', 'Bundle'];
  if (r.has_care360)                          return ['care360', 'CARE 360'];
  if (r.has_element_profile)                  return ['element', 'Element Profile'];
  return ['none', 'None'];
}

function hqPage(d) {
  const rows = d.rows.map(r => {
    const flags = flagsFor(r).map(([k, label]) => `<span class="flag flag-${k}">${label}</span>`).join(' ');
    const email = r.users.length ? r.users[0].email : '<span style="color:#c9c9c9">no user</span>';
    const [productKey, productLabel] = productFor(r);
    return `<tr>
      <td>
        <div class="acct">${r.name}</div>
        <div class="acct-email">${email}</div>
      </td>
      <td><span class="product product-${productKey}">${productLabel}</span></td>
      <td><span class="plan plan-${r.plan}">${r.plan}</span>${r.is_coach ? ' <span class="plan plan-coach">coach</span>' : ''}</td>
      <td>${fmt(r.created_at)}</td>
      <td class="num">${r.surveys}</td>
      <td class="num">${r.leaders}<div class="sub-num">${r.activeLeaders} active</div></td>
      <td class="num">${r.orgs.size}</td>
      <td class="num">${r.reports}</td>
      <td class="num">${r.epTeams}</td>
      <td class="num">${r.epPeople}</td>
      <td class="num">${r.epAssessments}</td>
      <td class="num">${r.epRoles}</td>
      <td>${ago(r.lastActivity)}</td>
      <td>${flags || ''}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>HQ | CARE 360</title>
<link rel="icon" type="image/svg+xml" href="/img/care-mark.svg"/>
<style>
@import url('https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;500;600&family=Noto+Sans:wght@400;500;600;700&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--ink:#30383B;--clay:#A9633D;--clay-dark:#925433;--clay-tint:#F7ECE5;--ochre:#A87B2C;--ochre-light:#E3C785;--ochre-tint:#FBF5E6;--ochre-line:#EEDFB8;--sage:#7C8863;--sage-tint:#EEF1E8;--danger:#A94442;--danger-tint:#FBEFED;--sand:#D9CBB2;--cream:#F7F3EA;--wash:#FAF8F4;--warm:#EDE8DF;--grey:#637074;--line:rgba(48,56,59,0.09);--line-strong:rgba(48,56,59,0.18);--shadow:0 1px 2px rgba(48,56,59,0.04),0 2px 10px rgba(48,56,59,0.04);--shadow-lift:0 2px 4px rgba(48,56,59,0.05),0 14px 32px rgba(48,56,59,0.09);--ease:cubic-bezier(.2,.7,.2,1)}
@keyframes igc-rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
:focus-visible{outline:2px solid var(--clay);outline-offset:2px}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
body{font-family:'Noto Sans',Arial,sans-serif;background:#ffffff;color:var(--ink);font-size:14px;line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:var(--ink);text-decoration:none}
.top{background:rgba(255,255,255,0.78);-webkit-backdrop-filter:saturate(180%) blur(16px);backdrop-filter:saturate(180%) blur(16px);height:72px;display:flex;align-items:center;padding:0 40px;gap:24px;box-shadow:0 1px 0 var(--line);position:sticky;top:0;z-index:100}
.top-mark{width:30px;height:30px;display:block}
.top-brand{color:var(--ink);font-weight:500;font-size:23px;font-family:'EB Garamond',Georgia,serif;letter-spacing:-0.5px}
.top-logo{display:flex;align-items:center;gap:10px}
.top-tag{color:var(--ochre);font-size:12px;font-weight:600;background:var(--ochre-tint);border:1px solid var(--ochre-line);padding:3px 10px;border-radius:999px}
.top-spacer{flex:1}
.top-link{color:var(--ink);font-size:14px;opacity:.78;text-transform:lowercase}
.top-link:hover{opacity:1;text-decoration:underline;text-decoration-color:var(--clay);text-underline-offset:6px}
.wrap{max-width:1240px;margin:0 auto;padding:52px 40px 96px;animation:igc-rise .55s var(--ease) both}
.h1{font-family:'EB Garamond',Georgia,serif;font-size:50px;font-weight:500;letter-spacing:-1.8px;line-height:1.08;margin-bottom:8px}
.lede{font-size:15px;color:var(--grey);margin-bottom:30px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:16px;margin-bottom:20px}
.stat{background:#ffffff;border:1px solid var(--line);border-radius:20px;padding:22px 24px;box-shadow:var(--shadow);transition:transform .25s var(--ease),box-shadow .25s var(--ease)}
.stat:hover{transform:translateY(-2px);box-shadow:var(--shadow-lift)}
.stat-n{font-family:'EB Garamond',Georgia,serif;font-size:50px;font-weight:500;line-height:.95;letter-spacing:-1.4px;font-feature-settings:"lnum" 1,"tnum" 1}
.stat-l{text-transform:lowercase;font-size:13px;font-weight:500;color:var(--grey);margin-top:8px}
.card{background:#ffffff;border:1px solid var(--line);border-radius:20px;padding:28px 30px;overflow-x:auto;box-shadow:var(--shadow)}
.card-title{text-transform:lowercase;font-family:'EB Garamond',Georgia,serif;font-size:26px;font-weight:500;letter-spacing:-0.5px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{background:transparent;color:var(--grey);padding:0 12px 12px;text-align:left;font-size:11.5px;font-weight:600;letter-spacing:.05em;text-transform:lowercase;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:13px 12px;border-bottom:1px solid var(--line);font-size:13.5px;vertical-align:top}
tr:last-child td{border-bottom:none}
tbody tr:hover td{background:var(--wash)}
.num{text-align:center;font-variant-numeric:tabular-nums}
.acct{font-weight:600}
.acct-email{font-size:12px;color:var(--grey);margin-top:2px}
.plan{display:inline-block;padding:3px 11px;border-radius:999px;font-size:12px;font-weight:500;text-transform:lowercase}
.plan-trial{background:var(--ochre-tint);color:var(--ochre)}
.plan-starter{background:var(--sage-tint);color:#56603F}
.plan-growth{background:var(--clay-tint);color:var(--clay-dark)}
.plan-coach{background:var(--ink);color:var(--cream)}
.sub-num{font-size:11px;color:var(--grey);font-weight:400;white-space:nowrap}
.plan-community{background:#E3E7EA;color:#3D5A7A}
.plan-enterprise{background:var(--ink);color:var(--cream)}
.product{display:inline-block;padding:3px 11px;border-radius:999px;font-size:12px;font-weight:500;white-space:nowrap}
.product-bundle{background:var(--ink);color:var(--cream)}
.product-care360{background:var(--clay-tint);color:var(--clay-dark)}
.product-element{background:#E3E5E5;color:var(--ink)}
.product-none{background:#E9E6E0;color:var(--grey)}
.flag{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:500;white-space:nowrap;margin-bottom:3px}
.flag-multi{background:#E3E7EA;color:#3D5A7A}
.flag-cold{background:#E9E6E0;color:var(--grey)}
.flag-warm{background:var(--sage-tint);color:#56603F}
.legend{margin-top:20px;font-size:13px;color:var(--grey);line-height:1.9}
@media(max-width:800px){.top{padding:0 16px;gap:14px}.wrap{padding:28px 16px}td,th{padding:8px}}
</style></head><body>

<div class="top">
  <div class="top-logo">
    <img class="top-mark" src="/img/care-mark.svg" alt=""/>
    <span class="top-brand">care 360</span>
  </div>
  <span class="top-tag">HQ</span>
  <div class="top-spacer"></div>
  <a href="/admin" class="top-link">Back to surveys</a>
  <a href="/signout" class="top-link">Sign out</a>
</div>

<div class="wrap">
  <div class="h1">accounts.</div>
  <p class="lede">Everyone using care 360, and how far they have actually got. Metadata only, no feedback content.</p>

  <div class="stats">
    <div class="stat"><div class="stat-n">${d.total}</div><div class="stat-l">Total accounts</div></div>
    <div class="stat"><div class="stat-n">${d.paying}</div><div class="stat-l">Paying</div></div>
    <div class="stat"><div class="stat-n">${d.trials}</div><div class="stat-l">On trial</div></div>
    <div class="stat"><div class="stat-n">${d.newThisMonth}</div><div class="stat-l">New in 30 days</div></div>
    <div class="stat"><div class="stat-n" style="color:var(--clay)">${d.dormant}</div><div class="stat-l">Trials not started</div></div>
  </div>

  <div class="card">
    <div class="card-title">All accounts</div>
    <table>
      <thead><tr>
        <th>Account</th><th>Product</th><th>Plan</th><th>Signed up</th>
        <th class="num">Surveys</th><th class="num">Leaders</th><th class="num">Orgs</th><th class="num">Reports</th>
        <th class="num">EP Teams</th><th class="num">EP People</th><th class="num">EP Assessments</th><th class="num">EP Roles</th>
        <th>Last activity</th><th>Flags</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <div class="legend">
      <strong>Not started</strong> is a trial that signed up but never added a leader. Worth a follow up email.<br/>
      <strong>Ran a report</strong> is a trial that completed a full 360. The best conversion conversation you will get.<br/>
      <strong>Multiple orgs</strong> means the account is running 360s for more than ${ORG_CEILING - 1} client organizations, which may mean a coach or consultant who belongs on coach pricing.<br/>
      <strong>Product</strong> is read straight from the account's real has_care360/has_element_profile flags, not the Plan badge: <strong>Bundle</strong> has both, <strong>CARE 360</strong> and <strong>Element Profile</strong> have just the one. The four EP columns are that product's real team, people, completed-assessment, and role counts, zero for any account that doesn't have it.
    </div>
  </div>
</div>

</body></html>`;
}

// ── Data retention: review and approve ───────────────────────
// Lists every product that's ended, with a dry run of exactly what
// deleting it would remove. Nothing is deleted except by pressing
// Delete on an item that's due, which re-checks it at that moment.

const retention = require('../retention');

const RET_LABEL = { care360: 'CARE 360', element_profile: 'Element Profile' };
const RET_STATUS = {
  due: 'Ready for approval', warned: 'Owner warned', warn: 'Warning goes out today',
  counting: 'Inside its 60 days', deleted: 'Deleted'
};

function retentionPage(items, flash, scan) {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = items.map(i => {
    const counts = i.counts ? Object.entries(i.counts).filter(([, n]) => n > 0).map(([t, n]) => `${t} ${n}`).join(', ') || 'no rows' : '';
    const acct = i.deletesAccount ? `<div style="margin-top:4px;color:#A94442">Also deletes the account and ${i.accountCounts.logins} login(s): ${Object.entries(i.accountCounts).filter(([t, n]) => n > 0 && t !== 'logins').map(([t, n]) => `${t} ${n}`).join(', ')}</div>` : '<div style="margin-top:4px;color:#595959">Account and login stay.</div>';
    // Typing the account name exactly is the confirmation: the server
    // checks it, so a stray click can never delete anything.
    const action = i.status === 'due'
      ? `<form method="POST" action="/hq/retention/delete" style="margin-top:8px">
          <input type="hidden" name="account_id" value="${esc(i.accountId)}"/><input type="hidden" name="product" value="${esc(i.product)}"/>
          <label style="display:block;font-size:12px;color:#595959;margin-bottom:4px">Type <strong>${esc(i.accountName)}</strong> to confirm. This can't be undone.</label>
          <input name="confirm_name" autocomplete="off" required style="padding:7px 9px;border:1px solid rgba(48,56,59,0.22);border-radius:10px;font-size:13px;width:220px;font-family:inherit"/>
          <button style="background:#A94442;color:#fff;border:none;border-radius:999px;padding:8px 16px;font-weight:600;cursor:pointer;font-family:inherit">Delete now</button></form>`
      : '';
    return `<tr><td style="padding:12px;border-bottom:1px solid #EDE8DF;vertical-align:top"><strong>${esc(i.accountName)}</strong><div style="font-size:11px;color:#999">${esc(i.accountId)}</div></td>
      <td style="padding:12px;border-bottom:1px solid #EDE8DF;vertical-align:top">${RET_LABEL[i.product]}<div style="font-size:12px;color:#595959">${esc(i.state)} since ${esc(i.endedOn)}</div></td>
      <td style="padding:12px;border-bottom:1px solid #EDE8DF;vertical-align:top">${RET_STATUS[i.status] || i.status}<div style="font-size:12px;color:#595959">${i.status === 'deleted' ? 'on ' + esc(i.deletedOn) : 'deletion date ' + esc(i.deletionDate)}${i.warnedOn ? ', warned ' + esc(i.warnedOn) : ''}</div></td>
      <td style="padding:12px;border-bottom:1px solid #EDE8DF;vertical-align:top;font-size:12.5px">${counts ? 'Would delete: ' + esc(counts) : ''}${i.counts ? acct : ''}${action}</td></tr>`;
  }).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Data retention | HQ</title><link rel="icon" type="image/svg+xml" href="/img/care-mark.svg"/><link href="https://fonts.googleapis.com/css2?family=EB+Garamond:wght@500&family=Noto+Sans:wght@400;600;700&display=swap" rel="stylesheet"/></head>
  <body style="font-family:'Noto Sans',Arial,sans-serif;background:#fff;color:#30383B;margin:0;padding:48px 20px;line-height:1.6"><div style="max-width:1100px;margin:0 auto">
    <p><a href="/hq" style="color:#A9633D">Back to HQ</a></p>
    <h1 style="font-family:'EB Garamond',Georgia,serif;font-weight:500;font-size:44px;letter-spacing:-1.4px;line-height:1.1;margin:16px 0 10px">Data retention</h1>
    <p style="color:#637074;max-width:720px">Products whose subscription has ended. Data is deleted 60 days after the end date, and only after the owner has had 7 days' warning and you approve it here. The counts are a dry run: nothing is deleted until you press Delete now.</p>
    ${scanLine(scan)}
    ${flash ? `<div style="background:#FBF5E6;border:1px solid #EEDFB8;color:#30383B;border-radius:14px;padding:14px 18px;margin:16px 0">${flash}</div>` : ''}
    ${items.length ? `<table style="width:100%;border-collapse:separate;border-spacing:0;background:#fff;border:1px solid rgba(48,56,59,0.09);border-radius:20px;overflow:hidden;box-shadow:0 1px 2px rgba(48,56,59,0.04),0 2px 10px rgba(48,56,59,0.04)"><tr style="text-align:left;font-size:12px;color:#637074"><th style="padding:12px">Account</th><th style="padding:12px">Product</th><th style="padding:12px">Status</th><th style="padding:12px">What happens</th></tr>${rows}</table>`
      : '<p style="background:#fff;border:1px solid rgba(48,56,59,0.09);box-shadow:0 1px 2px rgba(48,56,59,0.04),0 2px 10px rgba(48,56,59,0.04);padding:20px 22px;border-radius:20px">Nothing has ended. Nothing to review.</p>'}
  </div></body></html>`;
}

// The daily job's last run. Over 26 hours ago means it has stopped.
function scanLine(scan) {
  if (!scan) return '<div style="background:#FBEFED;border:1px solid #F1D3CF;color:#A94442;border-radius:14px;padding:12px 16px;margin:12px 0">The daily retention check has never run.</div>';
  const at = new Date(scan.created_at);
  const stale = Date.now() - at.getTime() > 26 * 60 * 60 * 1000;
  const when = at.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
  return stale
    ? `<div style="background:#FBEFED;border:1px solid #F1D3CF;color:#A94442;border-radius:14px;padding:12px 16px;margin:12px 0"><strong>The daily retention check last ran ${when} UTC, more than a day ago.</strong> It may have stopped. Check the server logs for "Retention run failed".</div>`
    : `<p style="color:#637074;font-size:13px;margin:8px 0 16px">Daily check last ran ${when} UTC.</p>`;
}

async function retentionItems() {
  const assessed = await retention.assessAll();
  const items = [];
  for (const a of assessed) {
    for (const product of retention.PRODUCTS) {
      const s = a.products[product];
      if (!['due', 'warned', 'warn', 'counting', 'deleted'].includes(s.status)) continue;
      const item = { accountId: a.accountId, accountName: a.accountName, product, ...s };
      if (['due', 'warned', 'warn'].includes(s.status)) Object.assign(item, await retention.dryRun(a.accountId, product));
      items.push(item);
    }
  }
  const order = { due: 0, warn: 1, warned: 2, counting: 3, deleted: 4 };
  return items.sort((x, y) => order[x.status] - order[y.status]);
}

router.get('/retention', requireOwner, async (req, res) => {
  try {
    res.send(retentionPage(await retentionItems(), null, await retention.lastScan()));
  } catch (e) {
    console.error('Retention page failed:', e.message);
    res.status(500).send('Could not load data retention right now.');
  }
});

router.post('/retention/delete', requireOwner, async (req, res) => {
  const { account_id: accountId, product, confirm_name: confirmName } = req.body;
  try {
    if (!retention.PRODUCTS.includes(product)) throw new Error('Unknown product.');
    const { data: account } = await supabase.from('accounts').select('name').eq('id', accountId).maybeSingle();
    if (!account) throw new Error('Account not found.');
    if ((confirmName || '').trim() !== account.name.trim()) throw new Error('The account name you typed did not match.');
    const result = await retention.executeDeletion(accountId, product);
    const total = Object.values(result.counts).reduce((a, b) => a + b, 0);
    const flash = `Deleted ${RET_LABEL[product]} data: ${total} rows.${result.canceledInStripe.length ? ` Canceled ${result.canceledInStripe.length} unpaid Stripe subscription(s) first.` : ''}${result.deletesAccount ? ` The account and ${result.accountCounts.logins} login(s) were deleted too.` : ''}`;
    res.send(retentionPage(await retentionItems(), flash, await retention.lastScan()));
  } catch (e) {
    console.error('Retention delete failed:', e.message);
    res.status(400).send(retentionPage(await retentionItems().catch(() => []), `Nothing was deleted: ${e.message}`, await retention.lastScan().catch(() => null)));
  }
});

module.exports = router;
