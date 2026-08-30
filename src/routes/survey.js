const express  = require('express');
const router   = express.Router();
const supabase = require('../db/client');
const { SECTIONS, SCALE_LABELS } = require('../questions');

// GET /survey/:token
router.get('/:token', async (req, res) => {
  try {
    const { data: rater, error } = await supabase
      .from('raters')
      .select('*, leaders(name, title, cycle_id, cycles(name, status))')
      .eq('token', req.params.token)
      .single();

    if (error || !rater) return res.status(404).send(statusPage('!', 'Link not found', 'This survey link was not found. Please check your email for the correct link.'));
    if (rater.completed_at) return res.send(statusPage('✓', 'Already submitted', `You have already completed the survey for <strong>${rater.leaders.name}</strong>. Thank you for your contribution.`, '#1F6B3A'));
    if (rater.leaders.cycles.status !== 'active') return res.send(statusPage('!', 'Survey not open', 'This survey is not currently open. Please contact your survey administrator.'));

    const isSelf = rater.rater_group === 'self';
    res.send(surveyPage(rater, SECTIONS, isSelf, SCALE_LABELS));

  } catch (err) {
    console.error(err);
    res.status(500).send(statusPage('!', 'Something went wrong', 'Please try again or contact your survey administrator.'));
  }
});

// POST /survey/:token
router.post('/:token', async (req, res) => {
  try {
    const { data: rater, error } = await supabase
      .from('raters')
      .select('*, leaders(name, cycle_id, cycles(status))')
      .eq('token', req.params.token)
      .single();

    if (error || !rater) return res.status(404).send(statusPage('!', 'Invalid link', 'Survey link not found.'));
    if (rater.completed_at) return res.send(statusPage('✓', 'Already submitted', `Already submitted for <strong>${rater.leaders.name}</strong>.`, '#1F6B3A'));
    if (rater.leaders.cycles.status !== 'active') return res.status(400).send(statusPage('!', 'Survey closed', 'This survey is no longer accepting responses.'));

    const body = req.body;
    const raterId  = rater.id;
    const leaderId = rater.leader_id;

    // Build score responses
    const responseRows = [];
    for (const section of SECTIONS) {
      for (const q of section.questions) {
        const score = parseInt(body[`q_${q.n}`]);
        if (score >= 1 && score <= 5) {
          responseRows.push({ rater_id: raterId, leader_id: leaderId, question_number: q.n, section: section.id, score });
        }
      }
    }

    if (responseRows.length < 30) {
      return res.send(statusPage('!', 'Incomplete', `Please answer all 30 questions. You answered ${responseRows.length}.`));
    }

    // Open text
    const openTextRows = SECTIONS
      .map(s => ({ rater_id: raterId, leader_id: leaderId, section: s.id, response: (body[`ot_${s.id}`] || '').trim() || null }))
      .filter(r => r.response);

    // SSC
    const sscRow = {
      rater_id: raterId, leader_id: leaderId,
      start_text:    (body.start    || '').trim() || null,
      stop_text:     (body.stop     || '').trim() || null,
      continue_text: (body.continue || '').trim() || null
    };

    await Promise.all([
      supabase.from('responses').insert(responseRows),
      openTextRows.length ? supabase.from('open_text').insert(openTextRows) : Promise.resolve(),
      supabase.from('start_stop_continue').insert([sscRow])
    ]);

    await supabase.from('raters').update({ completed_at: new Date().toISOString() }).eq('id', raterId);

    res.send(statusPage('✓', 'Thank you', `Your feedback for <strong>${rater.leaders.name}</strong> has been received. Your responses are anonymous and will be included in their development report.`, '#1F6B3A'));

  } catch (err) {
    console.error(err);
    res.status(500).send(statusPage('!', 'Something went wrong', 'Your responses could not be saved. Please try again.'));
  }
});

// ── SURVEY PAGE ───────────────────────────────────────────────────────────────
function surveyPage(rater, sections, isSelf, scaleLabels) {
  const leaderName = rater.leaders.name;
  const groupLabel = {
    self: 'Self Assessment', supervisor: 'Supervisor', peer: 'Peer',
    direct_report: 'Direct Report', skip_level: 'Skip-Level'
  }[rater.rater_group] || rater.rater_group;

  const sectionsHTML = sections.map(s => {
    const questions = s.questions.map(q => {
      const text = isSelf ? q.self : q.rater;
      return `
        <div class="question-block" id="qb-${q.n}">
          <div class="question-text"><span class="q-num">${q.n}.</span>${text}</div>
          <div class="scale-row">
            ${[1,2,3,4,5].map(v => `
              <label class="scale-option">
                <input type="radio" name="q_${q.n}" value="${v}" required>
                <span class="scale-dot"></span>
                <span class="scale-val">${v}</span>
                <span class="scale-lbl">${scaleLabels[v]}</span>
              </label>`).join('')}
          </div>
        </div>`;
    }).join('');

    const otPrompt = isSelf ? s.openTextSelf : s.openTextRater;

    return `
      <div class="survey-section" id="section-${s.id}">
        <div class="section-badge">Section ${s.number} of ${sections.length}</div>
        <h2 class="section-title">${s.title}</h2>
        <p class="section-subtitle">${s.subtitle}</p>
        <div class="questions">${questions}</div>
        <div class="open-text-block">
          <label class="ot-label" for="ot-${s.id}">Open Text (optional)</label>
          <p class="ot-prompt">${otPrompt}</p>
          <textarea id="ot-${s.id}" name="ot_${s.id}" rows="3" placeholder="Share any specific examples or additional context..."></textarea>
        </div>
      </div>
      <div class="section-divider"></div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>CARE 360 Survey</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;500;600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/survey.css"/>
</head>
<body>
<header class="survey-header">
  <div class="header-inner">
    <div class="header-brand">In Good Company &nbsp;·&nbsp; CARE 360</div>
    <div class="header-context">
      <span class="context-label">Evaluating:</span>
      <span class="context-name">${leaderName}</span>
      <span class="context-sep">·</span>
      <span class="context-group">${groupLabel}</span>
    </div>
  </div>
</header>

<div class="survey-container">
  <div class="survey-intro">
    <h1>Your feedback matters.</h1>
    <p>You have been asked to provide CARE 360 feedback for <strong>${leaderName}</strong>. This is a developmental tool — your responses help this leader understand how their leadership lands and where they have the greatest opportunity to grow.</p>
    <p>All responses are <strong>completely anonymous</strong>. Answer based on your direct, observed experience. The open-text sections are optional but are often the most valuable part.</p>
    <div class="scale-legend">
      <div class="legend-title">Rating Scale</div>
      <div class="legend-items">
        ${[1,2,3,4,5].map(v => `<div class="legend-item"><span class="legend-num">${v}</span><span>${scaleLabels[v]}</span></div>`).join('')}
      </div>
    </div>
  </div>

  <form method="POST" action="/survey/${rater.token}" id="survey-form" novalidate>
    ${sectionsHTML}

    <div class="survey-section" id="section-ssc">
      <div class="section-badge">Final Question</div>
      <h2 class="section-title">Start &nbsp;·&nbsp; Stop &nbsp;·&nbsp; Continue</h2>
      <p class="section-subtitle">
        ${isSelf
          ? 'Thinking about your own leadership: what is one thing you want to start doing, one thing to stop, and one thing to continue?'
          : 'Please share one specific thing you would like this leader to start doing, one thing to stop, and one thing to continue. Be specific about the behavior.'}
      </p>
      <div class="ssc-block">
        <div class="ssc-item">
          <label class="ssc-label ssc-start">Start</label>
          <p class="ssc-prompt">${isSelf ? 'Something you want to start doing that would make you more effective.' : 'Something this leader is not doing that would make them more effective.'}</p>
          <textarea name="start" rows="2" placeholder="Describe a specific behavior..."></textarea>
        </div>
        <div class="ssc-item">
          <label class="ssc-label ssc-stop">Stop</label>
          <p class="ssc-prompt">${isSelf ? 'Something you want to stop that is getting in the way.' : 'Something this leader is doing that is getting in the way.'}</p>
          <textarea name="stop" rows="2" placeholder="Describe a specific behavior..."></textarea>
        </div>
        <div class="ssc-item">
          <label class="ssc-label ssc-continue">Continue</label>
          <p class="ssc-prompt">${isSelf ? 'Something you do well and want to keep doing.' : 'Something this leader does well and should keep doing.'}</p>
          <textarea name="continue" rows="2" placeholder="Describe a specific behavior..."></textarea>
        </div>
      </div>
    </div>

    <div class="submit-block">
      <p class="submit-note">Once submitted your responses cannot be changed. Please review before submitting.</p>
      <button type="submit" class="submit-btn" id="submit-btn">Submit My Feedback</button>
      <div id="submit-error" class="submit-error hidden"></div>
    </div>
  </form>
</div>
<script src="/js/survey.js"></script>
</body>
</html>`;
}

function statusPage(icon, title, msg, color = '#A9633D') {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>${title}</title>
  <link href="https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;600&family=Inter:wght@400;500&display=swap" rel="stylesheet">
  <style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',Arial,sans-serif;background:#F7F4EF;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#fff;border-radius:10px;padding:52px 56px;max-width:520px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.08);border-top:4px solid ${color}}
  .icon{font-size:40px;color:${color};margin-bottom:16px;font-family:'EB Garamond',serif}
  .title{font-family:'EB Garamond',serif;font-size:26px;color:#30383B;margin-bottom:12px}
  .msg{font-size:14px;color:#595959;line-height:1.75}
  .brand{margin-top:36px;font-size:11px;color:#bbb;letter-spacing:1px;text-transform:uppercase}</style></head>
  <body><div class="card">
    <div class="icon">${icon}</div>
    <div class="title">${title}</div>
    <div class="msg">${msg}</div>
    <div class="brand">In Good Company Collective &nbsp;·&nbsp; CARE 360</div>
  </div></body></html>`;
}

module.exports = router;
