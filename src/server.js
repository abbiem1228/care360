require('dotenv').config();
const express      = require('express');
const cookieParser = require('cookie-parser');
const path         = require('path');

const surveyRoutes = require('./routes/survey');
const adminRoutes  = require('./routes/admin');
const reportRoutes = require('./routes/reports');
const guideRoutes  = require('./routes/guide');
const accountRoutes = require('./routes/account');
const app = express();

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(process.env.SESSION_SECRET || 'care360-secret'));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Cookie-based auth — available to all routes
app.use((req, res, next) => {
  req.isAdmin = req.signedCookies && req.signedCookies.adminAuth === 'yes';
  next();
});

app.use('/survey', surveyRoutes);
app.use('/admin',  adminRoutes);
app.use('/report', reportRoutes);
app.use('/guide',  guideRoutes);
app.use('/', accountRoutes);
app.get('/', (req, res) => res.redirect('/admin'));
app.get('/health', (req, res) => res.json({ status: 'ok', app: 'CARE360', ts: new Date().toISOString() }));

app.use((req, res) => res.status(404).send(errorPage('Page not found.')));
app.use((err, req, res, next) => { console.error(err); res.status(500).send(errorPage('Something went wrong.')); });

function errorPage(msg) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Error</title>
  <style>body{font-family:Arial,sans-serif;background:#F7F4EF;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#fff;border-radius:8px;padding:48px;max-width:440px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.08);border-top:4px solid #A9633D}
  h2{color:#30383B;font-size:20px;margin-bottom:10px}.p{color:#595959;font-size:14px}</style></head>
  <body><div class="card"><h2>Oops</h2><p class="p">${msg}</p></div></body></html>`;
}


// ── Hourly check for cycles that have passed their close date ──
const supabase = require('./db/client');
const { sendAdminNotice, sendRaterReminder } = require('./email');
async function checkClosedCycles() {
  try {
    const now = new Date().toISOString();
    const { data: cycles } = await supabase
      .from('cycles')
      .select('id, name, status, closes_at, closed_notified_at')
      .lt('closes_at', now)
      .eq('status', 'active')
      .is('closed_notified_at', null);
    if (!cycles || !cycles.length) return;

    for (const cycle of cycles) {
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
        await sendAdminNotice({ leader, cycle, raters, reason: 'closed' });
      }

        await supabase.from('cycles').update({ closed_notified_at: new Date().toISOString(), status: 'closed' }).eq('id', cycle.id);
      console.log(`Closed-cycle notice sent for ${cycle.name}`);
    }
  } catch (e) {
    console.error('Closed-cycle check failed:', e.message);
  }
}

// ── Remind raters two days before close ──
async function sendReminders() {
  try {
    const now  = new Date();
    const soon = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString();

    const { data: cycles } = await supabase
      .from('cycles')
      .select('id, name, closes_at')
      .eq('status', 'active')
      .gt('closes_at', now.toISOString())
      .lt('closes_at', soon);

    if (!cycles || !cycles.length) return;

    for (const cycle of cycles) {
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

setInterval(sendReminders, 60 * 60 * 1000);
setTimeout(sendReminders, 45 * 1000);
setInterval(checkClosedCycles, 60 * 60 * 1000);
setTimeout(checkClosedCycles, 30 * 1000);
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CARE 360 running on port ${PORT}`));
