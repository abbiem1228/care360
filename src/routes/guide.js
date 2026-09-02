const express = require('express');
const router  = express.Router();

function requireAuth(req, res, next) {
  if (req.isAdmin) return next();
  res.redirect('/signin');
}

// ── Content ───────────────────────────────────────────────────────────
// Each block is independently searchable. Keep `tags` full of the words
// someone would actually type, not the words we happened to use.

const STEPS = [
  {
    n: '0',
    title: 'The three things',
    tags: 'group leader survey terminology what is a group what is a leader vocabulary difference between',
    body: `
      <p><strong>A Group</strong> is the container you create first. It has a name and a close date. "Q1 2027 Leadership Review" is a Group.</p>
      <p><strong>A leader</strong> is the person being assessed. You add leaders into a Group.</p>
      <p><strong>A survey</strong> is what a rater actually receives and fills out. Adding a leader creates their survey automatically, along with a self-assessment for that leader.</p>
      <div class="callout callout-sand">So the order is: create a Group, add a leader to it, and that leader's survey is ready to send.</div>`
  },
  {
    n: '1',
    title: 'Create a Group',
    tags: 'create new group name organization close date closes at opens deadline timeline how long two weeks',
    body: `
      <p><strong>Group name.</strong> Something you will recognize later. "Q1 2027 Leadership Review" rather than "Group 2." If you are running this for one organization, working the organization's name into the Group name makes it easy to find later.</p>
      <p><strong>Organization.</strong> Who this is for.</p>
      <p><strong>Closes at.</strong> Required. This is the date raters can no longer submit, for every leader in the Group.</p>
      <ul>
        <li>Shorter than one week is hard on anyone traveling or on leave</li>
        <li>Longer than three weeks and the invitation gets buried</li>
      </ul>
      <p><strong>Opens at.</strong> Optional. Leave it blank unless you want the Group to become available on a future date.</p>`
  },
  {
    n: '2',
    title: 'Add a leader',
    tags: 'add leader name title email department self assessment self-assessment',
    body: `
      <p>Name, title, email, department.</p>
      <p>Adding a leader creates their survey and their self-assessment automatically. You do not add the leader again as a rater.</p>
      <p>If the Group has a custom section attached, it applies to every leader added to that Group. See <strong>Custom questions</strong> below.</p>`
  },
  {
    n: '3',
    title: 'Add raters',
    tags: 'raters add rater how many minimum three supervisor peer direct report skip level rater group groups who to pick choose selecting',
    body: `
      <p>For each person: name, email, and their relationship to the leader.</p>
      <p><strong>Rater groups available</strong></p>
      <ul>
        <li>Supervisor</li>
        <li>Peer</li>
        <li>Direct report</li>
        <li>Skip-level</li>
      </ul>
      <p><strong>How many</strong></p>
      <ul>
        <li>Aim for six to ten raters plus the leader</li>
        <li>Three completed rater responses is the minimum before a report can be generated</li>
        <li>Use whichever rater groups reflect the leader's actual working relationships</li>
      </ul>
      <p>You do not need every rater group. If someone has two skip-level reports, use more peers instead. Balance across the rater groups you do use rather than forcing one that does not fit.</p>
      <div class="callout callout-sand">
        <strong>One thing to be aware of.</strong> A rater group with only one rater will show that person's score as a group average. It still appears in the report. If a rater group is that small, either fold those people into a larger group or note it when you debrief.
      </div>
      <p><strong>Who to pick.</strong> People who have worked with the leader recently and closely enough to have a real view. Someone who barely interacts with them will skip the survey or give you noise.</p>`
  },
  {
    n: '4',
    title: 'Activate the Group',
    tags: 'activate active draft status link not working error page turn on start',
    body: `
      <p>Click <strong>Activate</strong> on the Group page.</p>
      <div class="callout callout-clay">
        Until you do, rater links do not work. Anyone who receives an invitation early gets an error page.
      </div>
      <p>If the Group has leaders on it and is still in draft, a warning appears with the button.</p>`
  },
  {
    n: '5',
    title: 'Send the invitations',
    tags: 'send invites invitations email links unique forward spam heads up announce it allowlist whitelist deliverability',
    body: `
      <p>Click <strong>Send Invites</strong> on a leader. Each of their raters gets their own link.</p>
      <ul>
        <li>Links are unique to one person and cannot be forwarded</li>
        <li>You can click send again later. Only people who have not received one yet will get anything</li>
      </ul>
      <p><strong>Before you send, tell people it is coming.</strong> A short note from someone inside the organization, sent from their own address, does more for response rates than anything else. Include:</p>
      <ul>
        <li>Who is being assessed</li>
        <li>That responses are anonymous</li>
        <li>That the email is coming from CARE 360 and takes about ten minutes</li>
        <li>Roughly when it will arrive</li>
      </ul>
      <p>People expecting an email open it. People who are not may ignore it or mark it as spam.</p>
      <p>If the organization has an IT team that filters email, it is worth asking them to allow the sender in advance. If there is no IT team, telling people what to look for does the same job.</p>`
  },
  {
    n: '6',
    title: 'While it is open',
    tags: 'progress monitor track completion anonymous reminder automatic automated deadline closed nudge chase response rate lagging',
    body: `
      <p><strong>You can see</strong> who has been sent an invitation and who has completed, for every leader in the Group.</p>
      <p><strong>You cannot see</strong> what anyone said. Individual responses are never shown, only combined into group averages and quoted anonymously in the report.</p>
      <p><strong>Three things happen automatically</strong></p>
      <table class="guide-table">
        <thead><tr><th>When</th><th>What</th></tr></thead>
        <tbody>
          <tr><td>Two days before close</td><td>Anyone invited who has not finished gets one reminder</td></tr>
          <tr><td>When the last person finishes</td><td>You get an email confirming that leader is done</td></tr>
          <tr><td>When the close date passes</td><td>You get an email with the response count for each leader. The Group closes itself</td></tr>
        </tbody>
      </table>
      <p>If you have not heard from the platform, the Group is still running.</p>
      <p><strong>If completion is lagging</strong>, the most effective thing is not another email. It is someone inside the organization mentioning it in a team meeting.</p>`
  },
  {
    n: '7',
    title: 'Generate the report',
    tags: 'generate report pdf download minimum three greyed out button waiting how long what is in the report comments edited filtered',
    body: `
      <p>Available once three raters have completed for a leader, not counting the self-assessment. Until then the button shows the current count.</p>
      <ul>
        <li>You do not need to wait for everyone</li>
        <li>Nine of twelve responses is a good report</li>
        <li>Generation takes 30 to 60 seconds. Leave the page open</li>
      </ul>
      <p><strong>What is in it</strong></p>
      <ul>
        <li>Key insight and overview</li>
        <li>Each of the five CARE sections with scores by rater group, what is working, the growth edge, and any pattern between rater groups</li>
        <li>A custom section, if the Group has one, with its own score and comments</li>
        <li>Every comment, in full, exactly as written</li>
        <li>Start, Stop and Continue responses</li>
        <li>A note from the coach and reflection questions</li>
      </ul>
      <div class="callout callout-sage">
        Comments are never edited or filtered. If someone wrote something blunt, the leader reads it as written.
      </div>
      <p>Download the PDF. That is the version to send.</p>`
  },
  {
    n: '',
    title: 'Custom questions',
    tags: 'custom questions add on section additional five limit vetted score separate validity value initiative behavior track own questions insert',
    body: `
      <p>A Group can carry a small set of custom questions alongside the standard CARE instrument. This is for something specific to your organization that CARE does not cover directly, a stated value, a local initiative, a behavior you are tracking this year.</p>
      <p><strong>Where they live.</strong> Custom questions are set once on the Group, when you create it or before you activate it. They apply to every leader added to that Group. You cannot set different custom questions for different leaders in the same Group.</p>
      <p><strong>How many.</strong> Up to five. This is a deliberate limit. CARE is a validated instrument built from years of leadership research. A handful of custom questions add real, specific value without competing with that foundation. More than five starts to blur the line between what CARE measures and what your organization is asking about separately, and the report gets harder to write well.</p>
      <div class="callout callout-clay">
        <strong>Why the score stays separate.</strong> Custom questions get their own section in the report with their own score. They are never blended into a CARE score. A CARE section score means something specific because every question in it was written and tested to measure that exact thing. A custom question about your organization's values or a local priority almost certainly does not measure the same thing, even if it sounds related. Averaging it in would quietly change what that score means, and neither you nor the leader would be able to tell. Keeping it separate keeps every score in the report honest about what it actually reflects.
      </div>
      <p><strong>Writing a good custom question.</strong> Write the version a rater sees, describing the leader in the third person, the way every CARE rater question is written. The platform will draft a self-assessment version automatically, phrased as the leader describing themselves. Review that draft before saving. It is usually right, but it is worth a look, since an awkward self-assessment question is more noticeable to a leader than almost anything else in the report.</p>
      <p>Keep each question to one idea. "Communicates changes clearly and models our value of transparency" is really two questions wearing one sentence. Split it, or pick the one that matters more.</p>
      <p><strong>The comments box.</strong> The custom section has one open-text box at the end, the same pattern as every CARE section, rather than a box under each individual question.</p>`
  },
  {
    n: '8',
    title: 'Debrief and action plan',
    tags: 'debrief conversation meeting action plan template priorities reflection questions share send follow up',
    body: `
      <p><strong>Do not email the report and leave it there.</strong> That is the most common way this goes wrong.</p>
      <ul>
        <li>Send it shortly before you meet, or hand it over at the start</li>
        <li>Give the leader time to read it before discussing</li>
        <li>Expect the first reaction to be about the hardest comment. That is normal</li>
        <li>Use the reflection questions at the end of the report to guide the conversation</li>
      </ul>
      <p><strong>The action plan template</strong> is on any leader page under <strong>Action Plan Template</strong>. Send it after the debrief, once the leader has had time to sit with the feedback.</p>
      <p>It walks them through three priorities, what they will actually do, and check-in dates. Three is the limit. A plan with seven priorities is a wish list.</p>`
  }
];

const FAQS = [
  {
    q: 'A rater says their link does not work',
    tags: 'link broken not working error page expired dead invalid cannot open',
    a: 'The Group is probably not activated, or the close date has passed. Check the Group status. If it is active and open, make sure they are using the link from their own email, not one a colleague forwarded.'
  },
  {
    q: 'Someone did not receive their invitation',
    tags: 'not received missing email spam junk never got wrong address typo resend',
    a: 'Have them check spam first. If it is not there, check the email address on the leader page. To fix it: remove the rater, add them again with the correct address, send invites.'
  },
  {
    q: 'Can I extend the deadline?',
    tags: 'extend deadline close date change more time reopen closed early',
    a: 'Yes. Change the close date on the Group, and reopen it if it has already closed. This applies to every leader in the Group. Note that reminders only send once per person, so extending will not trigger a second one.'
  },
  {
    q: 'Someone wants to change their answers',
    tags: 'change edit answers resubmit mistake wrong answer redo undo',
    a: 'Not possible. Responses are final once submitted, and people are warned before they submit. If it genuinely matters, remove that rater and add them again for a new link.'
  },
  {
    q: 'Can I remove a rater?',
    tags: 'remove delete rater cannot submitted already responded',
    a: 'Only before they respond. Once someone submits, they cannot be removed, because deleting them would permanently destroy their feedback.'
  },
  {
    q: 'Can I see who said what?',
    tags: 'anonymous anonymity who said identify confidential privacy see responses individual',
    a: 'No. Completion status is visible, responses are not. This is what makes people willing to be honest.'
  },
  {
    q: 'The leader asks who gave a particular comment',
    tags: 'leader wants to know who wrote comment identify anonymity pressure',
    a: 'They will ask. The answer is no. Holding that line is what makes the next round possible.'
  },
  {
    q: 'Can I run another Group on the same leader?',
    tags: 'repeat again second group same leader compare progress six months later',
    a: 'Yes. Create a new Group and add them again. Comparing two reports six months apart is one of the more useful things you can do with this.'
  },
  {
    q: 'Can two leaders in the same Group have different custom questions?',
    tags: 'different custom questions per leader vary change one leader another',
    a: 'No. Custom questions apply to the whole Group. If you need different custom questions for different leaders, create separate Groups.'
  }
];

// ── Page ──────────────────────────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const stepCards = STEPS.map(s => `
    <div class="guide-block" data-search="step ${s.n} ${s.title.toLowerCase()} ${s.tags}">
      <div class="step-head">
        ${s.n ? `<div class="step-num">${s.n}</div>` : `<div class="step-num step-num-plain">&#9998;</div>`}
        <h2 class="step-title">${s.title}</h2>
      </div>
      <div class="step-body">${s.body}</div>
    </div>`).join('');

  const faqCards = FAQS.map((f, i) => `
    <div class="guide-block faq-block" data-search="${f.q.toLowerCase()} ${f.tags}">
      <div class="faq-q">${f.q}</div>
      <div class="faq-a">${f.a}</div>
    </div>`).join('');

  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>How it works — CARE 360</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--ink:#30383B;--clay:#A9633D;--sage:#7C8863;--sand:#D9CBB2;--cream:#F7F4EF;--warm:#EDE8DF;--grey:#595959;--shadow:0 1px 4px rgba(48,56,59,0.10)}
body{font-family:'Inter',Arial,sans-serif;background:var(--cream);color:var(--ink);font-size:14px}
a{color:var(--clay);text-decoration:none}a:hover{text-decoration:underline}

.admin-nav{background:var(--ink);height:56px;display:flex;align-items:center;padding:0 32px;gap:28px;box-shadow:0 2px 8px rgba(0,0,0,0.2);position:sticky;top:0;z-index:100}
.nav-logo{display:flex;align-items:center;gap:10px}
.nav-logo-mark{width:32px;height:32px;background:var(--clay);border-radius:6px;display:flex;align-items:center;justify-content:center;font-weight:700;color:white;font-size:11px;font-family:'EB Garamond',serif}
.nav-brand{color:white;font-weight:600;font-size:15px;font-family:'EB Garamond',serif;letter-spacing:0.3px}
.nav-link{color:rgba(255,255,255,0.6);font-size:13px;font-weight:500}
.nav-link:hover{color:white;text-decoration:none}
.nav-link.active{color:white}
.nav-spacer{flex:1}
.nav-user{display:flex;align-items:center;gap:8px;color:rgba(255,255,255,0.6);font-size:13px}
.nav-avatar{width:28px;height:28px;border-radius:50%;background:var(--clay);color:white;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700}

.guide-main{max-width:840px;margin:0 auto;padding:36px 24px 80px}
.guide-title{font-family:'EB Garamond',serif;font-size:30px;font-weight:600;margin-bottom:6px}
.guide-lede{font-size:14px;color:var(--grey);line-height:1.7;margin-bottom:24px}

.search-wrap{position:relative;margin-bottom:14px}
.search-box{width:100%;padding:13px 16px 13px 42px;border:1.5px solid var(--sand);border-radius:8px;font-size:15px;font-family:inherit;color:var(--ink);background:white;transition:border-color .15s,box-shadow .15s}
.search-box:focus{outline:none;border-color:var(--clay);box-shadow:0 0 0 3px rgba(169,99,61,0.12)}
.search-icon{position:absolute;left:15px;top:50%;transform:translateY(-50%);color:var(--sand);font-size:15px}
.search-count{font-size:12px;color:var(--grey);margin-bottom:22px;min-height:16px}

.toc{background:white;border:1px solid var(--warm);border-radius:10px;padding:18px 22px;margin-bottom:28px;box-shadow:var(--shadow)}
.toc-title{font-size:11px;font-weight:700;color:var(--grey);text-transform:uppercase;letter-spacing:0.7px;margin-bottom:12px}
.toc ol{margin:0;padding-left:20px}
.toc li{font-size:13.5px;line-height:2;color:var(--ink)}

.section-label{font-size:11px;font-weight:700;color:var(--clay);text-transform:uppercase;letter-spacing:1.2px;margin:34px 0 14px}

.guide-block{background:white;border:1px solid var(--warm);border-radius:10px;padding:22px 26px;margin-bottom:14px;box-shadow:var(--shadow)}
.step-head{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.step-num{width:28px;height:28px;border-radius:50%;background:var(--clay);color:white;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;flex-shrink:0}
.step-num-plain{background:var(--sage);font-size:13px}
.step-title{font-family:'EB Garamond',serif;font-size:21px;font-weight:600;color:var(--ink)}
.step-body p{font-size:14px;line-height:1.8;color:#454B4E;margin-bottom:12px}
.step-body p:last-child{margin-bottom:0}
.step-body ul{margin:0 0 12px 20px}
.step-body li{font-size:14px;line-height:1.85;color:#454B4E}
.step-body strong{color:var(--ink);font-weight:600}

.callout{border-radius:0 6px 6px 0;padding:13px 17px;margin:14px 0;font-size:13.5px;line-height:1.75;color:#454B4E}
.callout-sand{background:var(--cream);border-left:4px solid var(--sand)}
.callout-clay{background:#FBF5EC;border-left:4px solid var(--clay)}
.callout-sage{background:#F4F7F2;border-left:4px solid var(--sage)}

.guide-table{width:100%;border-collapse:collapse;margin:12px 0 14px}
.guide-table th{background:var(--ink);color:rgba(255,255,255,0.9);padding:9px 13px;text-align:left;font-size:11px;font-weight:600;letter-spacing:0.6px;text-transform:uppercase}
.guide-table th:first-child{border-radius:6px 0 0 0}
.guide-table th:last-child{border-radius:0 6px 0 0}
.guide-table td{padding:10px 13px;border-bottom:1px solid var(--warm);font-size:13.5px;color:#454B4E;line-height:1.6}
.guide-table tr:last-child td{border-bottom:none}

.faq-block{padding:18px 24px}
.faq-q{font-size:14px;font-weight:600;color:var(--ink);margin-bottom:7px}
.faq-a{font-size:13.5px;line-height:1.8;color:#454B4E}

.no-results{display:none;text-align:center;padding:44px 20px;color:var(--grey)}
.no-results-title{font-family:'EB Garamond',serif;font-size:20px;color:var(--ink);margin-bottom:8px}
.no-results-text{font-size:13.5px;line-height:1.7}

.guide-footer{text-align:center;margin-top:48px;padding-top:22px;border-top:1px solid var(--warm)}
.guide-footer-name{font-family:'EB Garamond',serif;font-size:14px;color:var(--ink);margin-bottom:4px}
.guide-footer-tag{font-size:10px;color:var(--sand);letter-spacing:1.5px;text-transform:uppercase}

@media(max-width:700px){.guide-main{padding:20px 14px 60px}.guide-block{padding:18px}.admin-nav{padding:0 16px;gap:16px}}
</style></head>
<body>
<nav class="admin-nav">
  <div class="nav-logo">
    <div class="nav-logo-mark">C</div>
    <span class="nav-brand">in good company.</span>
  </div>
  <a href="/admin" class="nav-link">Groups</a>
  <a href="/guide" class="nav-link active">How it works</a>
  <div class="nav-spacer"></div>
  <div class="nav-user">
    <div class="nav-avatar">A</div>
    <a href="/signout" class="nav-link">Sign out</a>
  </div>
</nav>

<div class="guide-main">
  <div class="guide-title">How CARE 360 works</div>
  <p class="guide-lede">Setup takes about ten minutes. Everything then runs itself until the close date you set. You come back at the end to generate the report.</p>

  <div class="search-wrap">
    <span class="search-icon">&#9906;</span>
    <input class="search-box" id="q" type="text" placeholder="Search. Try 'spam', 'deadline' or 'custom questions'" autocomplete="off"/>
  </div>
  <div class="search-count" id="count"></div>

  <div id="toc" class="toc">
    <div class="toc-title">At a glance</div>
    <ol>
      <li>Create a Group and set the close date</li>
      <li>Add a leader to the Group</li>
      <li>Add raters to that leader</li>
      <li>Activate the Group</li>
      <li>Send the invitations</li>
      <li>Wait. Reminders and deadlines are automatic</li>
      <li>Generate the report</li>
      <li>Debrief the leader and send the action plan template</li>
    </ol>
  </div>

  <div class="section-label" data-label="steps">Step by step</div>
  ${stepCards}

  <div class="section-label" data-label="faq">Common questions</div>
  ${faqCards}

  <div class="no-results" id="none">
    <div class="no-results-title">Nothing found</div>
    <div class="no-results-text">Try a different word, or clear the search to see everything.</div>
  </div>

  <div class="guide-footer">
    <div class="guide-footer-name">in good company.</div>
    <div class="guide-footer-tag">Thoughtful &nbsp;&middot;&nbsp; Innovative &nbsp;&middot;&nbsp; Human</div>
  </div>
</div>

<script>
(function () {
  var input  = document.getElementById('q');
  var count  = document.getElementById('count');
  var none   = document.getElementById('none');
  var toc    = document.getElementById('toc');
  var blocks = document.querySelectorAll('.guide-block');
  var labels = document.querySelectorAll('.section-label');

  function run() {
    var term = input.value.trim().toLowerCase();

    if (!term) {
      for (var i = 0; i < blocks.length; i++) blocks[i].style.display = '';
      for (var j = 0; j < labels.length; j++) labels[j].style.display = '';
      toc.style.display = '';
      none.style.display = 'none';
      count.textContent = '';
      return;
    }

    toc.style.display = 'none';
    var shown = 0;
    var seen  = {};

    for (var k = 0; k < blocks.length; k++) {
      var b = blocks[k];
      var hay = (b.getAttribute('data-search') || '') + ' ' + b.textContent.toLowerCase();
      var hit = hay.indexOf(term) !== -1;
      b.style.display = hit ? '' : 'none';
      if (hit) {
        shown++;
        seen[b.className.indexOf('faq-block') !== -1 ? 'faq' : 'steps'] = true;
      }
    }

    for (var m = 0; m < labels.length; m++) {
      var key = labels[m].getAttribute('data-label');
      labels[m].style.display = seen[key] ? '' : 'none';
    }

    none.style.display = shown ? 'none' : 'block';
    count.textContent = shown === 0
      ? ''
      : shown + (shown === 1 ? ' result' : ' results') + ' for "' + input.value.trim() + '"';
  }

  input.addEventListener('input', run);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { input.value = ''; run(); }
  });
})();
</script>
</body></html>`);
});

module.exports = router;
