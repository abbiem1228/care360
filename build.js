const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, LevelFormat, HeadingLevel, BorderStyle, WidthType,
  ShadingType, PageBreak
} = require('docx');

// IGC brand palette
const INK    = "30383B";   // almost-black ink
const CLAY   = "A9633D";   // terracotta / clay accent
const WARM   = "D9CBB2";   // sand / warm neutral
const PALE   = "F7F4EF";   // cream background
const GREY   = "595959";
const WHITE  = "FFFFFF";
const W      = 9360;       // content width DXA (Letter, 1in margins)

// ── helpers ──────────────────────────────────────────────────────────────────
function rule(color=CLAY) {
  return new Paragraph({ spacing:{after:160}, border:{bottom:{style:BorderStyle.SINGLE,size:6,color,space:4}} });
}
function sp(after=120){ return new Paragraph({spacing:{after}}); }

function body(text, opts={}) {
  return new Paragraph({ spacing:{after:140}, children:[
    new TextRun({ text, size:22, font:'Arial', bold:!!opts.bold, italics:!!opts.italic, color:opts.color||'262626' })
  ]});
}

function bullet(text) {
  return new Paragraph({
    numbering:{reference:'bullets',level:0}, spacing:{after:100},
    children:[new TextRun({text,size:22,font:'Arial'})]
  });
}

function sectionHeader(num, title, subtitle, framework) {
  return [
    new Paragraph({ heading:HeadingLevel.HEADING_2, spacing:{before:320,after:60}, children:[
      new TextRun({text:`Section ${num}  `, size:26,font:'Arial',bold:true,color:GREY}),
      new TextRun({text:title.toUpperCase(), size:26,font:'Arial',bold:true,color:INK})
    ]}),
    new Paragraph({ spacing:{after:80}, children:[
      new TextRun({text:subtitle, size:20,font:'Arial',italics:true,color:GREY})
    ]}),
    rule(WARM),
  ];
}

function openTextBox(selfText, raterText) {
  const makeBox = (label, text) => new Table({
    width:{size:W,type:WidthType.DXA}, columnWidths:[W],
    rows:[new TableRow({children:[new TableCell({
      width:{size:W,type:WidthType.DXA},
      shading:{fill:PALE,type:ShadingType.CLEAR},
      borders:{
        top:{style:BorderStyle.SINGLE,size:4,color:CLAY},
        bottom:{style:BorderStyle.SINGLE,size:4,color:CLAY},
        left:{style:BorderStyle.SINGLE,size:16,color:CLAY},
        right:{style:BorderStyle.NONE,size:0,color:WHITE}
      },
      margins:{top:100,bottom:100,left:180,right:180},
      children:[
        new Paragraph({spacing:{after:40},children:[
          new TextRun({text:label,bold:true,size:18,font:'Arial',color:CLAY})
        ]}),
        new Paragraph({spacing:{after:0},children:[
          new TextRun({text,size:19,font:'Arial',italics:true,color:GREY})
        ]})
      ]
    })]})
  ]});

  return [
    makeBox('Open Text - Self', selfText),
    sp(80),
    makeBox('Open Text - Rater', raterText),
  ];
}

function questionTable(questions) {
  const cb = {style:BorderStyle.SINGLE,size:2,color:"D8D0C4"};
  const borders = {top:cb,bottom:cb,left:cb,right:cb};

  const headerRow = new TableRow({children:[
    new TableCell({
      width:{size:480,type:WidthType.DXA},
      shading:{fill:INK,type:ShadingType.CLEAR}, borders,
      margins:{top:80,bottom:80,left:100,right:100},
      children:[new Paragraph({alignment:AlignmentType.CENTER,children:[
        new TextRun({text:'#',bold:true,color:WHITE,size:20,font:'Arial'})
      ]})]
    }),
    new TableCell({
      width:{size:4440,type:WidthType.DXA},
      shading:{fill:INK,type:ShadingType.CLEAR}, borders,
      margins:{top:80,bottom:80,left:120,right:120},
      children:[new Paragraph({children:[
        new TextRun({text:'Self Version',bold:true,color:WHITE,size:20,font:'Arial'})
      ]})]
    }),
    new TableCell({
      width:{size:4440,type:WidthType.DXA},
      shading:{fill:INK,type:ShadingType.CLEAR}, borders,
      margins:{top:80,bottom:80,left:120,right:120},
      children:[new Paragraph({children:[
        new TextRun({text:'Rater Version',bold:true,color:WHITE,size:20,font:'Arial'})
      ]})]
    }),
  ]});

  const dataRows = questions.map((q,i) => new TableRow({children:[
    new TableCell({
      width:{size:480,type:WidthType.DXA},
      shading:{fill:i%2===0?PALE:WHITE,type:ShadingType.CLEAR}, borders,
      margins:{top:80,bottom:80,left:100,right:100},
      children:[new Paragraph({alignment:AlignmentType.CENTER,children:[
        new TextRun({text:String(q.n),bold:true,size:20,font:'Arial',color:CLAY})
      ]})]
    }),
    new TableCell({
      width:{size:4440,type:WidthType.DXA},
      shading:{fill:i%2===0?PALE:WHITE,type:ShadingType.CLEAR}, borders,
      margins:{top:80,bottom:80,left:120,right:120},
      children:[new Paragraph({children:[
        new TextRun({text:q.self,size:19,font:'Arial'})
      ]})]
    }),
    new TableCell({
      width:{size:4440,type:WidthType.DXA},
      shading:{fill:i%2===0?PALE:WHITE,type:ShadingType.CLEAR}, borders,
      margins:{top:80,bottom:80,left:120,right:120},
      children:[new Paragraph({children:[
        new TextRun({text:q.rater,size:19,font:'Arial'})
      ]})]
    }),
  ]}));

  return new Table({
    width:{size:W,type:WidthType.DXA},
    columnWidths:[480,4440,4440],
    rows:[headerRow,...dataRows]
  });
}

function frameworkBox(items) {
  const cb={style:BorderStyle.SINGLE,size:2,color:"D8D0C4"};
  const borders={top:cb,bottom:cb,left:cb,right:cb};
  const rows = items.map(([label,text],i) => new TableRow({children:[
    new TableCell({
      width:{size:1400,type:WidthType.DXA},
      shading:{fill:INK,type:ShadingType.CLEAR}, borders,
      margins:{top:80,bottom:80,left:140,right:140},
      children:[new Paragraph({children:[
        new TextRun({text:label,bold:true,size:19,font:'Arial',color:WHITE})
      ]})]
    }),
    new TableCell({
      width:{size:7960,type:WidthType.DXA},
      shading:{fill:i%2===0?PALE:WHITE,type:ShadingType.CLEAR}, borders,
      margins:{top:80,bottom:80,left:140,right:140},
      children:[new Paragraph({children:[
        new TextRun({text,size:19,font:'Arial',color:'333333'})
      ]})]
    }),
  ]}));
  return new Table({width:{size:W,type:WidthType.DXA},columnWidths:[1400,7960],rows});
}

function scaleTable() {
  const cb={style:BorderStyle.SINGLE,size:2,color:"D8D0C4"};
  const borders={top:cb,bottom:cb,left:cb,right:cb};
  const cols=[1872,1872,1872,1872,1872];
  const data=[
    {n:'1',label:'Strongly\nDisagree',desc:'Not demonstrated'},
    {n:'2',label:'Disagree',desc:'Rarely demonstrated'},
    {n:'3',label:'Neither',desc:'Sometimes demonstrated'},
    {n:'4',label:'Agree',desc:'Consistently demonstrated'},
    {n:'5',label:'Strongly\nAgree',desc:'Demonstrated at a high level'},
  ];
  const numRow = new TableRow({children:data.map(d=>new TableCell({
    width:{size:1872,type:WidthType.DXA},
    shading:{fill:INK,type:ShadingType.CLEAR},
    borders,margins:{top:80,bottom:80,left:80,right:80},
    children:[new Paragraph({alignment:AlignmentType.CENTER,children:[
      new TextRun({text:d.n,bold:true,size:28,font:'Arial',color:WHITE})
    ]})]
  }))});
  const lblRow = new TableRow({children:data.map(d=>new TableCell({
    width:{size:1872,type:WidthType.DXA},
    shading:{fill:PALE,type:ShadingType.CLEAR},
    borders,margins:{top:80,bottom:80,left:80,right:80},
    children:[new Paragraph({alignment:AlignmentType.CENTER,children:[
      new TextRun({text:d.label,bold:true,size:18,font:'Arial',color:INK})
    ]})]
  }))});
  const descRow = new TableRow({children:data.map(d=>new TableCell({
    width:{size:1872,type:WidthType.DXA},
    shading:{fill:WHITE,type:ShadingType.CLEAR},
    borders,margins:{top:80,bottom:80,left:80,right:80},
    children:[new Paragraph({alignment:AlignmentType.CENTER,children:[
      new TextRun({text:d.desc,size:17,font:'Arial',italics:true,color:GREY})
    ]})]
  }))});
  return new Table({width:{size:W,type:WidthType.DXA},columnWidths:cols,rows:[numRow,lblRow,descRow]});
}

// ── QUESTION DATA ─────────────────────────────────────────────────────────────

const SECTIONS = [
  {
    num: 1, title: 'Connect',
    subtitle: 'Leadership starts with knowing who you\'re actually leading. A connected leader understands their people beyond their job description: their working style, what motivates them, what they\'re carrying, what they want out of their career and their life. Connection is not small talk. It is genuine interest in the person, not just the output.',
    openSelf:  'What else would you add about how you show up for and connect with the people you lead?',
    openRater: 'What additional feedback do you have about how this leader shows up for and connects with the people they lead?',
    questions: [
      { n:1,
        self:  'I know what motivates each person on my team: not just what they do, but what they care about and what they are working toward.',
        rater: 'This leader knows what motivates each person on their team: not just what they do, but what they care about and what they are working toward.' },
      { n:2,
        self:  'I adapt how I communicate and lead based on what I know about each person\'s working style and needs.',
        rater: 'This leader adapts how they communicate and lead based on what they know about each person\'s working style and needs.' },
      { n:3,
        self:  'I make time for real conversations, not just task check-ins, that reflect genuine interest in what my team members are experiencing at work and in their lives.',
        rater: 'This leader makes time for real conversations, not just task check-ins, that reflect genuine interest in what their team members are experiencing at work and in their lives.' },
      { n:4,
        self:  'People on my team feel genuinely known by me, not just managed.',
        rater: 'People on this leader\'s team feel genuinely known by them, not just managed.' },
      { n:5,
        self:  'When someone on my team is struggling, I notice and I do something about it.',
        rater: 'When someone on this leader\'s team is struggling, they notice and they do something about it.' },
      { n:6,
        self:  'I build relationships outside my immediate team. I invest in people across the organization, not just those who report to me.',
        rater: 'This leader builds relationships outside their immediate team. They invest in people across the organization, not just those who report to them.' },
    ]
  },
  {
    num: 2, title: 'Accountable',
    subtitle: 'Accountability means your word means something. You do what you say you will do. You communicate when things change. You do not disappear when things get hard. And you understand that being accountable is not just about your own performance: it is about taking seriously the responsibility you carry for the people in your charge.',
    openSelf:  'What else would you add about how you follow through on your commitments and take responsibility for your impact?',
    openRater: 'What additional feedback do you have about how this leader follows through on commitments and takes responsibility for their impact?',
    questions: [
      { n:7,
        self:  'I do what I say I am going to do. My commitments are reliable.',
        rater: 'This leader does what they say they are going to do. Their commitments are reliable.' },
      { n:8,
        self:  'When something goes wrong, I take ownership rather than deflecting or explaining it away.',
        rater: 'When something goes wrong, this leader takes ownership rather than deflecting or explaining it away.' },
      { n:9,
        self:  'I communicate proactively. My team is never left wondering where things stand or what has changed.',
        rater: 'This leader communicates proactively. I am never left wondering where things stand or what has changed.' },
      { n:10,
        self:  'I hold a fair and consistent standard. The same expectations apply to everyone, including myself.',
        rater: 'This leader holds a fair and consistent standard. The same expectations apply to everyone, including themselves.' },
      { n:11,
        self:  'I take seriously the responsibility I carry for the people in my charge, not just the results I am accountable for.',
        rater: 'This leader takes seriously the responsibility they carry for the people in their charge, not just the results they are accountable for.' },
      { n:12,
        self:  'When I make a mistake, I acknowledge it directly and move to fix it rather than moving past it quietly.',
        rater: 'When this leader makes a mistake, they acknowledge it directly and move to fix it rather than moving past it quietly.' },
    ]
  },
  {
    num: 3, title: 'Reach',
    subtitle: 'A leader with reach is thinking beyond today. They invest in the growth of the people around them, develop the next generation of leaders, and connect their team\'s daily work to a bigger purpose. They bring strategic thinking into everyday decisions and create momentum that extends beyond their own tenure.',
    openSelf:  'What else would you add about how you think strategically and invest in the growth of the people around you?',
    openRater: 'What additional feedback do you have about how this leader thinks strategically and invests in the development of their people?',
    questions: [
      { n:13,
        self:  'I connect my team\'s work to a bigger purpose. The people I lead understand why what we do matters.',
        rater: 'This leader connects our team\'s work to a bigger purpose. I understand why what we do matters.' },
      { n:14,
        self:  'I think ahead. I anticipate challenges and position my team before problems arrive.',
        rater: 'This leader thinks ahead. They anticipate challenges and position the team before problems arrive.' },
      { n:15,
        self:  'I actively invest in each person\'s development. I know where they want to grow and take concrete steps to help them get there.',
        rater: 'This leader actively invests in my development. They know where I want to grow and take concrete steps to help me get there.' },
      { n:16,
        self:  'I make good decisions. I weigh the right information, involve the right people, and commit when it is time to commit.',
        rater: 'This leader makes good decisions. They weigh the right information, involve the right people, and commit when it is time to commit.' },
      { n:17,
        self:  'I am building something that will last beyond my time in this role. I develop people, not just results.',
        rater: 'This leader is building something that will last beyond their time in this role. They develop people, not just results.' },
      { n:18,
        self:  'I have honest, specific conversations about each person\'s career trajectory, not just their current performance.',
        rater: 'This leader has honest, specific conversations about my career trajectory, not just my current performance.' },
    ]
  },
  {
    num: 4, title: 'Empower',
    subtitle: 'Empowerment is about what you make possible in others. It is real delegation: not just assigning tasks, but giving people ownership, authority, and room to make decisions. It is creating the kind of environment where people feel safe enough to take risks, make mistakes, and grow from both. An empowering leader does not need to be the smartest person in the room. They need to make the room smarter.',
    openSelf:  'What else would you add about the environment you create for your team and how you empower the people around you?',
    openRater: 'What additional feedback do you have about the environment this leader creates and how they empower the people around them?',
    questions: [
      { n:19,
        self:  'I give my team real ownership. I delegate authority, not just tasks.',
        rater: 'This leader gives their team real ownership. They delegate authority, not just tasks.' },
      { n:20,
        self:  'My team feels genuinely safe to speak up, push back, and share a different point of view without fear of consequences.',
        rater: 'This leader\'s team feels genuinely safe to speak up, push back, and share a different point of view without fear of consequences.' },
      { n:21,
        self:  'When someone on my team makes a mistake, I treat it as a learning opportunity rather than a liability.',
        rater: 'When someone on this leader\'s team makes a mistake, they treat it as a learning opportunity rather than a liability.' },
      { n:22,
        self:  'I get out of the way when I should. I do not over-direct or undermine my team\'s ability to lead in their own lane.',
        rater: 'This leader gets out of the way when they should. They do not over-direct or undermine my ability to lead in my own lane.' },
      { n:23,
        self:  'The people on my team can see their input shaping how we work. Contributing on my team leads to something.',
        rater: 'I can see my input shaping how we work. Contributing on this team actually leads to something.' },
      { n:24,
        self:  'After working with me, the people on my team are more capable than they were before.',
        rater: 'After working with this leader, I am more capable than I was before.' },
      { n:25,
        self:  'My team focuses on learning and fixing when things go wrong, not on blame or self-protection.',
        rater: 'When things go wrong on this team, we focus on learning and fixing, not on blame or self-protection.' },
    ]
  },
  {
    num: 5, title: 'Leadership Effectiveness',
    subtitle: 'The bottom-line read on how this leader performs in the operational and organizational dimensions of their role.',
    openSelf:  'What else would you add about your overall effectiveness as a leader?',
    openRater: 'What additional feedback do you have about this leader\'s overall effectiveness?',
    questions: [
      { n:26,
        self:  'I set clear expectations. The people on my team always know what success looks like in their role.',
        rater: 'This leader sets clear expectations. I always know what success looks like in my role.' },
      { n:27,
        self:  'I handle conflict and difficult conversations directly rather than avoiding them or letting them fester.',
        rater: 'This leader handles conflict and difficult conversations directly rather than avoiding them or letting them fester.' },
      { n:28,
        self:  'I advocate for my team. I represent their needs and interests to the people above me and across the organization.',
        rater: 'This leader advocates for their team. They represent our needs and interests to the people above them and across the organization.' },
      { n:29,
        self:  'My leadership makes the team around me stronger. We perform better because of how I show up.',
        rater: 'This leader\'s presence makes the team stronger. We perform better because of how they lead.' },
      { n:30,
        self:  'Overall, I am the kind of leader I would want to work for.',
        rater: 'Overall, this is the kind of leader I would want to work for.' },
    ]
  },
];

// ── BUILD ─────────────────────────────────────────────────────────────────────

const children = [];

// Title block
children.push(
  new Paragraph({spacing:{after:40},children:[
    new TextRun({text:'IN GOOD COMPANY', bold:true, size:18, font:'Arial', color:CLAY, charSpacing:200})
  ]}),
  new Paragraph({heading:HeadingLevel.TITLE, spacing:{after:80}, children:[
    new TextRun({text:'CARE 360', bold:true, size:64, font:'Arial', color:INK})
  ]}),
  new Paragraph({spacing:{after:60}, children:[
    new TextRun({text:'Leadership Survey', size:32, font:'Arial', color:GREY})
  ]}),
  new Paragraph({spacing:{after:200}, children:[
    new TextRun({text:'Survey Instrument  |  Version 1.0  |  2026', size:19, font:'Arial', color:GREY, italics:true})
  ]}),
  rule()
);

// Purpose
children.push(
  new Paragraph({heading:HeadingLevel.HEADING_1, spacing:{before:0,after:120}, children:[
    new TextRun({text:'Purpose', bold:true, size:30, font:'Arial', color:INK})
  ]}),
  body('The CARE 360 is a developmental tool, not an evaluation. Its purpose is to give each leader a fuller, more honest picture of how their leadership is experienced by the people around them.'),
  body('Most 360 tools are built around gap analysis: what is wrong, what is missing, where you fall short. The experience of receiving one is often defensive and deflating. CARE 360 is designed differently. Strength is the foundation. Growth is the invitation. Leaders who complete this process should feel seen, understand what is actionable, and want to get better from it rather than just survive the data.'),
  body('Feedback is collected from multiple rater groups: the leader\'s own self-assessment, their supervisor, peers, direct reports, and skip-level team members. Differences between those perspectives are often where the most useful development information lives.'),
  body('Responses are anonymous. No individual response can be attributed to a specific rater. The goal is honest, specific feedback, not a comfortable average.'),
  sp(), rule()
);

// Framework
children.push(
  new Paragraph({heading:HeadingLevel.HEADING_1, spacing:{before:0,after:120}, children:[
    new TextRun({text:'The CARE Framework', bold:true, size:30, font:'Arial', color:INK})
  ]}),
  body('CARE is the leadership framework at the heart of this assessment. Four pillars, each one a dimension of leadership behavior that consistently shapes team performance, engagement, and culture.'),
  sp(80),
  frameworkBox([
    ['C  Connect',    'Leadership starts with knowing who you are actually leading. A connected leader understands their people beyond their job description: their working style, what motivates them, what they are carrying, what they want out of their career and their life. Connection is not small talk. It is genuine interest in the person, not just the output.'],
    ['A  Accountable','Accountability means your word means something. You do what you say you will do. You communicate when things change. You do not disappear when things get hard. And you understand that being accountable is not just about your own performance: it is about taking seriously the responsibility you carry for the people in your charge.'],
    ['R  Reach',      'A leader with reach is thinking beyond today. They invest in the growth of the people around them, develop the next generation of leaders, and connect their team\'s daily work to a bigger purpose. They bring strategic thinking into everyday decisions and create momentum that extends beyond their own tenure.'],
    ['E  Empower',    'Empowerment is about what you make possible in others. It is real delegation: not just assigning tasks, but giving people ownership, authority, and room to make decisions. It is creating the kind of environment where people feel safe enough to take risks, make mistakes, and grow from both. An empowering leader does not need to be the smartest person in the room. They need to make the room smarter.'],
  ]),
  sp(160),
  body('A fifth section, Leadership Effectiveness, captures the operational and organizational dimensions that sit across all four pillars: clarity, conflict, advocacy, and overall impact.', {italic:true}),
  sp(), rule()
);

// Rating scale
children.push(
  new Paragraph({heading:HeadingLevel.HEADING_1, spacing:{before:0,after:120}, children:[
    new TextRun({text:'Rating Scale', bold:true, size:30, font:'Arial', color:INK})
  ]}),
  body('Each statement is rated on a 1 to 5 scale. A score of 4.0 or above indicates agreement that the behavior is consistently demonstrated. Scores below 4.0 represent development opportunities.'),
  sp(80), scaleTable(), sp(160),
  body('Rate based on your direct, observed experience with this leader, not what you have heard, assume, or hope. If you have had insufficient interaction to rate a specific item, select 3 rather than guessing.', {italic:true}),
  sp(), rule()
);

// Rater guidance
children.push(
  new Paragraph({heading:HeadingLevel.HEADING_1, spacing:{before:0,after:120}, children:[
    new TextRun({text:'Guidance for Raters', bold:true, size:30, font:'Arial', color:INK})
  ]}),
  body('Before you begin:', {bold:true}),
  bullet('Be specific. The most useful feedback comes from concrete behaviors you have observed, not general impressions.'),
  bullet('Be honest. A generous rating does not help a leader grow. Accuracy is the goal.'),
  bullet('Rate the person, not the context. External factors matter as context, but the leader\'s response to those factors is still observable and fair to assess.'),
  bullet('Your responses are anonymous. No individual response is shared. Open-text comments may appear in the leader\'s report in aggregate or lightly paraphrased.'),
  bullet('The open-text sections matter. Scores tell a leader what. Comments tell them why, and why is where growth actually happens.'),
  sp(80),
  body('A note on anonymity: rater groups with fewer than three respondents may be combined to protect individual privacy.', {italic:true, color:GREY}),
  sp(200)
);

// Page break before survey
children.push(new Paragraph({children:[new PageBreak()]}));

// Survey header
children.push(
  new Paragraph({spacing:{after:40}, children:[
    new TextRun({text:'THE SURVEY', bold:true, size:18, font:'Arial', color:CLAY, charSpacing:200})
  ]}),
  new Paragraph({heading:HeadingLevel.HEADING_1, spacing:{after:80}, children:[
    new TextRun({text:'30 Questions  |  5 Sections  |  Open Text After Each Section', size:26, font:'Arial', color:INK})
  ]}),
  body('All statements are written in the first person for the self-assessment version. The survey platform automatically displays the third-person rater version to all other rater groups. Both versions are shown here for reference.'),
  rule(INK)
);

// All sections
SECTIONS.forEach(s => {
  children.push(...sectionHeader(s.num, s.title, s.subtitle));
  children.push(questionTable(s.questions));
  children.push(sp(120));
  children.push(...openTextBox(s.openSelf, s.openRater));
  children.push(sp(220));
});

// Final question
children.push(
  rule(INK),
  new Paragraph({heading:HeadingLevel.HEADING_2, spacing:{before:200,after:80}, children:[
    new TextRun({text:'Final Question: Start, Stop, Continue', bold:true, size:26, font:'Arial', color:INK})
  ]}),
  body('Please share one specific thing you would like this leader to Start doing, one thing to Stop doing, and one thing to Continue doing. The most useful responses name a specific behavior, not a general impression.'),
  sp(80),
  ...openTextBox(
    'Thinking about your own leadership: what is one thing you want to Start doing, one thing you want to Stop doing, and one thing you want to Continue doing?',
    'Start: something this leader is not currently doing that would make them more effective. Stop: something this leader is doing that is getting in the way. Continue: something this leader does well and should keep doing.'
  ),
  sp(200)
);

// Design rationale page
children.push(
  new Paragraph({children:[new PageBreak()]}),
  new Paragraph({heading:HeadingLevel.HEADING_1, spacing:{before:0,after:120}, children:[
    new TextRun({text:'Design Rationale', bold:true, size:30, font:'Arial', color:INK})
  ]}),

  new Paragraph({heading:HeadingLevel.HEADING_2, spacing:{before:200,after:80}, children:[
    new TextRun({text:'Why 30 questions?', bold:true, size:24, font:'Arial', color:CLAY})
  ]}),
  body('Most commercial 360 instruments run between 16 and 42 questions. At 30, the CARE 360 sits squarely in the middle: comprehensive enough to surface meaningful patterns across five leadership dimensions, short enough to complete in 10-12 minutes without survey fatigue. Five sections of 5-7 questions each, plus open text and Start/Stop/Continue.'),

  new Paragraph({heading:HeadingLevel.HEADING_2, spacing:{before:200,after:80}, children:[
    new TextRun({text:'Why two versions of every question?', bold:true, size:24, font:'Arial', color:CLAY})
  ]}),
  body('String-replacement approaches (swapping "I" for "This leader") produce awkward sentences in complex items. Every question in the CARE 360 was written in both versions from the ground up, so the self and rater experiences both read naturally. The survey platform serves the correct version automatically based on rater group.'),

  new Paragraph({heading:HeadingLevel.HEADING_2, spacing:{before:200,after:80}, children:[
    new TextRun({text:'Why does Section 5 sit outside the CARE framework?', bold:true, size:24, font:'Arial', color:CLAY})
  ]}),
  body('The four CARE pillars are philosophically coherent. Adding operational questions (clarity, conflict, advocacy) inside Connect, Accountable, Reach, or Empower would dilute what each pillar means. Section 5 gives organizations the bottom-line operational read they need without compromising the framework\'s integrity. In reporting, it functions as a summary view alongside the CARE pillar scores.'),

  new Paragraph({heading:HeadingLevel.HEADING_2, spacing:{before:200,after:80}, children:[
    new TextRun({text:'Why does Question 30 ask what it asks?', bold:true, size:24, font:'Arial', color:CLAY})
  ]}),
  body('"Overall, this is the kind of leader I would want to work for" is a single-question trust index. It measures something no other item in the set measures directly: the cumulative, felt experience of being led by this person. A leader can score well on every dimension and still not pass this test. It will surface things no other question will, and it will stop leaders cold when they see it. That is by design.'),

  new Paragraph({heading:HeadingLevel.HEADING_2, spacing:{before:200,after:80}, children:[
    new TextRun({text:'Recommended rater group minimums', bold:true, size:24, font:'Arial', color:CLAY})
  ]}),
  body('To protect anonymity and produce reliable data:'),
  bullet('Self: 1 (always)'),
  bullet('Supervisor: 1 to 2'),
  bullet('Peers: minimum 3, recommended 4 to 6'),
  bullet('Direct Reports: minimum 3, recommended all if team is 6 or fewer'),
  bullet('Skip-Level: minimum 3, recommended 4 to 8'),
  body('Rater groups below 3 respondents will be combined with an adjacent group in reporting to protect individual anonymity.', {italic:true, color:GREY}),
  sp(200)
);

const doc = new Document({
  styles:{
    default:{document:{run:{font:'Arial',size:22,color:'262626'}}},
    paragraphStyles:[
      {id:'Title',name:'Title',basedOn:'Normal',next:'Normal',
       run:{size:64,bold:true,font:'Arial',color:INK},paragraph:{spacing:{before:0,after:120}}},
      {id:'Heading1',name:'Heading 1',basedOn:'Normal',next:'Normal',quickFormat:true,
       run:{size:30,bold:true,font:'Arial',color:INK},paragraph:{spacing:{before:320,after:160},outlineLevel:0}},
      {id:'Heading2',name:'Heading 2',basedOn:'Normal',next:'Normal',quickFormat:true,
       run:{size:24,bold:true,font:'Arial',color:CLAY},paragraph:{spacing:{before:240,after:120},outlineLevel:1}},
    ]
  },
  numbering:{config:[{
    reference:'bullets',
    levels:[{level:0,format:LevelFormat.BULLET,text:'\u2022',alignment:AlignmentType.LEFT,
      style:{paragraph:{indent:{left:720,hanging:360}}}}]
  }]},
  sections:[{
    properties:{page:{size:{width:12240,height:15840},margin:{top:1080,right:1080,bottom:1080,left:1080}}},
    children
  }]
});

const fs = require('fs');
Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync('CARE_360_Survey_Instrument.docx', buf);
  console.log('Wrote CARE_360_Survey_Instrument.docx');
});
