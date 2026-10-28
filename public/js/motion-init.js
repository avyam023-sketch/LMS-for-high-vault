// Runs before first paint on pages with motion. "js" lets the sign-up form show as cards and
// "motion" lets the stylesheet hold back elements that motion.js reveals, so nothing flashes.
// Visitors who ask for reduced motion get the content straight away.
(() => {
  const root = document.documentElement;
  root.classList.add('js');
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) root.classList.add('motion');
  // Failsafe: if the animation scripts never run, show everything as a normal page.
  window.addEventListener('load', () => setTimeout(() => {
    if (!window.hvMotion) root.classList.remove('motion');
    if (document.querySelector('[data-signup]') && !window.hvSignup) root.classList.remove('js');
  }, 1500));
})();
