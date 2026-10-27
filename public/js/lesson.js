// Study-time tracking. The server credits real elapsed time only, so this script just keeps
// the clock running while the chapter is on screen. When the chapter has a native video, the
// learner must also watch it (almost) to the end before completing the chapter.
document.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('form[data-lesson]');
  if (!form) return;
  const button = form.querySelector('[data-complete]');
  const note = form.querySelector('[data-timer-note]');
  const csrf = form.querySelector('input[name=_csrf]').value;
  const required = Number(form.dataset.required);
  const video = document.querySelector('[data-lesson-video]');
  const watchKey = `hv-watched-${form.dataset.lesson}`;
  let watched = !video;
  try {
    if (video && sessionStorage.getItem(watchKey) === '1') watched = true;
  } catch {
    /* storage unavailable */
  }
  let base = Number(form.dataset.spent);
  let localStart = Date.now();

  if (video) {
    // Track the furthest point reached by actually playing, so skipping ahead doesn't count.
    let furthest = 0;
    let last = 0;
    video.addEventListener('timeupdate', () => {
      const t = video.currentTime;
      if (t - last > 0 && t - last < 2) furthest = Math.max(furthest, t);
      last = t;
      if (video.duration && furthest / video.duration >= 0.95 && !watched) {
        watched = true;
        try { sessionStorage.setItem(watchKey, '1'); } catch { /* ignore */ }
        render();
      }
    });
    video.addEventListener('seeking', () => { last = video.currentTime; });
  }

  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.max(0, Math.floor(s % 60))).padStart(2, '0')}`;
  function render() {
    const shown = document.hidden ? base : base + (Date.now() - localStart) / 1000;
    const left = Math.ceil(required - shown);
    let message = '';
    if (!watched) message = 'Watch the video to the end to continue.';
    else if (left > 0) message = `Keep reading — you can continue in ${fmt(left)}`;
    button.disabled = Boolean(message);
    button.toggleAttribute('aria-disabled', Boolean(message));
    note.textContent = message;
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
