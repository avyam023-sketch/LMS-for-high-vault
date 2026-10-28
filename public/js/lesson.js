// Study-time tracking. The server credits real elapsed time only, so this script just keeps
// the clock running while the chapter is on screen. When the chapter has a native or Bunny Stream
// video, the learner must also watch it (almost) to the end before completing the chapter.
document.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('form[data-lesson]');
  if (!form) return;
  const button = form.querySelector('[data-complete]');
  const note = form.querySelector('[data-timer-note]');
  const csrf = form.querySelector('input[name=_csrf]').value;
  const required = Number(form.dataset.required);
  const video = document.querySelector('[data-lesson-video]');
  const player = document.querySelector('[data-lesson-player]');
  const watchKey = `hv-watched-${form.dataset.lesson}`;
  let watched = !video && !player;
  try {
    if (video && sessionStorage.getItem(watchKey) === '1') watched = true;
  } catch {
    /* storage unavailable */
  }
  let base = Number(form.dataset.spent);
  let localStart = Date.now();

  // Track the furthest point reached by actually playing, so skipping ahead doesn't count.
  let furthest = 0;
  let last = 0;
  function progress(t, duration) {
    // Only continuous playback that starts inside the part already watched moves the mark,
    // so seeking ahead and playing the last few seconds doesn't count as watching.
    const step = t - last;
    if (step > 0 && step < 2 && last <= furthest + 1) furthest = Math.max(furthest, t);
    last = t;
    if (duration && furthest / duration >= 0.95 && !watched) markWatched();
  }
  function markWatched() {
    watched = true;
    try { sessionStorage.setItem(watchKey, '1'); } catch { /* ignore */ }
    render();
  }

  if (video) {
    video.addEventListener('timeupdate', () => progress(video.currentTime, video.duration));
    video.addEventListener('seeking', () => { last = video.currentTime; });
  }

  if (player) {
    // Bunny Stream speaks the player.js protocol over postMessage: ask for "ready", then subscribe.
    const origin = new URL(player.src).origin;
    const send = (method, value) =>
      player.contentWindow?.postMessage(JSON.stringify({ context: 'player.js', version: '0.0.11', method, value, listener: 'hv' }), origin);
    let ready = false;
    let duration = 0;
    window.addEventListener('message', (e) => {
      if (e.origin !== origin || e.source !== player.contentWindow) return;
      let data;
      try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
      if (data?.context !== 'player.js') return;
      if (data.event === 'ready' && !ready) {
        ready = true;
        send('addEventListener', 'timeupdate');
        send('addEventListener', 'ended');
      } else if (data.event === 'timeupdate' && data.value) {
        duration = Number(data.value.duration) || duration;
        progress(Number(data.value.seconds) || 0, duration);
      } else if (data.event === 'ended' && !watched && duration && furthest / duration >= 0.9) {
        markWatched(); // the last timeupdate can land just short of 95%
      }
    });
    player.addEventListener('load', () => send('addEventListener', 'ready'));
    send('addEventListener', 'ready');
    // If the player never answers (old browser, blocked frame), don't trap the learner on this page.
    setTimeout(() => { if (!ready && !watched) markWatched(); }, 20000);
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
