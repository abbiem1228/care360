const { Resend } = require('resend');

const resend  = new Resend(process.env.RESEND_API_KEY);
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const FROM    = process.env.FROM_EMAIL || 'noreply@ingoodcocollective.com';

async function sendRaterInvite(rater, leader) {
  const surveyUrl = `${APP_URL}/survey/${rater.token}`;
  const isSelf    = rater.rater_group === 'self';

  const subject = isSelf
    ? `Your CARE 360 Self-Assessment is ready`
    : `You have been invited to give 360 feedback for ${leader.name}`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="font-family:Arial,sans-serif;background:#F7F4EF;margin:0;padding:40px 20px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">

  <div style="background:#30383B;padding:28px 36px">
    <div style="color:#D9CBB2;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px">In Good Company Collective</div>
    <div style="color:#fff;font-size:20px;font-weight:bold">CARE 360 Leadership Survey</div>
  </div>

  <div style="padding:36px">
    <p style="color:#30383B;font-size:14px;margin-bottom:16px">Hi ${rater.name},</p>

    ${isSelf
      ? `<p style="color:#444;font-size:14px;line-height:1.8;margin-bottom:24px">Your CARE 360 self-assessment is ready. This is your opportunity to reflect honestly on your own leadership and see how your perspective compares with those around you.</p>`
      : `<p style="color:#444;font-size:14px;line-height:1.8;margin-bottom:24px">You have been selected to provide 360 feedback for <strong>${leader.name}</strong>${leader.title ? ` (${leader.title})` : ''}. Your feedback is anonymous, developmental in purpose, and genuinely valued.</p>`
    }

    <div style="background:#F7F4EF;border-left:4px solid #A9633D;padding:14px 18px;border-radius:0 6px 6px 0;margin-bottom:28px">
      <div style="font-size:11px;font-weight:bold;color:#595959;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">What to expect</div>
      <ul style="margin:0;padding-left:18px;color:#333;font-size:13px;line-height:2.1">
        <li>30 questions across 5 CARE sections — approximately 10 minutes</li>
        <li>Rating scale of 1 (Strongly Disagree) to 5 (Strongly Agree)</li>
        <li>Optional open-text feedback after each section</li>
        <li>One final Start, Stop, Continue question</li>
      </ul>
    </div>

    <div style="text-align:center;margin-bottom:28px">
      <a href="${surveyUrl}" style="display:inline-block;background:#A9633D;color:#fff;padding:14px 40px;border-radius:6px;font-size:15px;font-weight:bold;text-decoration:none">
        ${isSelf ? 'Begin Self-Assessment' : 'Begin Survey'}
      </a>
    </div>

    <p style="color:#595959;font-size:12px;line-height:1.7">
      ${isSelf
        ? 'Your responses are stored securely and will be combined with feedback from your raters to create your full report.'
        : '<strong>Your responses are completely anonymous.</strong> Individual responses are never shared. Only aggregate patterns are reported.'}
    </p>

    <p style="color:#bbb;font-size:11px;margin-top:24px;border-top:1px solid #EDE8DF;padding-top:16px">
      If the button does not work, copy and paste this link:<br/>
      <span style="color:#A9633D">${surveyUrl}</span>
    </p>
  </div>

  <div style="background:#F7F4EF;padding:16px 36px;text-align:center">
    <p style="color:#aaa;font-size:11px;margin:0">In Good Company Collective &nbsp;·&nbsp; CARE 360 Leadership Survey</p>
    <p style="color:#bbb;font-size:10px;margin:4px 0 0">Thoughtful &nbsp;·&nbsp; Innovative &nbsp;·&nbsp; Human</p>
  </div>
</div>
</body>
</html>`;

  const text = `Hi ${rater.name},\n\n${isSelf ? 'Your CARE 360 self-assessment is ready.' : `You have been invited to give feedback for ${leader.name}.`}\n\nComplete your survey here:\n${surveyUrl}\n\nThe survey takes approximately 10 minutes.\n\nIn Good Company Collective`;

  await resend.emails.send({ from: FROM, to: rater.email, subject, html, text });
}

const GROUP_LABELS = {
  self: 'Self', supervisor: 'Supervisor', peer: 'Peer',
  direct_report: 'Direct Report', skip_level: 'Skip-Level'
};

async function sendAdminNotice({ leader, cycle, raters, reason }) {
  const to = process.env.ADMIN_EMAIL;
  if (!to) { console.log('ADMIN_EMAIL not set, skipping notification'); return; }

  const done  = raters.filter(r => r.completed_at).length;
  const total = raters.length;
  const raterDone = raters.filter(r => r.completed_at && r.rater_group !== 'self').length;

  const groups = {};
  raters.forEach(r => {
    if (!groups[r.rater_group]) groups[r.rater_group] = { total: 0, done: 0 };
    groups[r.rater_group].total++;
    if (r.completed_at) groups[r.rater_group].done++;
  });

  const order = ['self','supervisor','peer','direct_report','skip_level'];
  const rows = Object.entries(groups)
    .sort((a,b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([g,c]) => {
      const low = g !== 'self' && g !== 'supervisor' && c.done < 3;
      return `<tr>
        <td style="padding:9px 12px;border-bottom:1px solid #EDE8DF;font-size:13px;color:#30383B">${GROUP_LABELS[g] || g}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #EDE8DF;font-size:13px;color:#30383B">${c.done} of ${c.total}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #EDE8DF;font-size:12px;color:${low ? '#A94442' : '#7C8863'}">${low ? 'Below threshold' : 'OK'}</td>
      </tr>`;
    }).join('');

  const complete = reason === 'complete';
  const subject  = complete
    ? `All responses received for ${leader.name}`
    : `Survey window closed for ${leader.name}`;
  const headline = complete
    ? `Every rater has completed their survey. The report is ready to generate.`
    : `The survey window has closed. ${raterDone} rater response${raterDone === 1 ? '' : 's'} were received.`;
  const readiness = raterDone >= 3
    ? `<p style="color:#7C8863;font-size:13px;line-height:1.7;margin:0 0 24px">There are enough responses to generate the report.</p>`
    : `<p style="color:#A94442;font-size:13px;line-height:1.7;margin:0 0 24px">Only ${raterDone} rater response${raterDone === 1 ? '' : 's'} were received. Three are needed before a report can be generated.</p>`;

  const leaderUrl = `${APP_URL}/admin/leaders/${leader.id}`;

  const html = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"/></head>
<body style="font-family:Arial,sans-serif;background:#F7F4EF;margin:0;padding:40px 20px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
  <div style="background:#30383B;padding:28px 36px">
    <div style="color:#D9CBB2;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px">In Good Company Collective</div>
    <div style="color:#fff;font-size:20px;font-weight:bold">${complete ? 'Survey Complete' : 'Survey Window Closed'}</div>
  </div>
  <div style="padding:36px">
    <p style="color:#30383B;font-size:15px;font-weight:bold;margin:0 0 6px">${leader.name}${leader.title ? `, ${leader.title}` : ''}</p>
    <p style="color:#595959;font-size:13px;margin:0 0 20px">${cycle && cycle.name ? cycle.name : ''}</p>
    <p style="color:#444;font-size:14px;line-height:1.8;margin:0 0 20px">${headline}</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
      <thead><tr>
        <th style="background:#30383B;color:#fff;padding:9px 12px;text-align:left;font-size:11px;letter-spacing:1px;text-transform:uppercase">Group</th>
        <th style="background:#30383B;color:#fff;padding:9px 12px;text-align:left;font-size:11px;letter-spacing:1px;text-transform:uppercase">Completed</th>
        <th style="background:#30383B;color:#fff;padding:9px 12px;text-align:left;font-size:11px;letter-spacing:1px;text-transform:uppercase"></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${readiness}
    <div style="text-align:center;margin-bottom:8px">
      <a href="${leaderUrl}" style="display:inline-block;background:#A9633D;color:#fff;padding:14px 40px;border-radius:6px;font-size:15px;font-weight:bold;text-decoration:none">Open ${leader.name}</a>
    </div>
  </div>
  <div style="background:#F7F4EF;padding:16px 36px;text-align:center">
    <p style="color:#aaa;font-size:11px;margin:0">In Good Company Collective &nbsp;·&nbsp; CARE 360</p>
  </div>
</div>
</body></html>`;

  const text = `${leader.name}\n${headline}\n\n${done} of ${total} completed.\n\n${leaderUrl}`;

  try {
    await resend.emails.send({ from: FROM, to, subject, html, text });
  } catch (e) {
    console.error('Admin notice failed:', e.message);
  }
}
async function sendRaterReminder(rater, leader, cycle) {
  const surveyUrl = `${APP_URL}/survey/${rater.token}`;
  const isSelf    = rater.rater_group === 'self';
  const closes    = new Date(cycle.closes_at).toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });

  const subject = isSelf
    ? `Reminder: your CARE 360 self-assessment closes soon`
    : `Reminder: feedback for ${leader.name} closes soon`;

  const html = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"/></head>
<body style="font-family:Arial,sans-serif;background:#F7F4EF;margin:0;padding:40px 20px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
  <div style="background:#30383B;padding:28px 36px">
    <div style="color:#D9CBB2;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px">In Good Company Collective</div>
    <div style="color:#fff;font-size:20px;font-weight:bold">A quick reminder</div>
  </div>
  <div style="padding:36px">
    <p style="color:#30383B;font-size:14px;margin-bottom:16px">Hi ${rater.name},</p>
    ${isSelf
      ? `<p style="color:#444;font-size:14px;line-height:1.8;margin-bottom:20px">Your CARE 360 self-assessment is still open, and we have not received your responses yet.</p>`
      : `<p style="color:#444;font-size:14px;line-height:1.8;margin-bottom:20px">You were invited to give 360 feedback for <strong>${leader.name}</strong>, and we have not received your responses yet. Your perspective genuinely shapes what this report can tell them.</p>`
    }
    <div style="background:#FBF5EC;border-left:4px solid #A9633D;padding:14px 18px;border-radius:0 6px 6px 0;margin-bottom:26px">
      <div style="font-size:14px;color:#30383B;line-height:1.7">This survey closes on <strong>${closes}</strong>. After that the link will no longer accept responses.</div>
    </div>
    <div style="text-align:center;margin-bottom:24px">
      <a href="${surveyUrl}" style="display:inline-block;background:#A9633D;color:#fff;padding:14px 40px;border-radius:6px;font-size:15px;font-weight:bold;text-decoration:none">Complete the Survey</a>
    </div>
    <p style="color:#595959;font-size:12px;line-height:1.7">It takes about 10 minutes.${isSelf ? '' : ' Your responses are completely anonymous.'}</p>
    <p style="color:#bbb;font-size:11px;margin-top:24px;border-top:1px solid #EDE8DF;padding-top:16px">
      If the button does not work, copy and paste this link:<br/>
      <span style="color:#A9633D">${surveyUrl}</span>
    </p>
  </div>
  <div style="background:#F7F4EF;padding:16px 36px;text-align:center">
    <p style="color:#aaa;font-size:11px;margin:0">In Good Company Collective &nbsp;·&nbsp; CARE 360</p>
  </div>
</div>
</body></html>`;

  const text = `Hi ${rater.name},\n\nYour CARE 360 survey${isSelf ? '' : ` for ${leader.name}`} is still open and closes on ${closes}.\n\n${surveyUrl}\n\nIt takes about 10 minutes.\n\nIn Good Company Collective`;

  await resend.emails.send({ from: FROM, to: rater.email, subject, html, text });
}
module.exports = { sendRaterInvite, sendAdminNotice, sendRaterReminder };
