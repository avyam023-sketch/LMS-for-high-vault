// Study-time tracking. The server credits real elapsed time only, so this
// script just keeps the clock running while the lesson is actually on screen.
document.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('form[data-lesson]');
  if (!form) return;
  const button = form.querySelector('[data-complete]');
  const note = form.querySelector('[data-timer-note]');
  const csrf = form.querySelector('input[name=_csrf]').value;
  const required = Number(form.dataset.required);
  let spent = Number(form.dataset.spent);
  let localStart = Date.now();
  let base = spent;

  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.max(0, Math.floor(s % 60))).padStart(2, '0')}`;
  function render() {
    const shown = document.hidden ? base : base + (Date.now() - localStart) / 1000;
    const left = Math.ceil(required - shown);
    if (left > 0) {
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
      note.textContent = `Keep reading — you can continue in ${fmt(left)}`;
    } else {
      button.disabled = false;
      button.removeAttribute('aria-disabled');
      note.textContent = '';
    }
  }

  async function beat() {
    if (document.hidden) return;
    try {
      const res = await fetch(`/learn/lessons/${form.dataset.lesson}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
        body: '{}',
        credentials: 'same-origin',
      });
      if (res.ok) {
        const data = await res.json();
        base = data.seconds;
        localStart = Date.now();
      }
    } catch {
      /* offline: try again next tick */
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      base += (Date.now() - localStart) / 1000;
    } else {
      localStart = Date.now();
      beat();
    }
  });

  setInterval(beat, 15000);
  setInterval(render, 1000);
  render();
});
