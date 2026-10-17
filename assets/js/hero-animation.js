/*
  Landing animation for the home page hero.

  One animation plays behind the hero card. Each visit picks a different one
  from the previous visit. At the top left of the hero, the switch button moves
  to the next animation and the label beside it names the one that is playing.

  Each animation lives in its own file next to this one and is loaded the first
  time it is shown. A file registers a mount function:

    window.heroAnimationRegistry[id] = function mount(canvas, { visibleMargin }) { …; return destroy; }

  mount() draws into the canvas it is given, pauses itself while the canvas is
  off-screen, and returns destroy(), which stops it for good. visibleMargin is
  an IntersectionObserver rootMargin; it tells the animation to treat the area
  under the sticky header as off-screen. To add an animation, write a file like
  the others and add a line to ANIMATIONS.

  Without JavaScript none of this runs: the hero shows its normal background,
  and the button and label stay hidden.
*/
(() => {
  "use strict";

  const ANIMATIONS = [
    { id: "murmuration", name: "murmuration", file: "anim-murmuration.js" },
    { id: "conway", name: "conway's game of life", file: "anim-conway.js" },
    { id: "fish-tank", name: "fish tank", file: "anim-fish-tank.js" },
  ];
  const STORAGE_KEY = "hero-animation:last";

  const hero = document.querySelector(".hero");
  if (!hero || !("ResizeObserver" in window) || !("IntersectionObserver" in window)) return;

  const label = hero.querySelector(".anim-label");
  const labelName = hero.querySelector(".anim-label__name");
  const button = hero.querySelector(".anim-switch");
  const scriptBase = document.currentScript.src;   // animation files sit next to this one

  const registry = (window.heroAnimationRegistry = window.heroAnimationRegistry || {});
  const loading = new Map();

  // Loads an animation's file once and resolves with its mount function.
  function load(entry) {
    if (registry[entry.id]) return Promise.resolve(registry[entry.id]);
    if (!loading.has(entry.id)) {
      loading.set(entry.id, new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = new URL(entry.file, scriptBase).href;
        script.onload = () => (registry[entry.id]
          ? resolve(registry[entry.id])
          : reject(new Error(`${entry.file} did not register "${entry.id}"`)));
        script.onerror = () => {
          loading.delete(entry.id);   // let a later switch try again
          reject(new Error(`could not load ${entry.file}`));
        };
        document.head.appendChild(script);
      }));
    }
    return loading.get(entry.id);
  }

  // Storage can be blocked or unavailable; then each visit is simply random.
  function lastShown() {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
  }
  function remember(id) {
    try { localStorage.setItem(STORAGE_KEY, id); } catch { /* not remembered */ }
  }

  // With Get in touch snapped into view, the hero's last strip sits behind the
  // sticky header, ending exactly at its edge. Shrinking the viewport by the
  // header's height plus 1px makes that count as off-screen, so the animation pauses.
  function visibleMargin() {
    const header = document.querySelector(".site-header");
    const covered = header ? Math.ceil(header.getBoundingClientRect().height) + 1 : 0;
    return `-${covered}px 0px 0px 0px`;
  }

  // A random animation other than the one shown last time.
  function firstPick() {
    const last = lastShown();
    const choices = ANIMATIONS.filter((a) => a.id !== last);
    return ANIMATIONS.indexOf(choices[Math.floor(Math.random() * choices.length)]);
  }

  let wanted = -1;       // index the visitor asked for most recently
  let canvas = null;
  let destroy = null;

  async function show(index) {
    wanted = index;
    const entry = ANIMATIONS[index];
    let mount;
    try {
      mount = await load(entry);
    } catch (error) {
      console.warn("Landing animation:", error.message);
      return;
    }
    if (wanted !== index) return;   // another switch came in while this one loaded

    // A fresh canvas per animation, so no drawing state carries over.
    if (destroy) destroy();
    if (canvas) canvas.remove();
    canvas = document.createElement("canvas");
    canvas.className = "hero__anim";
    canvas.setAttribute("aria-hidden", "true");
    hero.prepend(canvas);
    destroy = mount(canvas, { visibleMargin: visibleMargin() });

    labelName.textContent = entry.name;
    label.hidden = false;
    button.hidden = false;
    remember(entry.id);
  }

  button.addEventListener("click", () => show((Math.max(wanted, 0) + 1) % ANIMATIONS.length));
  show(firstPick());
})();
