(function() {
  'use strict';
  const form = document.getElementById('survey-form');
  if (!form) return;

  document.querySelectorAll('input[type="radio"]').forEach(input => {
    input.addEventListener('change', () => {
      const block = input.closest('.question-block');
      if (block) block.classList.add('answered');
    });
  });

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
          if (next) { next.checked = true; next.focus(); next.closest('.question-block')?.classList.add('answered'); }
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          const prev = options[idx - 1];
          if (prev) { prev.checked = true; prev.focus(); }
        }
      });
    });
  });
})();
