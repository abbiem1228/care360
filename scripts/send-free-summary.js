// Sends the weekly free Element Profile summary once, by hand. Covers
// the latest week whose Monday 8:00 AM send time has passed, and does
// nothing if that week has already been sent.
//
//   node scripts/send-free-summary.js
require('dotenv').config({ quiet: true });
const { runWeeklyFreeSummary } = require('../src/free-summary');

runWeeklyFreeSummary()
  .then(r => console.log(r.sent
    ? `Sent the week of ${r.week.weekStart}: ${r.taken} taken, ${r.optedIn} opted in.`
    : `Nothing sent for the week of ${r.week.weekStart}: ${r.skipped}.`))
  .catch(e => { console.error('Failed, nothing recorded:', e.message); process.exit(1); });
