// ============================================================
// Weekly summary of free Element Profile assessments
//
// Every Monday at 8:00 AM Arizona time, IGC gets one email covering the
// previous Monday to Sunday of free_assessments rows: how many were
// taken, how many opted in to updates, a count by archetype, and a CSV
// of the week's rows (date, email, first name, archetype, opted in).
// No scores, tokens or IP hashes ever leave the database.
//
// It goes out even for an empty week, so a silent inbox never hides a
// job that has stopped. Each week is recorded in free_summary_weeks
// before sending, so restarts or overlapping runs never send it twice;
// a rejected send removes the record and the next run tries again.
// ============================================================

const supabase = require('./db/client');

// Arizona doesn't observe daylight saving, so it's always UTC-7.
const ARIZONA_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SEND_HOUR = 8;
// A run that claimed a week but never finished (the server died
// mid-send) gives the week up after this long.
const STALE_CLAIM_MS = 30 * 60 * 1000;
const FROM = process.env.FROM_EMAIL || 'noreply@ingoodcocollective.com';

const isoDate = d => d.toISOString().slice(0, 10);

// The most recent week whose Monday 8:00 AM send time has passed.
// Returns its Monday (Arizona date) and the UTC range it covers.
function dueWeek(now = new Date()) {
  const local = new Date(now.getTime() - ARIZONA_OFFSET_MS);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  let monday = midnight - ((local.getUTCDay() + 6) % 7) * DAY_MS;
  if (local.getTime() < monday + SEND_HOUR * 60 * 60 * 1000) monday -= 7 * DAY_MS;
  const start = monday - 7 * DAY_MS;
  return {
    weekStart: isoDate(new Date(start)),
    weekEnd: isoDate(new Date(monday - DAY_MS)),
    from: new Date(start + ARIZONA_OFFSET_MS),
    to: new Date(monday + ARIZONA_OFFSET_MS)
  };
}

const arizonaDate = ts => isoDate(new Date(new Date(ts).getTime() - ARIZONA_OFFSET_MS));
const dateLabel = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

async function weekRows(week) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('free_assessments')
      .select('created_at, email, first_name, archetype_key, marketing_opt_in')
      .gte('created_at', week.from.toISOString()).lt('created_at', week.to.toISOString())
      .order('created_at').range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

async function archetypeNames() {
  const { data, error } = await supabase.from('element_archetypes').select('key, name');
  if (error) throw error;
  return Object.fromEntries(data.map(a => [a.key, a.name]));
}

// Quotes every field, and stops a value starting with = + - or @ from
// running as a spreadsheet formula.
function csvField(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

function buildEmail(week, rows, names) {
  const taken = rows.length;
  const optedIn = rows.filter(r => r.marketing_opt_in).length;
  const counts = {};
  for (const r of rows) { const n = names[r.archetype_key] || r.archetype_key; counts[n] = (counts[n] || 0) + 1; }
  const byArchetype = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const range = `${dateLabel(week.weekStart)} to ${dateLabel(week.weekEnd)}, Arizona time`;

  const csv = [['date', 'email', 'first name', 'archetype', 'opted in'], ...rows.map(r => [
    arizonaDate(r.created_at), r.email, r.first_name, names[r.archetype_key] || r.archetype_key, r.marketing_opt_in ? 'yes' : 'no'
  ])].map(cols => cols.map(csvField).join(',')).join('\r\n') + '\r\n';

  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#30383B;line-height:1.6;max-width:560px">
    <p style="margin:0 0 12px">Free Element Profile assessments, ${range}.</p>
    <p style="margin:0">Taken: <strong>${taken}</strong></p>
    <p style="margin:0 0 12px">Opted in to updates: <strong>${optedIn}</strong></p>
    ${taken
      ? `<p style="margin:0 0 4px;font-weight:bold">By archetype</p><ul style="margin:0 0 12px;padding-left:20px">${byArchetype.map(([n, c]) => `<li>${esc(n)}: ${c}</li>`).join('')}</ul><p style="margin:0">The attached CSV lists each one.</p>`
      : '<p style="margin:0">No one took it this week. This email confirms the weekly summary is running.</p>'}
  </div>`;
  const text = `Free Element Profile assessments, ${range}.\n\nTaken: ${taken}\nOpted in to updates: ${optedIn}\n\n${taken
    ? `By archetype\n${byArchetype.map(([n, c]) => `${n}: ${c}`).join('\n')}\n\nThe attached CSV lists each one.`
    : 'No one took it this week. This email confirms the weekly summary is running.'}`;

  return {
    taken, optedIn,
    subject: `free element profile: ${taken} taken, ${optedIn} opted in`,
    html, text,
    attachments: [{ filename: `free-element-profile-${week.weekStart}.csv`, content: Buffer.from(csv).toString('base64') }]
  };
}

// Holds the week for this run. Returns false when it's already sent, or
// another run is sending it right now.
async function claimWeek(weekStart, now) {
  const { error } = await supabase.from('free_summary_weeks').insert({ week_start: weekStart, status: 'sending', claimed_at: now.toISOString() });
  if (!error) return true;
  if (error.code !== '23505') throw error;
  const { data: row, error: readError } = await supabase.from('free_summary_weeks').select('status, claimed_at').eq('week_start', weekStart).maybeSingle();
  if (readError) throw readError;
  if (!row || row.status === 'sent' || now - new Date(row.claimed_at) < STALE_CLAIM_MS) return false;
  // Only one run can take over a stale claim: the update matches the
  // old claimed_at exactly.
  const { data: taken, error: takeError } = await supabase.from('free_summary_weeks')
    .update({ claimed_at: now.toISOString() })
    .eq('week_start', weekStart).eq('status', 'sending').eq('claimed_at', row.claimed_at).select('week_start');
  if (takeError) throw takeError;
  return taken.length === 1;
}

// Sent with fetch rather than the Resend SDK so it can carry an
// Idempotency-Key: if a run dies after Resend accepts the email, the
// run that takes over can't send a second copy. A rejected send is an
// error here, never a quiet success.
async function sendViaResend(weekStart, message) {
  const res = await fetch(`${process.env.RESEND_BASE_URL || 'https://api.resend.com'}/emails`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `free-summary-${weekStart}` },
    body: JSON.stringify(message)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.id) throw new Error(`Resend rejected the summary (${res.status}${body.message ? ': ' + body.message : ''})`);
  return body.id;
}

async function runWeeklyFreeSummary({ now = new Date() } = {}) {
  const week = dueWeek(now);
  const to = process.env.OWNER_EMAIL || process.env.ADMIN_EMAIL;
  if (!to) return { week, skipped: 'no OWNER_EMAIL set' };
  if (!(await claimWeek(week.weekStart, now))) return { week, skipped: 'already sent' };
  try {
    const [rows, names] = await Promise.all([weekRows(week), archetypeNames()]);
    const email = buildEmail(week, rows, names);
    const id = await sendViaResend(week.weekStart, { from: FROM, to, subject: email.subject, html: email.html, text: email.text, attachments: email.attachments });
    const { error } = await supabase.from('free_summary_weeks')
      .update({ status: 'sent', sent_at: new Date().toISOString(), taken: email.taken, opted_in: email.optedIn, resend_id: id })
      .eq('week_start', week.weekStart);
    // Resend has it, so the week stays held either way; a row stuck at
    // 'sending' is taken over later, and the idempotency key stops a resend.
    if (error) console.error('Free summary sent, but recording it failed:', error.message);
    return { week, sent: true, taken: email.taken, optedIn: email.optedIn };
  } catch (e) {
    await supabase.from('free_summary_weeks').delete().eq('week_start', week.weekStart).eq('status', 'sending');
    throw e;
  }
}

// The last few weeks, for HQ.
async function recentWeeks(limit = 8) {
  const { data, error } = await supabase.from('free_summary_weeks').select('*').order('week_start', { ascending: false }).limit(limit);
  if (error) throw error;
  return data;
}

module.exports = { runWeeklyFreeSummary, dueWeek, buildEmail, csvField, recentWeeks };
