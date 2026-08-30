const express   = require('express');
const router    = express.Router();
const supabase  = require('../db/client');
const Anthropic = require('@anthropic-ai/sdk');
const { SECTIONS, RATER_GROUP_LABELS } = require('../questions');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function requireAuth(req, res, next) {
  if (req.isAdmin) return next();
  res.redirect('/admin/login');
}

// ── Generate report ───────────────────────────────────────────
router.get('/generate/:leaderId', requireAuth, async (req, res) => {
  const { leaderId } = req.params;
  try {
    const { data: leader } = await supabase.from('leaders').select('*, cycles(name)').eq('id', leaderId).single();
    if (!leader) return res.status(404).send('Leader not found');

    const { data: responses } = await supabase.from('responses').select('*').eq('leader_id', leaderId);
    const { data: openTexts } = await supabase.from('open_text').select('*, raters(rater_group)').eq('leader_id', leaderId);
    const { data: sscData   } = await supabase.from('start_stop_continue').select('*').eq('leader_id', leaderId);
    const { data: raters    } = await supabase.from('raters').select('id, rater_group, completed_at').eq('leader_id', leaderId).not('completed_at', 'is', null);

    if (!responses || responses.length === 0) return res.send('<h2 style="padding:40px;font-family:Arial">No responses yet.</h2>');

    const scoreData   = buildScoreData(responses, raters, SECTIONS);
    const commentData = buildCommentData(openTexts, sscData, SECTIONS);
    const narrative   = await generateNarrative(leader, scoreData, commentData);
    const reportHtml  = buildReportHtml(leader, scoreData, narrative, commentData);

    const { data: saved } = await supabase.from('reports')
      .insert([{ leader_id: leaderId, report_html: reportHtml, report_data: { scoreData, narrative }, generated_by: 'ai' }])
      .select().single();

    res.redirect(`/report/view/${saved.id}`);
  } catch (err) {
    console.error('Report error:', err);
    res.status(500).send(`<h2 style="padding:40px;font-family:Arial;color:#A94442">Report generation failed: ${err.message}</h2>`);
  }
});

router.get('/view/:reportId', async (req, res) => {
  const { data: report } = await supabase.from('reports').select('*, leaders(name, title, cycles(name))').eq('id', req.params.reportId).single();
  if (!report) return res.status(404).send('Report not found.');
  res.send(report.report_html);
});

// ═══════════════════════════════════════════════════════════════
// SCORING
// ═══════════════════════════════════════════════════════════════
function buildScoreData(responses, raters, sections) {
  const norm = g => {
    if (!g) return null;
    const m = { 'self':'self','supervisor':'supervisor','peer':'peer','peers':'peer','direct_report':'direct_report','direct_reports':'direct_report','skip_level':'skip_level','skip_levels':'skip_level','skip':'skip_level' };
    return m[g.toLowerCase().trim().replace(/\s+/g,'_')] || g;
  };

  const raterGroups = {};
  (raters || []).forEach(r => { raterGroups[r.id] = norm(r.rater_group); });

  const groups = ['self','supervisor','peer','direct_report','skip_level'];
  const overallScores = {}; groups.forEach(g => { overallScores[g] = []; });
  const sectionScores = {};
  sections.forEach(s => { sectionScores[s.id] = {}; groups.forEach(g => { sectionScores[s.id][g] = []; }); });

  responses.forEach(r => {
    const group = raterGroups[r.rater_id];
    if (!group || !groups.includes(group)) return;
    const section = sections.find(s => s.questions.some(q => q.n === r.question_number));
    if (!section || !sectionScores[section.id]) return;
    if (!sectionScores[section.id][group]) sectionScores[section.id][group] = [];
    if (!overallScores[group]) overallScores[group] = [];
    sectionScores[section.id][group].push(r.score);
    overallScores[group].push(r.score);
  });

  const avg = arr => (!arr || !arr.length) ? null : Math.round((arr.reduce((a,b)=>a+b,0)/arr.length)*100)/100;

  const result = { overall:{}, sections:{}, blindSpots:[], hiddenStrengths:[], highScores:[], lowScores:[] };
  groups.forEach(g => { result.overall[g] = avg(overallScores[g]); });

  sections.forEach(s => {
    result.sections[s.id] = { id: s.id, title: s.title, scores:{} };
    groups.forEach(g => { result.sections[s.id].scores[g] = avg(sectionScores[s.id][g]); });

    const selfScore = result.sections[s.id].scores.self;
    groups.filter(g => g !== 'self').forEach(g => {
      const other = result.sections[s.id].scores[g];
      if (other === null) return;
      if (selfScore !== null && other < 4.0 && (selfScore - other) >= 0.5) result.blindSpots.push({ section: s.title, group: RATER_GROUP_LABELS[g]||g, self: selfScore, other });
      if (selfScore !== null && (other - selfScore) >= 0.5) result.hiddenStrengths.push({ section: s.title, group: RATER_GROUP_LABELS[g]||g, self: selfScore, other });
      if (other >= 4.4) result.highScores.push({ section: s.title, group: RATER_GROUP_LABELS[g]||g, score: other });
      if (other <= 3.5) result.lowScores.push({ section: s.title, group: RATER_GROUP_LABELS[g]||g, score: other });
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
  const ssc = { start:[], stop:[], continue:[] };
  (sscData || []).forEach(r => {
    if (r.start_text)    ssc.start.push(r.start_text);
    if (r.stop_text)     ssc.stop.push(r.stop_text);
    if (r.continue_text) ssc.continue.push(r.continue_text);
  });
  return { sections: result, ssc };
}

// ═══════════════════════════════════════════════════════════════
// AI NARRATIVE — IMPROVED PROMPT
// ═══════════════════════════════════════════════════════════════
async function generateNarrative(leader, scoreData, commentData) {
  const groups = ['self','supervisor','peer','direct_report','skip_level'];

  const overallSummary = Object.entries(scoreData.overall)
    .filter(([,v]) => v !== null)
    .map(([g,v]) => `${RATER_GROUP_LABELS[g]||g}: ${v.toFixed(2)}`).join(', ');

  const sectionSummaries = Object.entries(scoreData.sections).map(([id, data]) => {
    const scores = Object.entries(data.scores)
      .filter(([,v]) => v !== null)
      .map(([g,v]) => `${RATER_GROUP_LABELS[g]||g}: ${v.toFixed(2)}`).join(', ');
    const selfScore = data.scores.self;
    const otherScores = groups.filter(g=>g!=='self').filter(g=>data.scores[g]!==null).map(g=>data.scores[g]);
    const avgOthers = otherScores.length ? (otherScores.reduce((a,b)=>a+b,0)/otherScores.length).toFixed(2) : null;
    const gap = (selfScore && avgOthers) ? (selfScore - parseFloat(avgOthers)).toFixed(2) : null;
    const comments = (commentData.sections[id]||[]).map(c=>`[${c.group}] ${c.text}`).join('\n');
    return `${data.title.toUpperCase()} | Scores: ${scores}${gap ? ` | Self vs others gap: ${gap}` : ''}\nComments:\n${comments||'(none)'}`;
  }).join('\n\n---\n\n');

  const flags = [
    scoreData.blindSpots.length    ? `BLIND SPOTS: ${scoreData.blindSpots.map(b=>`${b.section} (Self ${b.self} vs ${b.group} ${b.other})`).join('; ')}` : null,
    scoreData.hiddenStrengths.length ? `HIDDEN STRENGTHS: ${scoreData.hiddenStrengths.map(h=>`${h.section} (${h.group} rates higher)`).join('; ')}` : null,
    scoreData.highScores.length    ? `HIGH SCORES (4.4+): ${scoreData.highScores.map(h=>`${h.section} from ${h.group}`).join('; ')}` : null,
    scoreData.lowScores.length     ? `LOW SCORES (3.5-): ${scoreData.lowScores.map(l=>`${l.section} from ${l.group}`).join('; ')}` : null,
  ].filter(Boolean).join('\n');

  const sscText = [
    commentData.ssc.start.length    ? `START: ${commentData.ssc.start.join(' | ')}` : null,
    commentData.ssc.stop.length     ? `STOP: ${commentData.ssc.stop.join(' | ')}` : null,
    commentData.ssc.continue.length ? `CONTINUE: ${commentData.ssc.continue.join(' | ')}` : null,
  ].filter(Boolean).join('\n');

  const prompt = `You are a skilled leadership development coach generating a CARE 360 feedback report for In Good Company Collective.

LEADER: ${leader.name}${leader.title ? ', ' + leader.title : ''}

THE CARE FRAMEWORK:
- CONNECT: Genuine interest in people, knowing what motivates them, building real relationships
- ACCOUNTABLE: Keeping commitments, proactive communication, owning impact on people not just results
- REACH: Strategic thinking, investing in development, building something that lasts
- EMPOWER: Real delegation, psychological safety, creating conditions to grow and fail safely
- LEADERSHIP EFFECTIVENESS: Clarity, conflict, advocacy, overall impact

OVERALL SCORES:
${overallSummary}

SCORE AND COMMENT DATA BY SECTION:
${sectionSummaries}

DATA FLAGS:
${flags || '(none)'}

START / STOP / CONTINUE:
${sscText || '(none provided)'}

PRINCIPLES:
- Lead with what is genuinely working before addressing development areas
- Be specific and reference actual score patterns and comment themes
- Name meaningful divergences between rater groups
- Tone should feel like a trusted coach, not a performance review
- Write in full, warm, direct sentences only

Respond using EXACTLY this format with these markers. Write the text directly after each marker on a new line. Do not add any other text, labels, or formatting.

##KEYINSIGHT##
One specific sentence naming the single most important pattern across all the data.
##OVERVIEW##
3-4 sentences giving the overall picture. What is this leader's greatest strength as experienced by others? Where is the clearest opportunity? Any significant pattern across rater groups?
##CONNECT_WORKING##
2-3 sentences on what raters see working in Connect. Ground it in scores and comments.
##CONNECT_GROWTH##
2-3 sentences on the growth edge in Connect. If everything is strong, say so. If there is a real gap, name it directly but constructively.
##CONNECT_PATTERN##
1-2 sentences on any notable rater group difference in Connect. Write NONE if no meaningful divergence.
##ACCOUNTABLE_WORKING##
2-3 sentences on what is working in Accountable.
##ACCOUNTABLE_GROWTH##
2-3 sentences on the growth edge in Accountable.
##ACCOUNTABLE_PATTERN##
1-2 sentences on rater group differences in Accountable. Write NONE if not applicable.
##REACH_WORKING##
2-3 sentences on what is working in Reach.
##REACH_GROWTH##
2-3 sentences on the growth edge in Reach.
##REACH_PATTERN##
1-2 sentences on rater group differences in Reach. Write NONE if not applicable.
##EMPOWER_WORKING##
2-3 sentences on what is working in Empower.
##EMPOWER_GROWTH##
2-3 sentences on the growth edge in Empower.
##EMPOWER_PATTERN##
1-2 sentences on rater group differences in Empower. Write NONE if not applicable.
##EFFECTIVENESS_WORKING##
2-3 sentences on what is working in Leadership Effectiveness.
##EFFECTIVENESS_GROWTH##
2-3 sentences on the growth edge in Leadership Effectiveness.
##EFFECTIVENESS_PATTERN##
1-2 sentences on rater group differences in Leadership Effectiveness. Write NONE if not applicable.
##SSC_THEMES##
2-3 sentences synthesizing the Start/Stop/Continue responses. Write NONE if no SSC data was provided.
##CLOSING##
2-3 sentences affirming this leader's capacity to grow from this feedback. Reference something specific from the data. This should feel like a coach's final word before handing the leader their report.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = response.content[0].text.trim();
  console.log('Narrative response length:', raw.length);

  // Parse delimiter-based response — much more robust than JSON
  const get = (marker) => {
    const start = raw.indexOf(`##${marker}##`);
    if (start === -1) return '';
    const contentStart = start + marker.length + 4;
    const nextMarker = raw.indexOf('##', contentStart);
    const content = (nextMarker === -1 ? raw.slice(contentStart) : raw.slice(contentStart, nextMarker)).trim();
    return content === 'NONE' ? '' : content;
  };

  const section = (id) => ({
    whatsWorking: get(`${id.toUpperCase()}_WORKING`),
    growthEdge:   get(`${id.toUpperCase()}_GROWTH`),
    raterPattern: get(`${id.toUpperCase()}_PATTERN`),
  });

  const result = {
    keyInsight:        get('KEYINSIGHT'),
    overview:          get('OVERVIEW'),
    sscThemes:         get('SSC_THEMES'),
    closingReflection: get('CLOSING'),
    sections: {
      connect:       section('connect'),
      accountable:   section('accountable'),
      reach:         section('reach'),
      empower:       section('empower'),
      effectiveness: section('effectiveness'),
    }
  };

  console.log('Parsed narrative. keyInsight length:', result.keyInsight.length, 'sections:', Object.keys(result.sections).filter(k=>result.sections[k].whatsWorking).length);
  return result;
}

// ═══════════════════════════════════════════════════════════════
// REPORT HTML BUILDER — IGC BRANDING
// ═══════════════════════════════════════════════════════════════
function buildReportHtml(leader, scoreData, narrative, commentData) {
  const RATER_COLORS = {
    self:'#30383B', supervisor:'#A94442', peer:'#7C8863',
    direct_report:'#A9633D', skip_level:'#8B7355'
  };
  const groups = ['self','supervisor','peer','direct_report','skip_level'];

  function symShape(type, cx, cy) {
    const r = 4.5;
    if (type==='high')   return `<polygon points="${cx},${cy-r} ${cx-r},${cy+r} ${cx+r},${cy+r}" fill="#7C8863"/>`;
    if (type==='low')    return `<polygon points="${cx},${cy+r} ${cx-r},${cy-r} ${cx+r},${cy-r}" fill="#A94442"/>`;
    if (type==='hidden') return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#7C8863" opacity="0.6"/>`;
    if (type==='blind')  return `<polygon points="${cx},${cy-r} ${cx+r},${cy} ${cx},${cy+r} ${cx-r},${cy}" fill="#A9633D"/>`;
    return '';
  }

  function barChart(scores) {
    const LBL=128,BSTRT=134,BMAX=290,PPU=BMAX/5,VW=590;
    const BH=16,GAP=7;
    const H = groups.length*(BH+GAP)+28;
    let s=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VW} ${H}" width="100%" style="display:block">`;
    groups.forEach((g,i)=>{ if(scores[g]!=null) s+=`<rect x="${BSTRT}" y="${i*(BH+GAP)+2}" width="${BMAX}" height="${BH}" fill="#EDE8DF" rx="2"/>`; });
    [1,2,3,4,5].forEach(v=>{
      const x=BSTRT+v*PPU,l=v===4?'4.0':String(v);
      s+=`<line x1="${x}" y1="0" x2="${x}" y2="${H-22}" stroke="${v===4?'#C4B9A8':'#EDE8DF'}" stroke-width="${v===4?'1.5':'0.8'}" ${v===4?'stroke-dasharray="4 3"':''}/>`;
      s+=`<text x="${x}" y="${H-6}" text-anchor="middle" font-size="9" font-family="Georgia,serif" fill="${v===4?'#8B7355':'#C4B9A8'}">${l}</text>`;
    });
    groups.forEach((g,i)=>{
      const score=scores[g]; if(score==null) return;
      const y=i*(BH+GAP)+2,cy=y+BH/2,bw=score*PPU,color=RATER_COLORS[g]||'#888';
      s+=`<text x="${LBL}" y="${cy+4}" text-anchor="end" font-size="10" font-family="Georgia,serif" fill="${color}">${RATER_GROUP_LABELS[g]||g}</text>`;
      s+=`<rect x="${BSTRT}" y="${y}" width="${bw.toFixed(1)}" height="${BH}" fill="${color}" rx="2" opacity="${g==='self'?'1':'0.85'}"/>`;
      if(bw>=50) s+=`<text x="${(BSTRT+bw-5).toFixed(1)}" y="${cy+4}" font-size="10" font-family="Georgia,serif" font-weight="bold" fill="white" text-anchor="end">${score.toFixed(2)}</text>`;
      else       s+=`<text x="${(BSTRT+bw+4).toFixed(1)}" y="${cy+4}" font-size="10" font-family="Georgia,serif" font-weight="bold" fill="${color}" text-anchor="start">${score.toFixed(2)}</text>`;
      // symbols
      if(g!=='self'&&score!==null){
        const sx=BSTRT+BMAX+11; let idx=0;
        const selfScore=scores['self'];
        if(score>=4.4){s+=symShape('high',sx+idx*13,cy);idx++;}
        if(score<=3.5){s+=symShape('low',sx+idx*13,cy);idx++;}
        if(selfScore!==null&&(score-selfScore)>=0.5){s+=symShape('hidden',sx+idx*13,cy);idx++;}
        if(selfScore!==null&&score<4.0&&(selfScore-score)>=0.5){s+=symShape('blind',sx+idx*13,cy);idx++;}
      }
    });
    return s+'</svg>';
  }

  function summaryChart() {
    const sects = Object.values(scoreData.sections);
    const LBL=178,BSTRT=184,BMAX=270,PPU=BMAX/5,VW=540;
    const BH=13,GAP=4,CGAP=18;
    const totalH=4+sects.length*(18+groups.length*(BH+GAP)+CGAP)+30;
    let s=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VW} ${totalH}" width="100%" style="display:block">`;
    let yo=20;
    sects.forEach(sec=>{ groups.forEach((g,i)=>{ if(sec.scores[g]!=null) s+=`<rect x="${BSTRT}" y="${yo+i*(BH+GAP)}" width="${BMAX}" height="${BH}" fill="#EDE8DF" rx="2"/>`; }); yo+=groups.length*(BH+GAP)+CGAP; });
    [1,2,3,4,5].forEach(v=>{ const x=BSTRT+v*PPU,l=v===4?'4.0':String(v); s+=`<line x1="${x}" y1="0" x2="${x}" y2="${totalH-24}" stroke="${v===4?'#C4B9A8':'#EDE8DF'}" stroke-width="${v===4?'1.2':'0.6'}" ${v===4?'stroke-dasharray="4 3"':''}/><text x="${x}" y="${totalH-7}" text-anchor="middle" font-size="9" font-family="Georgia,serif" fill="${v===4?'#8B7355':'#C4B9A8'}">${l}</text>`; });
    yo=4;
    sects.forEach(sec=>{
      s+=`<text x="0" y="${yo+12}" font-size="11" font-family="Georgia,serif" font-weight="bold" fill="#30383B">${sec.title}</text>`;
      yo+=18;
      groups.forEach((g,i)=>{
        const score=sec.scores[g]; if(score==null) return;
        const y=yo+i*(BH+GAP),bw=score*PPU,color=RATER_COLORS[g]||'#888';
        s+=`<text x="${LBL}" y="${y+BH/2+4}" text-anchor="end" font-size="9" font-family="Georgia,serif" fill="${color}">${RATER_GROUP_LABELS[g]||g}</text>`;
        s+=`<rect x="${BSTRT}" y="${y}" width="${bw.toFixed(1)}" height="${BH}" fill="${color}" rx="2" opacity="${g==='self'?'1':'0.85'}"/>`;
        if(bw>=40) s+=`<text x="${(BSTRT+bw-3).toFixed(1)}" y="${y+BH/2+4}" font-size="9" font-family="Georgia,serif" font-weight="bold" fill="white" text-anchor="end">${score.toFixed(2)}</text>`;
        else       s+=`<text x="${(BSTRT+bw+3).toFixed(1)}" y="${y+BH/2+4}" font-size="9" font-family="Georgia,serif" font-weight="bold" fill="${color}" text-anchor="start">${score.toFixed(2)}</text>`;
      });
      yo+=groups.length*(BH+GAP)+CGAP;
    });
    return s+'</svg>';
  }

  function sectionBlock(sectionDef) {
    const data    = scoreData.sections[sectionDef.id];
    if (!data) return '';
    const narr    = narrative.sections?.[sectionDef.id] || {};
    const comments = (commentData.sections[sectionDef.id]||[]).filter(c=>c.text);

    return `
    <div class="section page-break-before">
      <div class="section-header">
        <div class="section-num">Section ${sectionDef.number}</div>
        <h2>${sectionDef.title}</h2>
        <div class="section-sub">${sectionDef.subtitle}</div>
      </div>
      <div class="chart-wrap">${barChart(data.scores)}</div>

      ${narr.whatsWorking ? `
      <div class="narrative-block narrative-strength">
        <div class="narrative-label">What Is Working</div>
        <p>${narr.whatsWorking}</p>
      </div>` : ''}

      ${narr.growthEdge ? `
      <div class="narrative-block narrative-growth">
        <div class="narrative-label">Growth Edge</div>
        <p>${narr.growthEdge}</p>
      </div>` : ''}

      ${narr.raterPattern ? `
      <div class="narrative-block narrative-pattern">
        <div class="narrative-label">Rater Group Pattern</div>
        <p>${narr.raterPattern}</p>
      </div>` : ''}

      ${comments.length ? `
      <div class="comments-section">
        <div class="comments-header">Rater Comments</div>
        ${comments.map(c=>`<p class="comment-item">"${c.text}"</p>`).join('')}
      </div>` : ''}
    </div>`;
  }

  const sscHtml = (commentData.ssc.start.length||commentData.ssc.stop.length||commentData.ssc.continue.length) ? `
  <div class="section page-break-before">
    <h2>Start &nbsp;·&nbsp; Stop &nbsp;·&nbsp; Continue</h2>
    ${narrative.sscThemes ? `<div class="narrative-block narrative-pattern"><p>${narrative.sscThemes}</p></div>` : ''}
    ${commentData.ssc.start.length?`<div class="ssc-block ssc-start"><div class="ssc-label">Start</div>${commentData.ssc.start.map(t=>`<p class="comment-item">"${t}"</p>`).join('')}</div>`:''}
    ${commentData.ssc.stop.length?`<div class="ssc-block ssc-stop"><div class="ssc-label">Stop</div>${commentData.ssc.stop.map(t=>`<p class="comment-item">"${t}"</p>`).join('')}</div>`:''}
    ${commentData.ssc.continue.length?`<div class="ssc-block ssc-continue"><div class="ssc-label">Continue</div>${commentData.ssc.continue.map(t=>`<p class="comment-item">"${t}"</p>`).join('')}</div>`:''}
  </div>` : '';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/>
<title>CARE 360 Report — ${leader.name}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;500;600&family=Noto+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Noto Sans',Arial,sans-serif;font-size:12px;color:#30383B;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{max-width:820px;margin:0 auto;padding:44px 48px}

/* Cover */
.cover{padding-bottom:40px;border-bottom:3px solid #A9633D;margin-bottom:36px}
.cover-eyebrow{font-size:10px;font-weight:600;color:#A9633D;letter-spacing:2.5px;text-transform:uppercase;margin-bottom:12px}
.cover-name{font-family:'EB Garamond',Georgia,serif;font-size:44px;font-weight:600;color:#30383B;line-height:1.1;margin-bottom:12px}
.cover-meta{font-size:12px;color:#595959;margin-bottom:3px}
.cover-divider{border:none;border-top:1px solid #D9CBB2;margin:24px 0}
.cover-intro{font-size:12px;color:#595959;line-height:1.85;max-width:580px}

/* Key insight */
.key-insight{background:#30383B;color:#F7F4EF;padding:18px 22px;border-radius:8px;margin-top:22px}
.key-insight-label{font-size:9px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#D9CBB2;margin-bottom:7px}
.key-insight-text{font-family:'EB Garamond',Georgia,serif;font-size:15px;line-height:1.7}

/* Summary */
.summary-section{padding:24px 0 8px}
.summary-section h2{font-family:'EB Garamond',Georgia,serif;font-size:20px;color:#30383B;margin-bottom:16px;font-weight:600}

/* Overview */
.overview-block{background:#F7F4EF;border-left:4px solid #A9633D;padding:16px 20px;border-radius:0 6px 6px 0;margin-bottom:24px;font-size:13px;line-height:1.85;color:#30383B}

/* Sections */
.section{padding:28px 0;border-top:3px solid #D9CBB2}
.section-header{margin-bottom:18px}
.section-num{font-size:10px;font-weight:600;color:#A9633D;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px}
.section-header h2{font-family:'EB Garamond',Georgia,serif;font-size:22px;color:#30383B;font-weight:600;margin-bottom:4px}
.section-sub{font-size:11px;color:#595959;font-style:italic;line-height:1.6}
h2{font-family:'EB Garamond',Georgia,serif;font-size:22px;color:#30383B;margin-bottom:14px;font-weight:600}

.chart-wrap{margin-bottom:18px}

/* Narrative blocks */
.narrative-block{padding:14px 18px;border-radius:0 6px 6px 0;margin-bottom:10px;font-size:12px;line-height:1.85}
.narrative-label{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:7px}
.narrative-strength{background:#F4F7F2;border-left:4px solid #7C8863}
.narrative-strength .narrative-label{color:#7C8863}
.narrative-growth{background:#FBF5EC;border-left:4px solid #A9633D}
.narrative-growth .narrative-label{color:#A9633D}
.narrative-pattern{background:#F7F4EF;border-left:4px solid #D9CBB2}
.narrative-pattern .narrative-label{color:#595959}

/* Comments */
.comments-section{margin-top:14px}
.comments-header{font-size:9px;font-weight:700;color:#595959;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #EDE8DF}
.comment-item{font-size:11px;color:#30383B;line-height:1.8;font-style:italic;padding:5px 0;border-bottom:0.5px solid #EDE8DF}
.comment-item:last-child{border-bottom:none}

/* SSC */
.ssc-block{padding:14px 18px;border-radius:0 6px 6px 0;margin-bottom:10px}
.ssc-label{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:10px}
.ssc-start{background:#F4F7F2;border-left:4px solid #7C8863}.ssc-start .ssc-label{color:#7C8863}
.ssc-stop{background:#FEF0EE;border-left:4px solid #A94442}.ssc-stop .ssc-label{color:#A94442}
.ssc-continue{background:#FBF5EC;border-left:4px solid #A9633D}.ssc-continue .ssc-label{color:#A9633D}

/* Closing */
.closing-block{background:#30383B;color:#F7F4EF;padding:20px 24px;border-radius:8px;margin-top:12px;font-family:'EB Garamond',Georgia,serif;font-size:14px;line-height:1.85}
.closing-label{font-size:9px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#D9CBB2;margin-bottom:8px;font-family:'Noto Sans',Arial,sans-serif}

/* Reflect */
.reflect-section{padding:28px 0;border-top:3px solid #D9CBB2}
.reflect-section h2{font-family:'EB Garamond',Georgia,serif;font-size:22px;color:#30383B;font-weight:600;margin-bottom:8px}
.reflect-intro{font-size:12px;color:#595959;line-height:1.7;margin-bottom:20px}
.reflect-q-list{list-style:none;padding:0;margin:0}
.reflect-q-list li{font-size:12px;line-height:1.75;padding:9px 0 9px 16px;border-left:2px solid #D9CBB2;margin-bottom:8px}
.reflect-q-num{font-weight:700;color:#A9633D;margin-right:6px}
.reflect-sub{font-family:'EB Garamond',Georgia,serif;font-size:16px;font-weight:600;color:#A9633D;margin:28px 0 8px}
.reflect-bridge{background:#F7F4EF;border-left:4px solid #A9633D;padding:14px 18px;border-radius:0 6px 6px 0;font-size:12px;color:#30383B;line-height:1.85;margin-bottom:18px}

/* Color key */
.color-key{display:flex;flex-wrap:wrap;gap:14px;margin:12px 0}
.ck-item{display:flex;align-items:center;gap:6px;font-size:11px;color:#595959}
.ck-swatch{width:12px;height:12px;border-radius:2px;flex-shrink:0}

/* Brand footer */
.brand-footer{text-align:center;margin-top:48px;padding-top:20px;border-top:1px solid #EDE8DF}
.brand-footer-name{font-family:'EB Garamond',Georgia,serif;font-size:14px;color:#30383B;margin-bottom:4px}
.brand-footer-tag{font-size:10px;color:#D9CBB2;letter-spacing:1.5px;text-transform:uppercase}

@media print{
  body{font-size:11px}.page{padding:20px 24px;max-width:100%}
  .page-break-before{page-break-before:always}
  .cover{page-break-after:always}.summary-section{page-break-after:always}
  .narrative-block,.comments-section,.ssc-block{page-break-inside:avoid}
}
</style></head>
<body><div class="page">

<div class="cover">
  <div style="margin-bottom:16px"><img src="/logo.png" alt="In Good Company" style="height:36px"/></div>
<div class="cover-eyebrow">CARE 360 Feedback Report</div>
  <div class="cover-name">${leader.name}</div>
  <div class="cover-meta">${leader.title || ''} ${leader.cycles?.name ? '&nbsp;·&nbsp; ' + leader.cycles.name : ''}</div>
  <div class="cover-meta">Generated ${new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</div>
  <hr class="cover-divider"/>
  <p class="cover-intro">This report presents feedback collected from colleagues across multiple rater groups as part of the CARE 360 Leadership Survey. Use the data as a starting point for reflection, development planning, and growth conversations. The goal is not evaluation. It is to give you a fuller, more honest picture of how your leadership lands — and to help you grow from it.</p>
  ${narrative.keyInsight ? `<div class="key-insight"><div class="key-insight-label">Key Insight</div><div class="key-insight-text">${narrative.keyInsight}</div></div>` : ''}
</div>

${narrative.overview ? `<div class="overview-block">${narrative.overview}</div>` : ''}

<div style="margin-bottom:16px">
  <div style="font-size:10px;font-weight:600;color:#595959;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Rater Group Key</div>
  <div class="color-key">${Object.entries(RATER_GROUP_LABELS).map(([k,v])=>`<div class="ck-item"><div class="ck-swatch" style="background:${RATER_COLORS[k]||'#888'}"></div><span>${v}</span></div>`).join('')}</div>
</div>


<div style="margin-bottom:24px">
  <div style="font-size:10px;font-weight:600;color:#595959;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Symbol Key</div>
  <div style="display:flex;flex-wrap:wrap;gap:14px">
    <div style="display:flex;align-items:center;gap:7px;font-size:11px;color:#595959">
      <svg width="14" height="14" viewBox="0 0 14 14"><polygon points="7,1 1,13 13,13" fill="#7C8863"/></svg>
      <span><strong>High Score</strong> — 4.4 or above. A strength to build on.</span>
    </div>
    <div style="display:flex;align-items:center;gap:7px;font-size:11px;color:#595959">
      <svg width="14" height="14" viewBox="0 0 14 14"><polygon points="7,13 1,1 13,1" fill="#A94442"/></svg>
      <span><strong>Low Score</strong> — 3.5 or below. A development priority.</span>
    </div>
    <div style="display:flex;align-items:center;gap:7px;font-size:11px;color:#595959">
      <svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6" fill="#7C8863" opacity="0.6"/></svg>
      <span><strong>Hidden Strength</strong> — Others rate this higher than you rate yourself.</span>
    </div>
    <div style="display:flex;align-items:center;gap:7px;font-size:11px;color:#595959">
      <svg width="14" height="14" viewBox="0 0 14 14"><polygon points="7,1 13,7 7,13 1,7" fill="#A9633D"/></svg>
      <span><strong>Blind Spot</strong> — You rate this higher than others, and their score is below 4.0.</span>
    </div>
  </div>
</div>
<div class="summary-section page-break-before">
  <h2>Summary of All Sections</h2>
  ${summaryChart()}
</div>

${SECTIONS.map(s => sectionBlock(s)).join('')}
${sscHtml}

${narrative.closingReflection ? `
<div class="section page-break-before" style="border-top:none;padding-top:0">
  <div class="closing-block">
    <div class="closing-label">A Note From Your Coach</div>
    ${narrative.closingReflection}
  </div>
</div>` : ''}

<div class="reflect-section page-break-before">
  <h2>Reflecting on the Feedback</h2>
  <p class="reflect-intro">Use the questions below as a guide for reflection before your development planning conversation. There are no right answers. The goal is to engage honestly with what the data is telling you about your leadership.</p>
  <ul class="reflect-q-list">
    <li><span class="reflect-q-num">1.</span>What themes or patterns stand out most across your feedback? Where do you see consistency across rater groups and comments?</li>
    <li><span class="reflect-q-num">2.</span>Where are the largest gaps between how you view yourself and how others experience you? What might be contributing to those differences?</li>
    <li><span class="reflect-q-num">3.</span>Where did you notice meaningful differences between rater groups? What might explain why different groups see you differently?</li>
    <li><span class="reflect-q-num">4.</span>What strengths appear to have the greatest positive impact on those around you? How can you leverage those strengths more intentionally?</li>
    <li><span class="reflect-q-num">5.</span>What feedback, if addressed, would most improve your effectiveness as a leader? Why is it important to address that feedback?</li>
    <li><span class="reflect-q-num">6.</span>What feedback was most difficult to hear? What can you learn from your reaction to it?</li>
  </ul>
  <div class="reflect-sub">Looking Ahead</div>
  <div class="reflect-bridge">Use this feedback as the foundation for a focused development conversation with your coach or facilitator. Identify two or three areas where focused effort over the next six months would create the most meaningful growth for you and the people around you.</div>
</div>

<div class="brand-footer">
  <div class="brand-footer-name">in good company.</div>
  <div class="brand-footer-tag">Thoughtful &nbsp;·&nbsp; Innovative &nbsp;·&nbsp; Human</div>
</div>

</div></body></html>`;
}

module.exports = router;
