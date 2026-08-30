const express   = require('express');
const router    = express.Router();
const supabase  = require('../db/client');
const Anthropic = require('@anthropic-ai/sdk');
const { SECTIONS, RATER_GROUP_LABELS } = require('../questions');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Auth middleware (same simple check)
function requireAuth(req, res, next) {
  if (req.isAdmin) return next();
  res.redirect('/admin/login');
}

// ── Generate report ───────────────────────────────────────────
router.get('/generate/:leaderId', requireAuth, async (req, res) => {
  const { leaderId } = req.params;

  try {
    // 1. Load leader + raters
    const { data: leader } = await supabase
      .from('leaders').select('*, cycles(name)').eq('id', leaderId).single();
    if (!leader) return res.status(404).send('Leader not found');

    // 2. Load all score responses
    const { data: responses } = await supabase
      .from('responses').select('*').eq('leader_id', leaderId);

    // 3. Load open text
    const { data: openTexts } = await supabase
      .from('open_text').select('*, raters(rater_group)').eq('leader_id', leaderId);

    // 4. Load start/stop/continue
    const { data: sscData } = await supabase
      .from('start_stop_continue').select('*').eq('leader_id', leaderId);

    // 5. Load raters to know groups
    const { data: raters } = await supabase
      .from('raters').select('id, rater_group, completed_at').eq('leader_id', leaderId).not('completed_at', 'is', null);

    if (!responses || responses.length === 0) {
      return res.send('<h2 style="padding:40px;font-family:Arial">No responses yet. Cannot generate report.</h2>');
    }

    // 6. Build data structure for scoring
    const scoreData = buildScoreData(responses, raters, SECTIONS);

    // 7. Build comment data for AI
    const commentData = buildCommentData(openTexts, sscData, SECTIONS);

    // 8. Call Claude to generate narrative
    const narrative = await generateNarrative(leader, scoreData, commentData);

    // 9. Build the HTML report
    const reportHtml = buildReportHtml(leader, scoreData, narrative, commentData);

    // 10. Save to database
    const { data: saved } = await supabase
      .from('reports')
      .insert([{ leader_id: leaderId, report_html: reportHtml, report_data: { scoreData, narrative }, generated_by: 'ai' }])
      .select().single();

    res.redirect(`/report/view/${saved.id}`);

  } catch (err) {
    console.error('Report generation error:', err);
    res.status(500).send(`<h2 style="padding:40px;font-family:Arial;color:#A94442">Report generation failed: ${err.message}</h2>`);
  }
});

// ── View saved report ─────────────────────────────────────────
router.get('/view/:reportId', async (req, res) => {
  const { data: report } = await supabase
    .from('reports').select('*, leaders(name, title, cycles(name))').eq('id', req.params.reportId).single();
  if (!report) return res.status(404).send('Report not found.');
  res.send(report.report_html);
});

// ═══════════════════════════════════════════════════════════════
// SCORING LOGIC
// ═══════════════════════════════════════════════════════════════

function buildScoreData(responses, raters, sections) {
  // Map rater id -> group
  const raterGroups = {};
  raters.forEach(r => { raterGroups[r.id] = r.rater_group; });

  const groups = ['self','supervisor','peer','direct_report','skip_level'];

  // section -> group -> [scores]
  const sectionScores = {};
  // overall -> group -> [scores]
  const overallScores = {};

  groups.forEach(g => { overallScores[g] = []; });

  sections.forEach(s => {
    sectionScores[s.id] = {};
    groups.forEach(g => { sectionScores[s.id][g] = []; });
  });

  responses.forEach(r => {
    const group = raterGroups[r.rater_id];
    if (!group || !groups.includes(group)) return;
    const section = sections.find(s => s.questions.some(q => q.n === r.question_number));
    if (!section) return;
    if (!sectionScores[section.id]) return;
    if (!sectionScores[section.id][group]) sectionScores[section.id][group] = [];
    if (!overallScores[group]) overallScores[group] = [];
    sectionScores[section.id][group].push(r.score);
    overallScores[group].push(r.score);
  });

  // Calculate averages
  function avg(arr) {
    if (!arr || !arr.length) return null;
    return Math.round((arr.reduce((a,b)=>a+b,0)/arr.length)*100)/100;
  }

  const result = {
    overall: {},
    sections: {},
    blindSpots: [],
    hiddenStrengths: [],
    highScores: [],
    lowScores: []
  };

  groups.forEach(g => {
    result.overall[g] = avg(overallScores[g]);
  });

  sections.forEach(s => {
    result.sections[s.id] = { title: s.title, scores: {} };
    groups.forEach(g => {
      result.sections[s.id].scores[g] = avg(sectionScores[s.id][g]);
    });

    // Blind spots: self >= 4.0, self - others >= 0.5
    const selfScore = result.sections[s.id].scores.self;
    groups.filter(g=>g!=='self').forEach(g => {
      const other = result.sections[s.id].scores[g];
      if (other === null) return;
      if (selfScore !== null && other < 4.0 && (selfScore - other) >= 0.5) {
        result.blindSpots.push({ section: s.title, group: RATER_GROUP_LABELS[g], self: selfScore, other });
      }
      if (selfScore !== null && (other - selfScore) >= 0.5) {
        result.hiddenStrengths.push({ section: s.title, group: RATER_GROUP_LABELS[g], self: selfScore, other });
      }
    });

    // High/low scores (normative thresholds: >= 4.4 = high, <= 3.5 = low)
    groups.filter(g=>g!=='self').forEach(g => {
      const score = result.sections[s.id].scores[g];
      if (score === null) return;
      if (score >= 4.4) result.highScores.push({ section: s.title, group: RATER_GROUP_LABELS[g], score });
      if (score <= 3.5) result.lowScores.push({ section: s.title, group: RATER_GROUP_LABELS[g], score });
    });
  });

  return result;
}

function buildCommentData(openTexts, sscData, sections) {
  const result = {};
  sections.forEach(s => { result[s.id] = []; });

  (openTexts || []).forEach(ot => {
    if (ot.response && result[ot.section] !== undefined) {
      result[ot.section].push({ group: ot.raters?.rater_group || 'unknown', text: ot.response });
    }
  });

  const ssc = { start: [], stop: [], continue: [] };
  (sscData || []).forEach(r => {
    if (r.start_text)    ssc.start.push(r.start_text);
    if (r.stop_text)     ssc.stop.push(r.stop_text);
    if (r.continue_text) ssc.continue.push(r.continue_text);
  });

  return { sections: result, ssc };
}

// ═══════════════════════════════════════════════════════════════
// AI NARRATIVE GENERATION
// ═══════════════════════════════════════════════════════════════

async function generateNarrative(leader, scoreData, commentData) {
  const sectionSummaries = Object.entries(scoreData.sections).map(([id, data]) => {
    const scores = Object.entries(data.scores)
      .filter(([,v])=>v!==null)
      .map(([g,v])=>`${RATER_GROUP_LABELS[g]||g}: ${v.toFixed(2)}`).join(', ');
    const comments = (commentData.sections[id]||[]).map(c=>`[${c.group}] ${c.text}`).join('\n');
    return `${data.title.toUpperCase()}\nScores: ${scores}\nComments:\n${comments||'(none)'}`;
  }).join('\n\n');

  const sscText = [
    `START: ${commentData.ssc.start.join(' | ') || '(none)'}`,
    `STOP: ${commentData.ssc.stop.join(' | ') || '(none)'}`,
    `CONTINUE: ${commentData.ssc.continue.join(' | ') || '(none)'}`
  ].join('\n');

  const prompt = `You are an expert leadership development coach generating 360 feedback narrative for a Sekisui House US leader.

Leader: ${leader.name}, ${leader.title || 'Division Leader'}

SCORING DATA AND RATER COMMENTS BY SECTION:
${sectionSummaries}

START / STOP / CONTINUE RESPONSES:
${sscText}

FRAMEWORK: This organization uses the H.O.M.E.S. Leadership Blueprint (Honor, Own, Model, Empower, Strengthen), SEKISUI HOUSE-SHIP values, and the Integrity Code ("Love of Humanity", Truth & Trust).

Generate a JSON object with this exact structure — no markdown, just raw JSON:
{
  "overview": "2-3 sentence overall pattern summary",
  "sections": {
    "honor": { "themes": "2-3 sentence synthesis", "strength": "one key strength observed", "opportunity": "one key development area" },
    "own": { "themes": "...", "strength": "...", "opportunity": "..." },
    "model": { "themes": "...", "strength": "...", "opportunity": "..." },
    "empower": { "themes": "...", "strength": "...", "opportunity": "..." },
    "strengthen": { "themes": "...", "strength": "...", "opportunity": "..." },
    "strategic": { "themes": "...", "strength": "...", "opportunity": "..." },
    "values": { "themes": "...", "strength": "...", "opportunity": "..." }
  },
  "supervisorPerspective": "2 sentence note on how supervisor view differs from other groups",
  "keyPattern": "The single most important theme across all rater groups in one sentence"
}

Be direct, specific, and grounded in the actual data. Do not be generic. Reference specific score patterns and comment themes.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }]
  });

  try {
    return JSON.parse(response.content[0].text);
  } catch {
    return { overview: response.content[0].text, sections: {}, keyPattern: '' };
  }
}

// ═══════════════════════════════════════════════════════════════
// HTML REPORT BUILDER
// ═══════════════════════════════════════════════════════════════

function buildReportHtml(leader, scoreData, narrative, commentData) {
  const C = { navy:'#1F3864', blue:'#2E75B6', light:'#DCE6F1', grey:'#595959' };
  const RATER_COLORS = { self:'#1F3864', supervisor:'#A94442', peer:'#4E8C3C', direct_report:'#C07A1A', skip_level:'#7B8FA6' };
  const groups = ['self','supervisor','peer','direct_report','skip_level'];

  function symShape(type, cx, cy) {
    const r = 4.5;
    if (type==='high')   return `<polygon points="${cx},${cy-r} ${cx-r},${cy+r} ${cx+r},${cy+r}" fill="#1F6B3A"/>`;
    if (type==='low')    return `<polygon points="${cx},${cy+r} ${cx-r},${cy-r} ${cx+r},${cy-r}" fill="#A94442"/>`;
    if (type==='hidden') return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#1D4E89"/>`;
    if (type==='blind')  return `<polygon points="${cx},${cy-r} ${cx+r},${cy} ${cx},${cy+r} ${cx-r},${cy}" fill="#B06000"/>`;
    return '';
  }

  function barChart(scores) {
    const LBL=128, BSTRT=134, BMAX=290, PPU=BMAX/5, VW=590;
    const BH=15, GAP=6, H=groups.length*(BH+GAP)+28;
    let s=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VW} ${H}" width="100%" style="display:block">`;
    groups.forEach((g,i)=>{ if(scores[g]!=null) s+=`<rect x="${BSTRT}" y="${i*(BH+GAP)+2}" width="${BMAX}" height="${BH}" fill="#f0f0f0" rx="2"/>`; });
    [1,2,3,4,5].forEach(v=>{
      const x=BSTRT+v*PPU, l=v===4?'4.0':String(v);
      s+=`<line x1="${x}" y1="0" x2="${x}" y2="${H-22}" stroke="${v===4?'#aaa':'#e0e0e0'}" stroke-width="${v===4?'1.5':'0.5'}" ${v===4?'stroke-dasharray="4 3"':''}/>`;
      s+=`<text x="${x}" y="${H-6}" text-anchor="middle" font-size="9" font-family="Arial" fill="${v===4?'#888':'#bbb'}">${l}</text>`;
    });
    groups.forEach((g,i)=>{
      const score=scores[g]; if(score==null) return;
      const y=i*(BH+GAP)+2, cy=y+BH/2, bw=score*PPU, color=RATER_COLORS[g]||'#888';
      s+=`<text x="${LBL}" y="${cy+4}" text-anchor="end" font-size="10" font-family="Arial" fill="${color}">${RATER_GROUP_LABELS[g]||g}</text>`;
      s+=`<rect x="${BSTRT}" y="${y}" width="${bw.toFixed(1)}" height="${BH}" fill="${color}" rx="2" opacity="${g==='self'?'1':'0.82'}"/>`;
      if(bw>=50) s+=`<text x="${(BSTRT+bw-4).toFixed(1)}" y="${cy+4}" font-size="10" font-family="Arial" font-weight="bold" fill="white" text-anchor="end">${score.toFixed(2)}</text>`;
      else       s+=`<text x="${(BSTRT+bw+4).toFixed(1)}" y="${cy+4}" font-size="10" font-family="Arial" font-weight="bold" fill="${color}" text-anchor="start">${score.toFixed(2)}</text>`;

      // Symbols
      const sectionId = Object.keys(scoreData.sections).find(id=>scoreData.sections[id].title && scoreData.sections[id].scores[g]===score);
      if (g !== 'self' && score !== null) {
        let symIdx = 0;
        const sx = BSTRT + BMAX + 12;
        if (score >= 4.4) { s += symShape('high', sx + symIdx*13, cy); symIdx++; }
        if (score <= 3.5) { s += symShape('low', sx + symIdx*13, cy); symIdx++; }
        const selfScore = scores['self'];
        if (selfScore !== null && (score - selfScore) >= 0.5) { s += symShape('hidden', sx + symIdx*13, cy); symIdx++; }
        if (selfScore !== null && score < 4.0 && (selfScore - score) >= 0.5) { s += symShape('blind', sx + symIdx*13, cy); symIdx++; }
      }
    });
    return s+'</svg>';
  }

  function summaryChart() {
    const sections = Object.entries(scoreData.sections);
    const LBL=178, BSTRT=184, BMAX=270, PPU=BMAX/5, VW=540;
    const BH=13, GAP=4, CGAP=18;
    const totalH = 4 + sections.length*(18+groups.length*(BH+GAP)+CGAP)+30;
    let s=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VW} ${totalH}" width="100%" style="display:block">`;
    let yo=20;
    sections.forEach(([,sec])=>{ groups.forEach((g,i)=>{ if(sec.scores[g]!=null) s+=`<rect x="${BSTRT}" y="${yo+i*(BH+GAP)}" width="${BMAX}" height="${BH}" fill="#f0f0f0" rx="2"/>`; }); yo+=groups.length*(BH+GAP)+CGAP; });
    [1,2,3,4,5].forEach(v=>{ const x=BSTRT+v*PPU,l=v===4?'4.0':String(v); s+=`<line x1="${x}" y1="0" x2="${x}" y2="${totalH-24}" stroke="${v===4?'#aaa':'#e0e0e0'}" stroke-width="${v===4?'1.2':'0.5'}" ${v===4?'stroke-dasharray="4 3"':''}/><text x="${x}" y="${totalH-7}" text-anchor="middle" font-size="9" fill="${v===4?'#888':'#bbb'}">${l}</text>`; });
    yo=4;
    sections.forEach(([,sec])=>{
      s+=`<text x="0" y="${yo+12}" font-size="11" font-family="Arial" font-weight="bold" fill="${C.navy}">${sec.title}</text>`;
      yo+=18;
      groups.forEach((g,i)=>{
        const score=sec.scores[g]; if(score==null) return;
        const y=yo+i*(BH+GAP), bw=score*PPU, color=RATER_COLORS[g]||'#888';
        s+=`<text x="${LBL}" y="${y+BH/2+4}" text-anchor="end" font-size="9" font-family="Arial" fill="${color}">${RATER_GROUP_LABELS[g]||g}</text>`;
        s+=`<rect x="${BSTRT}" y="${y}" width="${bw.toFixed(1)}" height="${BH}" fill="${color}" rx="2" opacity="${g==='self'?'1':'0.82'}"/>`;
        if(bw>=40) s+=`<text x="${(BSTRT+bw-3).toFixed(1)}" y="${y+BH/2+4}" font-size="9" font-family="Arial" font-weight="bold" fill="white" text-anchor="end">${score.toFixed(2)}</text>`;
        else       s+=`<text x="${(BSTRT+bw+3).toFixed(1)}" y="${y+BH/2+4}" font-size="9" font-family="Arial" font-weight="bold" fill="${color}" text-anchor="start">${score.toFixed(2)}</text>`;
      });
      yo+=groups.length*(BH+GAP)+CGAP;
    });
    return s+'</svg>';
  }

  function sectionHtml(sectionDef) {
    const data = scoreData.sections[sectionDef.id];
    if (!data) return '';
    const narr = narrative.sections?.[sectionDef.id] || {};
    const comments = (commentData.sections[sectionDef.id]||[]).filter(c=>c.text);

    return `
    <div class="section page-break-before">
      <div class="section-header">
        <h2>${sectionDef.title}</h2>
        <div class="section-sub">${sectionDef.subtitle}</div>
      </div>
      <div class="chart-wrap">${barChart(data.scores)}</div>
      ${narr.themes ? `<div class="themes-block"><div class="themes-header">Comment Themes</div><div class="themes-body">${narr.themes}</div></div>` : ''}
      ${narr.strength || narr.opportunity ? `
      <div class="insight-row">
        ${narr.strength ? `<div class="insight-card insight-strength"><div class="insight-label">▲ Strength</div><div class="insight-text">${narr.strength}</div></div>` : ''}
        ${narr.opportunity ? `<div class="insight-card insight-opportunity"><div class="insight-label">→ Development Opportunity</div><div class="insight-text">${narr.opportunity}</div></div>` : ''}
      </div>` : ''}
      ${comments.length ? `<div class="comments-section"><div class="comments-header">Rater Comments</div>${comments.map(c=>`<p class="comment-item">"${c.text}"</p>`).join('')}</div>` : ''}
    </div>`;
  }

  const sscHtml = (commentData.ssc.start.length || commentData.ssc.stop.length || commentData.ssc.continue.length) ? `
  <div class="section page-break-before">
    <h2>Start · Stop · Continue</h2>
    ${commentData.ssc.start.length ? `<div class="ssc-block ssc-start"><div class="ssc-label">▲ Start</div>${commentData.ssc.start.map(t=>`<p class="comment-item">"${t}"</p>`).join('')}</div>` : ''}
    ${commentData.ssc.stop.length  ? `<div class="ssc-block ssc-stop"><div class="ssc-label">■ Stop</div>${commentData.ssc.stop.map(t=>`<p class="comment-item">"${t}"</p>`).join('')}</div>` : ''}
    ${commentData.ssc.continue.length ? `<div class="ssc-block ssc-continue"><div class="ssc-label">● Continue</div>${commentData.ssc.continue.map(t=>`<p class="comment-item">"${t}"</p>`).join('')}</div>` : ''}
  </div>` : '';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/>
<title>360 Report — ${leader.name}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;font-size:12px;color:#1a1a1a;background:#fff}
.page{max-width:820px;margin:0 auto;padding:44px 48px}
.cover{padding-bottom:40px;border-bottom:4px solid #2E75B6;margin-bottom:32px}
.cover-label{font-size:10px;font-weight:bold;color:#2E75B6;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px}
.cover-name{font-size:40px;font-weight:bold;color:#1F3864;line-height:1.1;margin-bottom:14px}
.cover-meta{font-size:12px;color:#595959;margin-bottom:3px}
.cover-divider{border:none;border-top:1px solid #DCE6F1;margin:24px 0}
.cover-intro{font-size:12px;color:#333;line-height:1.8;max-width:580px}
.key-pattern{background:#1F3864;color:#fff;padding:16px 20px;border-radius:6px;font-size:13px;line-height:1.7;margin-top:20px}
.key-pattern strong{display:block;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px;color:#9FB5CC}
.summary-section{padding:24px 0 8px}
.summary-section h2{font-size:17px;color:#2E75B6;margin-bottom:16px}
.section{padding:26px 0;border-top:3px solid #DCE6F1}
.section-header{margin-bottom:16px}
.section-header h2{font-size:19px;color:#1F3864;font-weight:bold}
.section-sub{font-size:11px;color:#595959;margin-top:3px;font-style:italic}
h2{font-size:19px;color:#1F3864;margin-bottom:12px}
.chart-wrap{flex:1;min-width:0;margin-bottom:14px}
.themes-block{background:#F7F9FC;border-left:4px solid #2E75B6;padding:14px 16px;margin:14px 0 10px;border-radius:0 4px 4px 0}
.themes-header{font-size:11px;font-weight:bold;color:#1F3864;text-transform:uppercase;letter-spacing:1px;margin-bottom:7px}
.themes-body{font-size:12px;color:#333;line-height:1.8}
.insight-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0}
.insight-card{padding:12px 14px;border-radius:4px;font-size:11px;line-height:1.7}
.insight-label{font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
.insight-strength{background:#EEF7EE;border-left:3px solid #1F6B3A}.insight-strength .insight-label{color:#1F6B3A}
.insight-opportunity{background:#FEF8EE;border-left:3px solid #B06000}.insight-opportunity .insight-label{color:#B06000}
.insight-text{color:#333}
.comments-section{margin-top:14px}
.comments-header{font-size:10px;font-weight:bold;color:#595959;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}
.comment-item{font-size:11px;color:#333;line-height:1.75;font-style:italic;padding:5px 0;border-bottom:0.5px solid rgba(0,0,0,0.07)}
.comment-item:last-child{border-bottom:none}
.ssc-block{padding:14px 16px;border-radius:4px;margin-bottom:12px}
.ssc-label{font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}
.ssc-start{background:#EEF7EE;border-left:4px solid #1F6B3A}.ssc-start .ssc-label{color:#1F6B3A}
.ssc-stop{background:#FBEAEA;border-left:4px solid #A94442}.ssc-stop .ssc-label{color:#A94442}
.ssc-continue{background:#EEF7EE;border-left:4px solid #2E75B6}.ssc-continue .ssc-label{color:#2E75B6}
.reflect-section{padding:26px 0;border-top:3px solid #DCE6F1}
.reflect-q-list{list-style:none;padding:0}
.reflect-q-list li{font-size:12px;line-height:1.75;padding:9px 0 9px 16px;border-left:2px solid #DCE6F1;margin-bottom:8px}
.reflect-q-num{font-weight:bold;color:#2E75B6;margin-right:6px}
.reflect-sub{font-size:15px;font-weight:bold;color:#2E75B6;margin:28px 0 8px}
.reflect-bridge{background:#F7F9FC;border-left:4px solid #2E75B6;padding:13px 16px;border-radius:0 4px 4px 0;font-size:12px;color:#333;line-height:1.8;margin-bottom:18px}
@media print{body{font-size:11px}.page{padding:20px 24px;max-width:100%}.page-break-before{page-break-before:always}.cover{page-break-after:always}.summary-section{page-break-after:always}.insight-row{grid-template-columns:1fr 1fr}}
</style></head><body><div class="page">

<div class="cover">
  <div class="cover-label">360 Feedback Report — Senior Leader</div>
  <div class="cover-name">${leader.name}</div>
  <div class="cover-meta">${leader.title||''} ${leader.cycles?.name ? '· '+leader.cycles.name : ''}</div>
  <div class="cover-meta">Generated ${new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</div>
  <hr class="cover-divider"/>
  <p class="cover-intro">This report presents feedback collected from colleagues across multiple rater groups. Use the data as a starting point for reflection, development planning, and growth conversations. The goal is not evaluation — it is to give you a fuller picture of how your leadership lands.</p>
  ${narrative.keyPattern ? `<div class="key-pattern"><strong>Key Pattern</strong>${narrative.keyPattern}</div>` : ''}
</div>

${narrative.overview ? `<div style="padding:16px 0 24px;border-bottom:1px solid #DCE6F1;margin-bottom:8px"><p style="font-size:13px;color:#333;line-height:1.9">${narrative.overview}</p></div>` : ''}

<div class="summary-section page-break-before">
  <h2>Summary of All Sections</h2>
  ${summaryChart()}
</div>

${SECTIONS.map(s=>sectionHtml(s)).join('')}
${sscHtml}

<div class="reflect-section page-break-before">
  <h2>Reflecting on the Feedback</h2>
  <p style="font-size:12px;color:#555;line-height:1.7;margin-bottom:20px">Use the questions below as a guide for reflection before your development planning conversation.</p>
  <ul class="reflect-q-list">
    <li><span class="reflect-q-num">1.</span>What themes or patterns stand out most across your feedback? Where do you see consistency across rater groups and comments?</li>
    <li><span class="reflect-q-num">2.</span>Where are the largest gaps between how you view yourself and how others experience you? What might be contributing to those differences?</li>
    <li><span class="reflect-q-num">3.</span>Where did you notice meaningful differences between rater groups? What might explain why different groups see you differently?</li>
    <li><span class="reflect-q-num">4.</span>What strengths appear to have the greatest positive impact on those around you? How can you leverage those strengths more intentionally?</li>
    <li><span class="reflect-q-num">5.</span>What feedback, if addressed, would most improve your effectiveness as a leader? Why is it important to address that feedback?</li>
    <li><span class="reflect-q-num">6.</span>What feedback was most difficult to hear? What can you learn from your reaction to it?</li>
  </ul>
  <div class="reflect-sub">Looking Ahead</div>
  <div class="reflect-bridge">As Part 2 of the Leadership Assessment process, you will create a Leadership Action Plan focused on areas of growth and development. You will select three leadership areas to focus on over the next six months. A planning template will be provided for you to complete and share with your leader.</div>
</div>

</div></body></html>`;
}

module.exports = router;
