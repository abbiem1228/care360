const express   = require('express');
const router    = express.Router();
const supabase  = require('../db/client');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MAX_QUESTIONS = 5;

function db(req) { return req.userDb || supabase; }

function requireAuth(req, res, next) {
  if (req.isAdmin) return next();
  res.redirect('/signin');
}

// Custom questions lock the moment anyone has actually answered one,
// not simply when the Group's status says "active." This matters
// because a Group can be flipped back to draft and forward again
// (to invite a few more raters, say) without that meaning it is safe
// to edit wording that some raters have already responded to. Editing
// after even one response exists would mean different raters answered
// different questions while the report quietly averages them together.
async function hasCustomResponses(req, cycleId) {
  const { data: questions } = await db(req).from('custom_questions').select('id').eq('cycle_id', cycleId);
  const ids = (questions || []).map(q => q.id);
  if (!ids.length) return false;
  const { count } = await db(req).from('custom_responses').select('id', { count: 'exact', head: true }).in('question_id', ids);
  return (count || 0) > 0;
}

// ── View / edit custom questions for a Group ──────────────────
router.get('/cycles/:cycleId/custom-questions', requireAuth, async (req, res) => {
  const { data: cycle } = await db(req).from('cycles').select('*').eq('id', req.params.cycleId).maybeSingle();
  if (!cycle) return res.redirect('/admin');

  const { data: existing } = await db(req).from('custom_questions')
    .select('*').eq('cycle_id', cycle.id).order('position');

  const locked = await hasCustomResponses(req, cycle.id);
  res.send(page(cycle, existing || [], null, null, null, null, locked));
});

// ── Step 1: draft self-assessment wording ──────────────────────
// Takes whatever rater_text fields are filled in, sends them to
// Claude in one call, and re-renders the same page with proposed
// self_text values for the admin to review and edit. Nothing is
// saved to the database at this point.
router.post('/cycles/:cycleId/custom-questions/draft', requireAuth, async (req, res) => {
  const { data: cycle } = await db(req).from('cycles').select('*').eq('id', req.params.cycleId).maybeSingle();
  if (!cycle) return res.redirect('/admin');
  if (await hasCustomResponses(req, cycle.id)) return res.redirect(`/admin/cycles/${cycle.id}/custom-questions`);

  const raterTexts = [].concat(req.body.rater_text || [])
    .map(t => (t || '').trim())
    .slice(0, MAX_QUESTIONS);

  const filled = raterTexts.filter(Boolean);

  if (!filled.length) {
    return res.send(page(cycle, [], null, 'Write at least one question before drafting the self-assessment versions.', raterTexts));
  }

  try {
    const prompt = `You are helping write a leadership 360 feedback survey. Below are custom questions written to be shown to a RATER (someone giving feedback about a leader), written in the third person about the leader.

For each one, write the matching SELF-ASSESSMENT version: the same question rephrased so the leader is describing themselves in the first person. Keep the meaning and the rating scale identical. Keep it to one sentence. Do not add commentary.

Questions:
${filled.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Respond with exactly ${filled.length} lines, one per question, in the same order, with no numbering and no other text.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    });

    const lines = response.content[0].text.trim().split('\n').map(l => l.trim()).filter(Boolean);

    // Map drafted self-text back onto the full 5-slot array, aligned
    // with which rater_text slots were actually filled in.
    const selfTexts = [];
    let li = 0;
    raterTexts.forEach(t => selfTexts.push(t ? (lines[li++] || '') : ''));

    res.send(page(cycle, [], null, null, raterTexts, selfTexts));
  } catch (e) {
    console.error('CUSTOM QUESTION DRAFT FAILED', e.message);
    res.send(page(cycle, [], null, 'Could not draft the self-assessment wording just now. You can write it yourself below, or try again.', raterTexts));
  }
});

// ── Step 2: save ─────────────────────────────────────────────
router.post('/cycles/:cycleId/custom-questions', requireAuth, async (req, res) => {
  const { data: cycle } = await db(req).from('cycles').select('*').eq('id', req.params.cycleId).maybeSingle();
  if (!cycle) return res.redirect('/admin');
  if (await hasCustomResponses(req, cycle.id)) return res.redirect(`/admin/cycles/${cycle.id}/custom-questions`);

  const raterTexts = [].concat(req.body.rater_text || []).map(t => (t || '').trim());
  const selfTexts  = [].concat(req.body.self_text  || []).map(t => (t || '').trim());

  // Check every submitted question against its own real position BEFORE
  // any filtering happens, since a half-filled question (rater text with
  // no self text yet) must be caught here, not silently dropped.
  const hasUnpaired = raterTexts.slice(0, MAX_QUESTIONS).some((t, i) => t && !selfTexts[i]);
  if (hasUnpaired) {
    return res.send(page(cycle, [], null, 'Every question needs a self-assessment version before saving. Draft it or write your own for each one.', raterTexts, selfTexts));
  }

  const rows = [];
  for (let i = 0; i < Math.min(raterTexts.length, MAX_QUESTIONS); i++) {
    if (raterTexts[i] && selfTexts[i]) {
      const row = { cycle_id: cycle.id, position: i, rater_text: raterTexts[i], self_text: selfTexts[i] };
      if (req.accountId) row.account_id = req.accountId;
      rows.push(row);
    }
  }

  await db(req).from('custom_questions').delete().eq('cycle_id', cycle.id);
  if (rows.length) {
    const { error } = await db(req).from('custom_questions').insert(rows);
    if (error) {
      console.error('CUSTOM QUESTION SAVE FAILED', error.message);
      return res.send(page(cycle, [], null, 'Something went wrong saving these questions. Please try again.', raterTexts, selfTexts));
    }
  }

  res.redirect(`/admin/cycles/${cycle.id}`);
});

// ── Remove all custom questions from a Group ──────────────────
router.post('/cycles/:cycleId/custom-questions/clear', requireAuth, async (req, res) => {
  const { data: cycle } = await db(req).from('cycles').select('id, status').eq('id', req.params.cycleId).maybeSingle();
  if (!cycle) return res.redirect('/admin');
  if (await hasCustomResponses(req, cycle.id)) return res.redirect(`/admin/cycles/${cycle.id}/custom-questions`);
  await db(req).from('custom_questions').delete().eq('cycle_id', cycle.id);
  res.redirect(`/admin/cycles/${cycle.id}/custom-questions`);
});

// ════════════════════════════════════════════════════════════════
// HTML
// ════════════════════════════════════════════════════════════════

const CSS = `
<style>
@import url('https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--ink:#30383B;--clay:#A9633D;--sage:#7C8863;--sand:#D9CBB2;--cream:#F7F4EF;--warm:#EDE8DF;--grey:#595959;--shadow:0 1px 4px rgba(48,56,59,0.10)}
body{font-family:'Inter',Arial,sans-serif;background:var(--cream);color:var(--ink);font-size:14px}
a{color:var(--clay);text-decoration:none}a:hover{text-decoration:underline}
.admin-nav{background:var(--ink);height:56px;display:flex;align-items:center;padding:0 32px;gap:28px;box-shadow:0 2px 8px rgba(0,0,0,0.2);position:sticky;top:0;z-index:100}
.nav-logo-mark{width:32px;height:32px;background:var(--clay);border-radius:6px;display:flex;align-items:center;justify-content:center;font-weight:700;color:white;font-size:11px;font-family:'EB Garamond',serif}
.nav-brand{color:white;font-weight:600;font-size:15px;font-family:'EB Garamond',serif}
.nav-link{color:rgba(255,255,255,0.6);font-size:13px;font-weight:500}
.nav-link:hover{color:white;text-decoration:none}
.nav-spacer{flex:1}
.admin-main{max-width:820px;margin:0 auto;padding:32px 24px}
.page-title{font-family:'EB Garamond',serif;font-size:26px;font-weight:600;margin-bottom:4px}
.page-sub{font-size:13.5px;color:var(--grey);line-height:1.7;margin-bottom:24px}
.card{background:white;border-radius:10px;padding:24px;margin-bottom:18px;box-shadow:var(--shadow);border:1px solid var(--warm)}
.callout{border-radius:0 6px 6px 0;padding:13px 17px;margin-bottom:20px;font-size:13px;line-height:1.7;color:#454B4E}
.callout-clay{background:#FBF5EC;border-left:4px solid var(--clay)}
.callout-sand{background:var(--cream);border-left:4px solid var(--sand)}
.callout-err{background:#FFF7F6;border-left:4px solid #A94442;color:#A94442}
.q-row{border:1.5px solid var(--sand);border-radius:8px;padding:16px 18px;margin-bottom:12px}
.q-num{font-size:10.5px;font-weight:700;color:var(--clay);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px}
.form-label{display:block;font-size:11.5px;font-weight:600;color:var(--ink);margin-bottom:5px}
.form-control{width:100%;padding:9px 12px;border:1.5px solid var(--sand);border-radius:6px;font-size:13.5px;font-family:inherit;color:var(--ink);background:white;resize:vertical}
.form-control:focus{outline:none;border-color:var(--clay);box-shadow:0 0 0 3px rgba(169,99,61,0.12)}
.form-hint{font-size:11px;color:var(--grey);margin-top:4px}
.self-block{margin-top:12px;padding-top:12px;border-top:1px dashed var(--sand)}
.self-badge{display:inline-block;font-size:9.5px;font-weight:700;color:var(--sage);text-transform:uppercase;letter-spacing:0.6px;background:#EEF5EE;padding:2px 8px;border-radius:10px;margin-bottom:6px}
.actions-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:20px}
.btn{display:inline-flex;align-items:center;gap:7px;padding:10px 18px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;border:none;font-family:inherit;text-decoration:none}
.btn:hover{opacity:0.88;text-decoration:none}
.btn-primary{background:var(--clay);color:white}
.btn-ink{background:var(--ink);color:white}
.btn-ghost{background:var(--warm);color:var(--ink);border:1.5px solid var(--sand)}
.btn-red{background:transparent;color:#A94442;border:1.5px solid #FDDDD9}
.locked{opacity:0.65}
.locked .form-control{background:#F7F4EF;cursor:not-allowed}
@media(max-width:700px){.admin-main{padding:16px 12px}}
</style>`;

function shell(title, content) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title} — CARE 360</title>${CSS}</head><body>
<nav class="admin-nav">
  <div style="display:flex;align-items:center;gap:10px">
    <div class="nav-logo-mark">C</div>
    <span class="nav-brand">in good company.</span>
  </div>
  <a href="/admin" class="nav-link">Groups</a>
  <a href="/guide" class="nav-link">How it works</a>
  <div class="nav-spacer"></div>
  <a href="/signout" class="nav-link">Sign out</a>
</nav>
<div class="admin-main">${content}</div></body></html>`;
}

function page(cycle, existing, _unused, error, draftRaterTexts, draftSelfTexts, locked) {
  locked = !!locked;

  // Figure out what to show in each of the 5 rows: a draft in progress
  // beats saved data, saved data beats a blank row.
  const rows = [];
  for (let i = 0; i < MAX_QUESTIONS; i++) {
    const savedRow = existing.find(q => q.position === i);
    rows.push({
      rater: (draftRaterTexts && draftRaterTexts[i]) || (savedRow ? savedRow.rater_text : ''),
      self:  (draftSelfTexts  && draftSelfTexts[i])  || (savedRow ? savedRow.self_text  : ''),
      hasDraftedSelf: !!(draftSelfTexts && draftSelfTexts[i])
    });
  }

  const anyRaterText = rows.some(r => r.rater);
  const allPaired    = rows.every(r => !r.rater || r.self);

  const rowsHtml = rows.map((r, i) => `
    <div class="q-row ${locked ? 'locked' : ''}">
      <div class="q-num">Question ${i + 1}</div>
      <label class="form-label">What raters see</label>
      <textarea class="form-control" name="rater_text" rows="2" ${locked ? 'readonly' : ''} placeholder="e.g. Models our value of transparency when priorities change">${r.rater}</textarea>
      ${r.self ? `
      <div class="self-block">
        ${r.hasDraftedSelf ? '<div class="self-badge">Drafted, review before saving</div>' : ''}
        <label class="form-label">What the leader sees on their self-assessment</label>
        <textarea class="form-control" name="self_text" rows="2" ${locked ? 'readonly' : ''}>${r.self}</textarea>
      </div>` : `<input type="hidden" name="self_text" value="">`}
    </div>`).join('');

  const body = locked ? `
    <div class="page-title">${cycle.name}</div>
    <div class="page-sub">Custom questions</div>
    <div class="callout callout-sand">This Group is ${cycle.status}, so its custom questions are locked and cannot be changed. This keeps every rater answering the exact same wording.</div>
    <div class="card">${rowsHtml || '<p style="color:var(--grey);font-size:13px">No custom questions were added to this Group.</p>'}</div>
    <a href="/admin/cycles/${cycle.id}" class="btn btn-ghost">Back to Group</a>
  ` : `
    <div class="page-title">${cycle.name}</div>
    <div class="page-sub">Custom questions <span style="color:var(--grey);font-weight:400">&middot; optional, up to ${MAX_QUESTIONS}</span></div>

    <div class="callout callout-clay">
      These add a short section to the report just for this Group, alongside the five CARE sections. They get their own score and are never blended into a CARE score. Write the version a rater sees, describing the leader in the third person. <a href="/guide#custom" target="_blank">Learn more</a>.
    </div>

    ${error ? `<div class="callout callout-err">${error}</div>` : ''}

    <form method="POST" action="/admin/cycles/${cycle.id}/custom-questions${anyRaterText && !allPaired ? '' : ''}" id="cq-form">
      <div class="card">
        ${rowsHtml}
        <div class="form-hint">Leave a question blank to skip it. Empty rows are not saved.</div>
      </div>
      <div class="actions-row">
        ${allPaired && anyRaterText
          ? `<button class="btn btn-primary" type="submit" formaction="/admin/cycles/${cycle.id}/custom-questions">Save custom questions</button>`
          : `<button class="btn btn-primary" type="submit" formaction="/admin/cycles/${cycle.id}/custom-questions/draft">Draft self-assessment versions</button>`}
        <a href="/admin/cycles/${cycle.id}" class="btn btn-ghost">Cancel</a>
        ${existing.length ? `
        <form method="POST" action="/admin/cycles/${cycle.id}/custom-questions/clear" style="display:inline" onsubmit="return confirm('Remove all custom questions from this Group?')">
          <button class="btn btn-red" type="submit">Remove all</button>
        </form>` : ''}
      </div>
    </form>
  `;

  return shell('Custom questions', body);
}

module.exports = router;
