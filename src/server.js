require('dotenv').config();
const express      = require('express');
const cookieParser = require('cookie-parser');
const path         = require('path');

const surveyRoutes = require('./routes/survey');
const adminRoutes  = require('./routes/admin');
const reportRoutes = require('./routes/reports');
const guideRoutes  = require('./routes/guide');
const accountRoutes = require('./routes/account');
const plansRoutes = require('./routes/plans');
const hqRoutes    = require('./routes/hq');
const { getSession } = require('./auth');
const app = express();

// Signs every auth cookie. A built-in default would let anyone who has
// read this code forge one, so production refuses to start without it.
// Local development gets a random secret for each run instead, which only
// means signing in again after a restart.
if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
  console.error('Missing SESSION_SECRET in the environment. Refusing to start in production without it.');
  process.exit(1);
}
const SESSION_SECRET = process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set: using a random secret for this run, so sign-ins will not survive a restart.');
}

app.set('trust proxy', 1);
app.use((req, res, next) => {
  if (req.originalUrl === '/billing/webhook') return next();
  express.json()(req, res, next);
});
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(SESSION_SECRET));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Cookie-based auth — available to all routes
app.use(async (req, res, next) => {
  try {
    const session = await getSession(req, res);
    if (session) {
      req.session   = session;
      req.accountId = session.accountId;
      req.account   = session.account;
      req.userDb    = session.db;
      req.isAdmin   = true;
      return next();
    }
  } catch (e) {
    console.error('Session check failed:', e.message);
  }
  req.isAdmin = false;
  next();
});
const billing = require('./routes/billing');
const customQuestions = require('./routes/custom-questions');
// Billing access, checked on every signed-in CARE 360 page and form.
const { careAccessGate } = require('./routes/access-gate');
app.use(['/admin', '/report', '/guide'], careAccessGate);

app.use('/billing/webhook', billing.webhookRouter);
app.use('/billing', billing.checkoutRouter);
app.use('/admin', customQuestions);
app.use('/survey', surveyRoutes);
app.use('/admin',  adminRoutes);
app.use('/report', reportRoutes);
app.use('/guide',  guideRoutes);
app.use('/plans', plansRoutes);
app.use('/hq',    hqRoutes);
app.use('/', accountRoutes);
app.get('/', (req, res) => res.redirect('/admin'));
app.get('/health', (req, res) => res.json({ status: 'ok', app: 'CARE360', ts: new Date().toISOString() }));

app.use((req, res) => res.status(404).send(errorPage('Page not found.')));
app.use((err, req, res, next) => { console.error(err); res.status(500).send(errorPage('Something went wrong.')); });

function errorPage(msg) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Error</title>
  <link rel="icon" type="image/svg+xml" href="/img/care-mark.svg"/>
  <link href="https://fonts.googleapis.com/css2?family=EB+Garamond:wght@500&family=Noto+Sans:wght@400;600&display=swap" rel="stylesheet">
  <style>body{font-family:'Noto Sans',Arial,sans-serif;background:radial-gradient(1200px 600px at 50% -10%,#FAF8F4,#fff 70%);color:#30383B;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;-webkit-font-smoothing:antialiased}
  .card{background:#fff;border:1px solid rgba(48,56,59,0.09);box-shadow:0 2px 4px rgba(48,56,59,0.05),0 14px 32px rgba(48,56,59,0.09);border-radius:24px;padding:48px;max-width:440px;text-align:center}
  h2{font-family:'EB Garamond',Georgia,serif;font-weight:500;font-size:40px;letter-spacing:-1.2px;margin:0 0 10px}.p{color:#637074;font-size:15px;line-height:1.7;margin:0 0 24px}
  a{display:inline-block;background:#30383B;color:#F7F3EA;text-decoration:none;font-size:14px;font-weight:600;padding:11px 22px;border-radius:999px}</style></head>
  <body><div class="card"><h2>oops.</h2><p class="p">${msg}</p><a href="/admin">back to care 360</a></div></body></html>`;
}


// ── Hourly check for cycles that have passed their close date ──
const supabase = require('./db/client');
const { sendAdminNotice, sendRaterReminder, resolveNotifyEmail } = require('./email');
const { accessForAccountId, LOCKED_STATES } = require('./access');
const { runDailyRetention } = require('./retention');
const { sendRetentionWarning, sendRetentionSummary, sendRetentionAllClear } = require('./email');

async function checkClosedCycles() {
  try {
    const now = new Date().toISOString();
    const { data: cycles } = await supabase
      .from('cycles')
      .select('id, name, account_id, status, closes_at, closed_notified_at')
      .lt('closes_at', now)
      .eq('status', 'active')
      .is('closed_notified_at', null);

    if (!cycles || !cycles.length) return;

    for (const cycle of cycles) {
      const notifyTo = await resolveNotifyEmail(supabase, cycle.account_id);

      const { data: leaders } = await supabase
        .from('leaders')
        .select('id, name, title, completion_notified_at')
        .eq('cycle_id', cycle.id);

      for (const leader of (leaders || [])) {
        if (leader.completion_notified_at) continue;
        const { data: raters } = await supabase
          .from('raters')
          .select('id, rater_group, completed_at')
          .eq('leader_id', leader.id);
        if (!raters || !raters.length) continue;
        await supabase.from('leaders').update({ completion_notified_at: new Date().toISOString() }).eq('id', leader.id);
        await sendAdminNotice({ leader, cycle, raters, reason: 'closed', to: notifyTo });
      }

      await supabase.from('cycles').update({ closed_notified_at: new Date().toISOString(), status: 'closed' }).eq('id', cycle.id);
      console.log(`Closed-cycle notice sent for ${cycle.name}`);
    }
  } catch (e) {
    console.error('Closed-cycle check failed:', e.message);
  }
}

async function sendReminders() {
  try {
    const now  = new Date();
    const soon = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString();

    const { data: cycles } = await supabase
      .from('cycles')
      .select('id, name, account_id, closes_at')
      .eq('status', 'active')
      .gt('closes_at', now.toISOString())
      .lt('closes_at', soon);

    if (!cycles || !cycles.length) return;

    for (const cycle of cycles) {
      // A locked account's surveys are no longer open, so its raters
      // get no reminder. Past due keeps reminding, since its surveys
      // keep accepting responses.
      let locked = false;
      try {
        locked = LOCKED_STATES.includes(await accessForAccountId(cycle.account_id, 'care360'));
      } catch (e) {
        // Same as the request gate: a failed lookup never stops reminders.
        console.error('Reminder access check failed:', e.message);
      }
      if (locked) continue;

      const { data: leaders } = await supabase
        .from('leaders').select('id, name, title').eq('cycle_id', cycle.id);

      for (const leader of (leaders || [])) {
        const { data: raters } = await supabase
          .from('raters')
          .select('id, name, email, token, rater_group')
          .eq('leader_id', leader.id)
          .is('completed_at', null)
          .is('reminder_sent_at', null)
          .not('email_sent_at', 'is', null);

        for (const rater of (raters || [])) {
          try {
            await supabase.from('raters').update({ reminder_sent_at: new Date().toISOString() }).eq('id', rater.id);
            await sendRaterReminder(rater, leader, cycle);
            console.log(`Reminder sent to ${rater.email}`);
          } catch (e) {
            console.error('Reminder failed for', rater.email, e.message);
          }
        }
      }
    }
  } catch (e) {
    console.error('Reminder check failed:', e.message);
  }
}

// Data retention: warns owners 7 days ahead and emails IGC the list.
// Never deletes anything; deletion only happens from HQ, on approval.
// Checked hourly, but runs at most once per day (recorded in
// retention_log), so restarts never send it twice.
async function retentionTick() {
  try {
    await runDailyRetention({ sendWarning: sendRetentionWarning, sendSummary: sendRetentionSummary, sendAllClear: sendRetentionAllClear });
  } catch (e) {
    console.error('Retention run failed:', e.message);
  }
}

setInterval(retentionTick, 60 * 60 * 1000);
setTimeout(retentionTick, 60 * 1000);
setInterval(checkClosedCycles, 60 * 60 * 1000);
setTimeout(checkClosedCycles, 30 * 1000);
setInterval(sendReminders, 60 * 60 * 1000);
setTimeout(sendReminders, 45 * 1000);
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CARE 360 running on port ${PORT}`));
