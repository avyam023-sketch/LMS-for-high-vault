// Preview mode for the static export. The pages are the real app's HTML; this stands in for the server:
// it answers the app's API calls, routes form posts to the screen that would follow, and runs the quizzes.
(() => {
  const data = JSON.parse(document.getElementById('demo-data').textContent);
  const { base } = data;
  const strip = (url) => {
    const p = new URL(url, location.href).pathname;
    return p.startsWith(base) ? p.slice(base.length) || '/' : p;
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  // ---------- Toast ----------
  let toastTimer;
  function toast(message) {
    let el = document.querySelector('.demo-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'demo-toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  // ---------- The app's API calls ----------
  let violations = 0;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const p = strip(url);
    const method = (init.method || 'GET').toUpperCase();
    let m;
    if ((m = p.match(/^\/exam\/[\w-]+\/paper$/))) {
      const paper = await (await realFetch(data.paperUrl)).json();
      paper.serverNow = new Date().toISOString();
      paper.expiresAt = new Date(Date.now() + data.timeLimitMinutes * 60_000).toISOString();
      paper.violations = 0;
      return json(paper);
    }
    if ((m = p.match(/^\/exam\/[\w-]+\/(\w+)$/)) && method === 'POST') {
      switch (m[1]) {
        case 'begin': return json({ redirect: data.examUrl });
        case 'answer': return json({ saved: true });
        case 'media': return json({ saved: true });
        case 'submit': return json({ redirect: data.resultUrl });
        case 'event': {
          const kind = JSON.parse(init.body || '{}').kind;
          if (['tab_hidden', 'window_blur', 'fullscreen_exit', 'camera_off', 'second_screen'].includes(kind)) violations = Math.min(violations + 1, 2);
          return json({ recorded: true, violations, maxViolations: 3 });
        }
        default: return json({ ok: true });
      }
    }
    if (/^\/learn\/lessons\/[\w-]+\/heartbeat$/.test(p)) return json({ seconds: 99999 });
    if (/^\/admin\/site-images\//.test(p) && method === 'POST') return json({ error: 'Uploading is turned off in this preview. In the live site the photo would appear straight away.' }, 400);
    return realFetch(input, init);
  };

  // ---------- Links to screens the preview doesn't include ----------
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-demo-off]');
    if (!a) return;
    e.preventDefault();
    toast('That screen isn’t part of this preview.');
  });

  // ---------- Forms ----------
  const go = (url) => window.location.assign(url);
  function routeForm(form, submitter) {
    const action = strip(form.getAttribute('action') || location.pathname);
    const method = (form.getAttribute('method') || 'get').toLowerCase();
    const fields = new FormData(form, submitter);

    if (method === 'get') {
      if (action === '/verify') {
        const code = String(fields.get('code') || '').trim().toUpperCase();
        return go(`${base}/verify/${code === data.verifyCode ? code : 'HV-0000-0000-0000'}/`);
      }
      const qs = [...fields].filter(([, v]) => v !== '').sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}-${v}`).join('~').replace(/[^\w.~-]/g, '_');
      const target = `${action.replace(/\/$/, '')}/${qs ? `_q/${qs}/` : ''}`;
      if (data.pages.includes(target)) return go(base + target);
      return toast('Search and filters are limited in this preview.');
    }

    if (action === '/login') {
      const email = String(fields.get('email') || '');
      return go(/admin|reviewer/i.test(email) ? data.adminUrl : data.dashboardUrl);
    }
    if (action === '/register') return go(data.dashboardUrl);
    if (action === '/logout') return go(data.homeUrl);
    if (/^\/learn\/[\w-]+\/exam\/start$/.test(action)) return go(data.checkinUrl);
    if (/^\/exam\/[\w-]+\/cancel$/.test(action)) return go(data.lobbyUrl);
    if (/^\/exam\/[\w-]+\/submit$/.test(action)) return go(data.resultUrl);
    if (/\/quiz$/.test(action) && data.page?.quiz) return checkQuiz(form);
    toast('Saving is turned off in this preview. In the live site this would be saved.');
  }

  document.addEventListener('submit', (e) => {
    if (e.defaultPrevented) return; // e.g. the user declined a confirmation prompt
    e.preventDefault();
    routeForm(e.target, e.submitter);
  });

  // ---------- Module quizzes: answer until correct ----------
  function checkQuiz(form) {
    const { correct, multi, next } = data.page.quiz;
    const chosen = [...form.querySelectorAll('input[name="option"]:checked')].map((i) => i.value);
    if (!chosen.length) return toast('Choose an answer first.');
    const right = chosen.length === correct.length && chosen.every((id) => correct.includes(id));
    if (right) return go(next);
    form.querySelectorAll('label.opt').forEach((label) => {
      const input = label.querySelector('input');
      label.classList.toggle('is-wrong', input.checked);
      input.checked = false;
    });
    let fb = form.parentElement.querySelector('.quiz-feedback.bad');
    if (!fb) {
      fb = document.createElement('div');
      fb.className = 'quiz-feedback bad';
      fb.setAttribute('role', 'alert');
      const strong = document.createElement('strong');
      strong.textContent = 'Not quite.';
      fb.append(strong, ' Look at the question again and try another answer.');
      form.before(fb);
    } else {
      fb.replaceWith(fb.cloneNode(true)); // re-announce
    }
    if (multi) toast('Select every correct answer.');
  }

  // ---------- Preview bar ----------
  document.addEventListener('DOMContentLoaded', () => {
    if (document.body.classList.contains('exam-mode')) return; // keep the exam screen clean
    const bar = document.createElement('aside');
    bar.className = 'demo-bar';
    bar.setAttribute('aria-label', 'Preview');
    const label = document.createElement('span');
    label.innerHTML = '<strong>Preview</strong> Sample data. Nothing you enter is saved.';
    const links = document.createElement('nav');
    for (const [text, href] of [['Website', data.homeUrl], ['Learner', data.dashboardUrl], ['Admin', data.adminUrl]]) {
      const a = document.createElement('a');
      a.href = href;
      a.textContent = text;
      if (strip(location.href).startsWith(strip(href)) && (text !== 'Website' || !/^\/(admin|dashboard|learn|exam|account)/.test(strip(location.href)))) {
        a.setAttribute('aria-current', 'true');
      }
      links.appendChild(a);
    }
    bar.append(label, links);
    document.body.appendChild(bar);
    document.body.classList.add('has-demo-bar');

    // Prefill sign-in so the presenter can just press the button.
    const login = document.querySelector(`form[action="${base}/login"]`);
    if (login) {
      const email = login.querySelector('input[name="email"]');
      const pw = login.querySelector('input[name="password"]');
      if (email && !email.value) email.value = data.logins.learner;
      if (pw) pw.value = 'sample-password';
      const hint = document.createElement('p');
      hint.className = 'demo-hint';
      hint.textContent = `Preview: sign in as ${data.logins.learner} for the learner area, or ${data.logins.admin} for the admin dashboard. Any password works.`;
      login.prepend(hint);
    }
  });
})();
