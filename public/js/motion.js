// Homepage motion, built on GSAP + ScrollTrigger (self-hosted under /vendor/gsap).
// Restrained on purpose: content rises into place as it scrolls into view, the hero settles in on
// load, the "How it works" steps play out as you scroll, and the certificate tilts up to face you.
// Everything is visible without JavaScript, and nothing moves for visitors who prefer reduced motion.
(() => {
  const root = document.documentElement;
  const { gsap, ScrollTrigger } = window;
  if (!gsap || !ScrollTrigger || !root.classList.contains('motion')) {
    root.classList.remove('motion');
    return;
  }
  window.hvMotion = true;
  gsap.registerPlugin(ScrollTrigger);
  const ease = 'power3.out';
  const $ = (sel, scope = document) => [...scope.querySelectorAll(sel)];

  // ---------- Split headings into words that rise out of a mask ----------
  function split(el) {
    const words = [];
    const walk = (node) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === Node.TEXT_NODE) {
          const frag = document.createDocumentFragment();
          for (const part of child.textContent.split(/(\s+)/)) {
            if (!part) continue;
            if (/^\s+$/.test(part)) { frag.append(part); continue; }
            const outer = document.createElement('span');
            outer.className = 'w';
            const inner = document.createElement('span');
            inner.className = 'wi';
            inner.textContent = part;
            outer.append(inner);
            frag.append(outer);
            words.push(inner);
          }
          child.replaceWith(frag);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          walk(child);
        }
      }
    };
    walk(el);
    return words;
  }
  const words = (el) => {
    const w = split(el);
    gsap.set(el, { autoAlpha: 1 });
    gsap.set(w, { yPercent: 110 });
    return w;
  };

  // ---------- Hero: settles in on load ----------
  const hero = document.querySelector('[data-hero]');
  if (hero) {
    const h1 = hero.querySelector('[data-split]');
    const intro = $('[data-intro]:not([data-intro="card"])', hero);
    const card = hero.querySelector('[data-intro="card"]');
    gsap.set(intro, { autoAlpha: 0, y: 18 });
    if (card) gsap.set(card, { autoAlpha: 0, y: 40 });
    const tl = gsap.timeline({ defaults: { ease, duration: 0.9 } });
    tl.to(intro[0] ?? [], { autoAlpha: 1, y: 0, duration: 0.6 });
    if (h1) tl.to(words(h1), { yPercent: 0, stagger: 0.06, duration: 1 }, '-=0.3');
    tl.to(intro.slice(1), { autoAlpha: 1, y: 0, stagger: 0.12 }, '-=0.6');
    if (card) tl.to(card, { autoAlpha: 1, y: 0, duration: 1.1 }, '-=0.9');

    // A soft light drifts as the hero scrolls away.
    const glow = hero.querySelector('.hero-glow');
    if (glow) gsap.to(glow, { yPercent: 35, xPercent: -10, ease: 'none', scrollTrigger: { trigger: hero, start: 'top top', end: 'bottom top', scrub: true } });
  }

  // ---------- Generic reveals ----------
  for (const el of $('[data-reveal]')) {
    gsap.fromTo(el, { autoAlpha: 0, y: 28 }, { autoAlpha: 1, y: 0, duration: 0.9, ease, scrollTrigger: { trigger: el, start: 'top 88%', once: true } });
  }
  for (const group of $('[data-reveal-stagger]')) {
    const items = [...group.children];
    gsap.set(group, { autoAlpha: 1 });
    gsap.fromTo(items, { autoAlpha: 0, y: 24 }, {
      autoAlpha: 1, y: 0, duration: 0.8, ease, stagger: 0.08,
      scrollTrigger: { trigger: group, start: 'top 85%', once: true },
    });
  }
  for (const el of $('[data-split]')) {
    if (el.closest('[data-hero]')) continue;
    const w = words(el);
    gsap.to(w, { yPercent: 0, duration: 1, ease, stagger: 0.05, scrollTrigger: { trigger: el, start: 'top 85%', once: true } });
  }

  // ---------- Curriculum: a rail fills as you read down the path ----------
  const rail = document.querySelector('[data-rail]');
  if (rail) {
    gsap.fromTo(rail, { scaleY: 0 }, {
      scaleY: 1, ease: 'none',
      scrollTrigger: { trigger: rail.parentElement, start: 'top 70%', end: 'bottom 60%', scrub: 0.6 },
    });
  }

  // ---------- Certificate: tilts up to face the reader ----------
  const tilt = document.querySelector('[data-tilt]');
  if (tilt) {
    gsap.fromTo(tilt, { rotateX: 16, rotateY: -8, scale: 0.92, y: 60, autoAlpha: 0.4 }, {
      rotateX: 0, rotateY: 0, scale: 1, y: 0, autoAlpha: 1, ease: 'none',
      scrollTrigger: { trigger: tilt, start: 'top 95%', end: 'center 55%', scrub: 0.8 },
    });
  }

  // ---------- How it works: on wide screens the section holds while the steps play out ----------
  const steps = document.querySelector('[data-steps]');
  if (steps) {
    const items = [...steps.children];
    const mm = gsap.matchMedia();
    mm.add('(min-width: 900px) and (min-height: 640px)', () => {
      gsap.set(steps, { autoAlpha: 1 });
      gsap.set(items, { autoAlpha: 0.28 });
      const tl = gsap.timeline({
        scrollTrigger: { trigger: steps.closest('section'), start: 'center center', end: `+=${items.length * 260}`, pin: true, scrub: 0.6 },
      });
      items.forEach((li, i) => {
        tl.to(li, { autoAlpha: 1, duration: 0.4 }, i)
          .fromTo(li.querySelector('.step-bar') ?? li, { '--fill': 0 }, { '--fill': 1, duration: 0.6, ease: 'none' }, i);
      });
    });
    mm.add('(max-width: 899px), (max-height: 639px)', () => {
      gsap.set(steps, { autoAlpha: 1 });
      gsap.fromTo(items, { autoAlpha: 0, y: 24 }, { autoAlpha: 1, y: 0, duration: 0.8, ease, stagger: 0.1, scrollTrigger: { trigger: steps, start: 'top 85%', once: true } });
    });
  }

  // ---------- Header: gains depth once the page scrolls ----------
  const header = document.querySelector('.site-header');
  if (header) ScrollTrigger.create({ start: 8, onToggle: (self) => header.classList.toggle('scrolled', self.isActive) });

  // Fonts and lazy images change heights after load; re-measure so triggers fire in the right place.
  window.addEventListener('load', () => ScrollTrigger.refresh());
  document.fonts?.ready.then(() => ScrollTrigger.refresh());
})();
