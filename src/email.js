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

module.exports = { sendRaterInvite };
