// Exam client. Grading, timing and question selection all happen on the server;
// this script renders the paper, autosaves answers and reports integrity events.
(() => {
  const main = document.querySelector('[data-exam]');
  if (!main) return;
  const attemptId = main.dataset.exam;
  const csrf = main.dataset.csrf;
  const $ = (sel) => document.querySelector(sel);
  const qcard = $('[data-qcard]');
  const palette = $('[data-palette]');
  const clockEl = $('[data-clock]');
  const clockText = $('[data-clock-text]');
  const saveState = $('[data-save-state]');
  const warnOverlay = $('[data-warning-overlay]');
  const warnText = $('[data-warning-text]');
  const submitOverlay = $('[data-submit-overlay]');
  const startOverlay = $('[data-start-overlay]');

  let paper;
  let current = 0;
  let offset = 0; // serverNow - clientNow
  let finished = false;
  let started = false;
  const pending = new Map();

  const post = (path, body) =>
    fetch(`/exam/${attemptId}/${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify(body ?? {}),
    });

  function leave(url) {
    finished = true;
    window.location.replace(url);
  }

  // ---------- Watermark ----------
  const wm = $('[data-watermark]');
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 3; x++) {
      const s = document.createElement('span');
      s.textContent = wm.dataset.watermark;
      s.style.left = `${x * 38 - 8 + (y % 2) * 18}%`;
      s.style.top = `${8 + y * 18}%`;
      wm.appendChild(s);
    }
  }

  // ---------- Rendering ----------
  function el(tag, attrs = {}, text) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text != null) node.textContent = text; // never innerHTML: question text is data
    return node;
  }

  function render() {
    const q = paper.questions[current];
    qcard.replaceChildren();
    qcard.append(
      el('p', { class: 'qnum' }, `Question ${q.number} of ${paper.questions.length}${q.kind === 'multi' ? ' · select all that apply' : ''}`),
      el('h2', { class: 'qprompt', id: 'qprompt' }, q.prompt),
    );
    const group = el('div', { role: q.kind === 'multi' ? 'group' : 'radiogroup', 'aria-labelledby': 'qprompt' });
    q.options.forEach((o) => {
      const label = el('label', { class: 'opt' });
      const input = el('input', { type: q.kind === 'multi' ? 'checkbox' : 'radio', name: `q-${q.id}`, value: o.id });
      input.checked = q.selected.includes(o.id);
      input.addEventListener('change', () => {
        q.selected = [...group.querySelectorAll('input:checked')].map((i) => i.value);
        queueSave(q);
        renderPalette();
      });
      label.append(input, el('span', {}, o.body));
      group.append(label);
    });
    qcard.append(group);

    const nav = el('div', { class: 'qnav' });
    const prev = el('button', { class: 'btn btn-ghost', type: 'button' }, '← Previous');
    prev.disabled = current === 0;
    prev.addEventListener('click', () => go(current - 1));
    const last = current === paper.questions.length - 1;
    const next = el('button', { class: 'btn btn-primary', type: 'button' }, last ? 'Review & finish' : 'Next →');
    next.addEventListener('click', () => (last ? openSubmit() : go(current + 1)));
    nav.append(prev, next);
    qcard.append(nav);
    renderPalette();
  }

  function renderPalette() {
    palette.replaceChildren();
    paper.questions.forEach((q, i) => {
      const b = el('button', { type: 'button', 'aria-label': `Question ${i + 1}${q.selected.length ? ', answered' : ''}` }, String(i + 1));
      if (q.selected.length) b.classList.add('answered');
      if (i === current) {
        b.classList.add('current');
        b.setAttribute('aria-current', 'step');
      }
      b.addEventListener('click', () => go(i));
      palette.append(b);
    });
  }

  function go(i) {
    current = Math.max(0, Math.min(paper.questions.length - 1, i));
    render();
    qcard.querySelector('input')?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }

  // ---------- Autosave ----------
  function queueSave(q) {
    clearTimeout(pending.get(q.id));
    pending.set(q.id, setTimeout(() => save(q), q.kind === 'multi' ? 600 : 0));
    saveState.textContent = 'Saving…';
  }

  async function save(q, tries = 0) {
    try {
      const res = await post('answer', { questionId: q.id, optionIds: q.selected });
      if (res.status === 409) {
        const data = await res.json();
        return leave(data.redirect);
      }
      if (!res.ok) throw new Error(String(res.status));
      pending.delete(q.id);
      if (!pending.size) saveState.textContent = 'All answers saved';
    } catch {
      saveState.textContent = 'Connection lost — retrying…';
      if (tries < 6) setTimeout(() => save(q, tries + 1), 1500 * (tries + 1));
    }
  }

  // ---------- Timer ----------
  function tick() {
    const left = Math.max(0, new Date(paper.expiresAt).getTime() - (Date.now() + offset));
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    clockText.textContent = `${m}:${String(s).padStart(2, '0')}`;
    clockEl.classList.toggle('low', left < 5 * 60000);
    clockEl.setAttribute('aria-label', `${m} minutes ${s} seconds left`);
    if (left <= 0 && !finished) submitNow();
  }

  async function submitNow() {
    finished = true;
    try {
      const res = await post('submit');
      const data = await res.json();
      window.location.replace(data.redirect ?? `/exam/${attemptId}/result`);
    } catch {
      window.location.replace(`/exam/${attemptId}/result`);
    }
  }

  // ---------- Submit dialog ----------
  function openSubmit() {
    const answered = paper.questions.filter((q) => q.selected.length).length;
    const total = paper.questions.length;
    $('[data-submit-summary]').textContent =
      answered === total
        ? `You've answered all ${total} questions. You can't change answers after submitting.`
        : `You've answered ${answered} of ${total} questions. Unanswered questions are marked wrong.`;
    submitOverlay.hidden = false;
  }
  $('[data-open-submit]').addEventListener('click', openSubmit);
  $('[data-cancel-submit]').addEventListener('click', () => (submitOverlay.hidden = true));
  submitOverlay.querySelector('form').addEventListener('submit', () => {
    finished = true;
  });

  // ---------- Integrity monitoring ----------
  const WARNINGS = {
    tab_hidden: 'You left the exam page.',
    window_blur: 'You switched to another window.',
    fullscreen_exit: 'You left full screen.',
    camera_off: 'Your camera turned off.',
    second_screen: 'A second screen was connected.',
  };
  async function report(kind, detail) {
    if (finished || !started) return null;
    try {
      const res = await post('event', { kind, detail });
      const data = await res.json();
      if (data.redirect) {
        leave(data.redirect);
        return data;
      }
      if (WARNINGS[kind] && data.maxViolations > 0 && data.violations > 0) {
        const left = data.maxViolations - data.violations;
        warnText.textContent = `${WARNINGS[kind]} This was recorded (warning ${data.violations} of ${data.maxViolations}).${left === 0 ? ' One more and your exam is submitted automatically.' : ''}`;
        warnOverlay.hidden = false;
      }
      return data;
    } catch {
      return null; /* best effort */
    }
  }
  // Used by the camera monitor (exam-proctor.js) to report through the same channel.
  window.hvExam = { report, attemptId, csrf, isRunning: () => started && !finished };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) report('tab_hidden');
  });
  window.addEventListener('blur', () => report('window_blur'));
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && paper?.requireFullscreen) report('fullscreen_exit');
  });
  $('[data-resume]').addEventListener('click', async () => {
    warnOverlay.hidden = true;
    if (paper.requireFullscreen && !document.fullscreenElement) await enterFullscreen();
  });

  for (const type of ['copy', 'cut', 'paste']) {
    document.addEventListener(type, (e) => {
      e.preventDefault();
      report(type === 'paste' ? 'paste' : 'copy');
    });
  }
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    report('context_menu');
  });
  document.addEventListener('dragstart', (e) => e.preventDefault());
  window.addEventListener('beforeprint', () => report('print'));
  document.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if ((mod && ['c', 'x', 'v', 'p', 's', 'u', 'a', 'f'].includes(k)) || (mod && e.shiftKey && ['i', 'j', 'c'].includes(k)) || k === 'f12' || k === 'printscreen') {
      e.preventDefault();
      report(k === 'f12' || (mod && e.shiftKey) ? 'devtools' : 'shortcut', `${mod ? 'mod+' : ''}${e.shiftKey ? 'shift+' : ''}${k}`);
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (!finished) e.preventDefault();
  });

  async function enterFullscreen() {
    try {
      await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
    } catch {
      /* not supported (e.g. iPhone Safari): continue without it */
    }
  }

  // ---------- Boot ----------
  async function boot() {
    const res = await fetch(`/exam/${attemptId}/paper`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    const data = await res.json();
    if (!res.ok) return leave(data.redirect ?? '/dashboard');
    paper = data;
    offset = new Date(data.serverNow).getTime() - Date.now();
    const begin = async () => {
      if (data.proctored && window.hvProctorReady) await window.hvProctorReady;
      started = true;
      startOverlay.hidden = true;
      render();
      tick();
      setInterval(tick, 1000);
    };
    const fsSupported = Boolean(document.documentElement.requestFullscreen);
    if (data.requireFullscreen && fsSupported && !document.fullscreenElement) {
      startOverlay.hidden = false;
      $('[data-begin]').addEventListener('click', async () => {
        await enterFullscreen();
        begin();
      }, { once: true });
      tick();
    } else {
      begin();
    }
  }
  boot().catch(() => {
    qcard.replaceChildren(el('p', { class: 'center' }, 'Could not load the exam. Check your connection and refresh the page.'));
  });
})();
