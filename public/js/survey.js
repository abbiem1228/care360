(function() {
  'use strict';
  const form = document.getElementById('survey-form');
  if (!form) return;

  // Progress: thin bar under the header plus an "x of y answered" count.
  const blocks        = document.querySelectorAll('.question-block');
  const progressFill  = document.getElementById('progress-fill');
  const progressCount = document.getElementById('progress-count');
  function updateProgress() {
    if (!progressFill || !progressCount) return;
    let done = 0;
    blocks.forEach(b => { if (b.querySelector('input[type="radio"]:checked')) done++; });
    progressFill.style.width = (blocks.length ? done / blocks.length * 100 : 0) + '%';
    progressCount.innerHTML = '<strong>' + done + '</strong> of ' + blocks.length + ' answered';
    progressCount.classList.toggle('done', done === blocks.length);
  }

  document.querySelectorAll('input[type="radio"]').forEach(input => {
    input.addEventListener('change', () => {
      const block = input.closest('.question-block');
      if (block) block.classList.add('answered');
      updateProgress();
    });
  });
  updateProgress();

  // ── One section at a time ─────────────────────────────────
  // Shows a single survey section with back / next buttons and a
  // step bar under the header. Without JavaScript the whole form
  // still renders as one page, exactly as before.
  const steps       = Array.from(form.querySelectorAll('.survey-section'));
  const submitBlock = form.querySelector('.submit-block');
  const intro       = document.querySelector('.survey-intro');
  const header      = document.querySelector('.survey-header');
  let current = 0, reached = 0;

  function stepTitle(s) {
    if (s.id === 'section-ssc') return 'start · stop · continue';
    if (s.id === 'section-custom') return 'more questions';
    const t = s.querySelector('.section-title');
    return t ? t.textContent.trim().toLowerCase() : '';
  }
  function stepComplete(s) {
    const qs = s.querySelectorAll('.question-block');
    for (const q of qs) if (!q.querySelector('input[type="radio"]:checked')) return false;
    return qs.length > 0 || steps.indexOf(s) < reached;
  }

  if (steps.length > 1 && submitBlock && header) {
    document.body.classList.add('stepped');

    const bar = document.createElement('nav');
    bar.className = 'step-bar';
    bar.setAttribute('aria-label', 'Survey sections');
    const barInner = document.createElement('div');
    barInner.className = 'step-bar-inner';
    bar.appendChild(barInner);
    steps.forEach((s, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'step';
      b.innerHTML = '<span class="step-n">' + (i + 1) + '</span><span class="step-t">' + stepTitle(s) + '</span>';
      b.addEventListener('click', () => { if (i <= reached) go(i); });
      barInner.appendChild(b);
    });
    header.appendChild(bar);

    steps.forEach((s, i) => {
      const nav = document.createElement('div');
      nav.className = 'step-nav';
      if (i > 0) {
        const back = document.createElement('button');
        back.type = 'button'; back.className = 'step-btn step-btn-ghost';
        back.textContent = 'back';
        back.addEventListener('click', () => go(i - 1));
        nav.appendChild(back);
      } else {
        nav.appendChild(document.createElement('span'));
      }
      if (i < steps.length - 1) {
        const err = document.createElement('span');
        err.className = 'step-error'; err.setAttribute('role', 'status');
        nav.appendChild(err);
        const next = document.createElement('button');
        next.type = 'button'; next.className = 'step-btn';
        next.textContent = 'next: ' + stepTitle(steps[i + 1]);
        next.addEventListener('click', () => {
          const missing = Array.from(s.querySelectorAll('.question-block')).filter(q => !q.querySelector('input[type="radio"]:checked'));
          s.querySelectorAll('.question-block.missing').forEach(q => q.classList.remove('missing'));
          if (missing.length) {
            missing.forEach(q => q.classList.add('missing'));
            err.textContent = missing.length === 1 ? 'One question still needs an answer.' : missing.length + ' questions still need an answer.';
            missing[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
          }
          err.textContent = '';
          go(i + 1);
        });
        nav.appendChild(next);
      }
      s.appendChild(nav);
    });

    form.addEventListener('change', e => {
      const q = e.target.closest('.question-block');
      if (q) q.classList.remove('missing');
      paintBar();
    });

    go(0, true);
  }

  function paintBar() {
    document.querySelectorAll('.step').forEach((b, i) => {
      b.classList.toggle('is-current', i === current);
      b.classList.toggle('is-done', i !== current && stepComplete(steps[i]));
      b.disabled = i > reached;
      if (i === current) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    });
  }

  function go(i, first) {
    current = i; reached = Math.max(reached, i);
    steps.forEach((s, j) => { s.hidden = j !== i; });
    submitBlock.hidden = i !== steps.length - 1;
    if (intro) intro.hidden = i !== 0;
    paintBar();
    const active = document.querySelector('.step.is-current');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'center' });
    if (!first) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Lets the submit check below jump to the section that holds a missing answer.
  window.__showStepFor = function (block) {
    const s = block.closest('.survey-section');
    const i = steps.indexOf(s);
    if (i >= 0 && document.body.classList.contains('stepped')) go(i, true);
  };

  const submitBtn   = document.getElementById('submit-btn');
  const submitError = document.getElementById('submit-error');

  form.addEventListener('submit', function(e) {
    const answered = new Set();
    document.querySelectorAll('input[type="radio"]:checked').forEach(input => {
      const m = input.name.match(/^q_(\d+)$/);
      if (m) answered.add(parseInt(m[1]));
    });

    if (answered.size < 30) {
      e.preventDefault();
      const missing = 30 - answered.size;
      submitError.textContent = `Please answer all 30 questions. You have ${missing} question${missing===1?'':'s'} remaining.`;
      submitError.classList.remove('hidden');

      for (let n = 1; n <= 30; n++) {
        if (!answered.has(n)) {
          const block = document.getElementById(`qb-${n}`);
          if (block) {
            if (window.__showStepFor) window.__showStepFor(block);
            block.scrollIntoView({ behavior: 'smooth', block: 'center' });
            block.style.borderColor = '#A94442';
            setTimeout(() => { block.style.borderColor = ''; }, 3000);
            break;
          }
        }
      }
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';
    submitError.classList.add('hidden');
  });

  document.querySelectorAll('.scale-row').forEach(row => {
    const options = row.querySelectorAll('input[type="radio"]');
    options.forEach((input, idx) => {
      input.addEventListener('keydown', e => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          const next = options[idx + 1];
          if (next) { next.checked = true; next.focus(); next.closest('.question-block')?.classList.add('answered'); updateProgress(); }
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          const prev = options[idx - 1];
          if (prev) { prev.checked = true; prev.focus(); prev.closest('.question-block')?.classList.add('answered'); updateProgress(); }
        }
      });
    });
  });
})();
