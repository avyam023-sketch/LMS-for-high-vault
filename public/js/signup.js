// Sign-up as a deck of cards: one question at a time, checked before moving on. The form, field
// names and server checks are unchanged, and without JavaScript all four cards show as one form.
document.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('[data-signup]');
  if (!form || !document.documentElement.classList.contains('js')) return;
  window.hvSignup = true;
  const cards = [...form.querySelectorAll('[data-card]')];
  const dots = [...form.querySelectorAll('.su-dots li')];
  const stepLabel = document.querySelector('[data-signup-step]');
  let current = cards.findIndex((c) => c.classList.contains('is-active'));
  if (current < 0) current = 0;

  const STATES = ['is-active', 'is-done', 'is-next', 'is-next2', 'is-later'];
  function show(index, { focus = true } = {}) {
    current = index;
    cards.forEach((card, i) => {
      card.classList.remove(...STATES);
      card.classList.add(i === index ? 'is-active' : i < index ? 'is-done' : i === index + 1 ? 'is-next' : i === index + 2 ? 'is-next2' : 'is-later');
      card.inert = i !== index; // only the front card can be read or tabbed into
    });
    dots.forEach((d, i) => {
      d.classList.toggle('done', i < index);
      d.classList.toggle('current', i === index);
    });
    stepLabel.textContent = `Step ${index + 1} of ${cards.length}`;
    if (index === cards.length - 1) fillSummary();
    if (focus) {
      const target = cards[index].querySelector('[aria-invalid="true"]') ?? cards[index].querySelector('input:not([type=hidden]), button');
      // Wait for the card to arrive so the browser doesn't scroll to where it was.
      setTimeout(() => target?.focus({ preventScroll: true }), 260);
    }
  }

  // ---------- Per-card checks (the server checks everything again) ----------
  function setError(input, message) {
    const field = input.closest('.field');
    let err = field.querySelector('.err');
    if (!message) {
      input.removeAttribute('aria-invalid');
      err?.remove();
      return;
    }
    if (!err) {
      err = document.createElement('div');
      err.className = 'err';
      err.id = `e-${input.name}`;
      field.appendChild(err);
    }
    err.textContent = message;
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', err.id);
  }
  function check(card) {
    let ok = true;
    for (const input of card.querySelectorAll('input[name]:not([type=hidden])')) {
      let message = '';
      const v = input.type === 'checkbox' ? input.checked : input.value.trim();
      if (input.name === 'first_name' || input.name === 'last_name') {
        if (!v) message = `Enter your ${input.name === 'first_name' ? 'first' : 'last'} name.`;
      } else if (input.name === 'email') {
        if (!v) message = 'Enter your email address.';
        else if (!input.checkValidity()) message = 'Enter a valid email address, like name@example.com.';
      } else if (input.name === 'password') {
        if (input.value.length < 12) message = 'Use at least 12 characters.';
      } else if (input.name === 'confirm') {
        const pw = form.querySelector('input[name=password]').value;
        if (pw.length >= 12 && input.value !== pw) message = 'Passwords do not match.';
      } else if (input.name === 'terms' && !v) {
        message = 'Please confirm to continue.';
      }
      setError(input, message);
      if (message) ok = false;
    }
    if (!ok) {
      card.classList.remove('shake');
      void card.offsetWidth; // restart the animation
      card.classList.add('shake');
      card.querySelector('[aria-invalid="true"]')?.focus();
    }
    return ok;
  }

  form.addEventListener('click', (e) => {
    if (e.target.closest('[data-next]')) {
      if (check(cards[current])) show(current + 1);
    } else if (e.target.closest('[data-back]')) {
      show(current - 1);
    }
  });
  // Enter moves to the next card instead of submitting half the form.
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT' || e.target.type === 'checkbox') return;
    if (current < cards.length - 1) {
      e.preventDefault();
      if (check(cards[current])) show(current + 1);
    }
  });
  form.addEventListener('submit', (e) => {
    const bad = cards.findIndex((card) => !check(card));
    if (bad !== -1) {
      e.preventDefault();
      show(bad);
    }
  });
  form.addEventListener('input', (e) => {
    if (e.target.getAttribute('aria-invalid') === 'true') setError(e.target, '');
  });

  // ---------- Password strength ----------
  const pw = form.querySelector('input[name=password]');
  const meter = form.querySelector('[data-meter]');
  const bar = form.querySelector('[data-meter-bar]');
  const text = form.querySelector('[data-meter-text]');
  pw.addEventListener('input', () => {
    const v = pw.value;
    meter.hidden = !v;
    const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(v)).length;
    const score = v.length < 12 ? 1 : v.length >= 16 || (v.length >= 12 && kinds >= 3) ? 3 : 2;
    meter.dataset.score = String(score);
    bar.style.width = `${(score / 3) * 100}%`;
    text.textContent = score === 1 ? `${12 - v.length} more character${12 - v.length === 1 ? '' : 's'}` : score === 2 ? 'Good' : 'Strong';
  });

  // ---------- Review card ----------
  function fillSummary() {
    const val = (n) => form.querySelector(`input[name=${n}]`).value.trim();
    form.querySelector('[data-sum="name"]').textContent = `${val('first_name')} ${val('last_name')}`;
    form.querySelector('[data-sum="email"]').textContent = val('email');
    form.querySelector('[data-summary]').hidden = false;
  }

  show(current, { focus: current > 0 });
});
