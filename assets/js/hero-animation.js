/*
  Landing animation for the home page hero.

  One animation plays behind the hero card. The first one in ANIMATIONS (the
  fish tank) plays on every page load. At the top left of the hero, the switch
  button moves to the next animation and the label beside it names the one
  that is playing. Nothing is stored in the browser.

  A switch shows a loader: the playing animation fades out, the switch icon
  turns, and the label reads "loading · <name>" with three pulsing squares. It
  lasts LOADING_MS, or until the next file has loaded if that takes longer, and
  the switch ignores clicks meanwhile. If the file fails to load, the previous
  animation comes back.

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

  // The first entry plays on load; the switch steps through the list in order.
  // The murmuration is off for now. To bring it back, add this line after the fish tank:
  //   { id: "murmuration", name: "murmuration", file: "anim-murmuration.js" },
  const ANIMATIONS = [
    { id: "fish-tank", name: "fish tank", file: "anim-fish-tank.js" },
    { id: "conway", name: "conway's game of life", file: "anim-conway.js" },
  ];

  const hero = document.querySelector(".hero");
  if (!hero || !("ResizeObserver" in window) || !("IntersectionObserver" in window)) return;

  const label = hero.querySelector(".anim-label");
  const labelKey = hero.querySelector(".anim-label__key");
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

  // With Get in touch snapped into view, the hero's last strip sits behind the
  // sticky header, ending exactly at its edge. Shrinking the viewport by the
  // header's height plus 1px makes that count as off-screen, so the animation pauses.
  function visibleMargin() {
    const header = document.querySelector(".site-header");
    const covered = header ? Math.ceil(header.getBoundingClientRect().height) + 1 : 0;
    return `-${covered}px 0px 0px 0px`;
  }

  // After a switch, the loader shows for at least this long, and until the next
  // animation's file has loaded if that takes longer. The first load has no loader.
  const LOADING_MS = 3000;
  const FADE_MS = 400;   // matches the .hero__anim opacity transition in style.css

  let wanted = -1;       // index the visitor asked for most recently
  let canvas = null;
  let destroy = null;
  let busy = false;      // true while the loader shows; the switch ignores clicks

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Loader on: fade the playing animation out and stop it, spin the switch,
  // and name the animation that is on its way.
  function startLoading(entry) {
    busy = true;
    hero.classList.add("is-loading");
    button.setAttribute("aria-disabled", "true");
    labelKey.textContent = "loading · ";
    labelName.textContent = entry.name;
    if (canvas) {
      const old = canvas;
      const stop = destroy;
      canvas = destroy = null;
      old.classList.add("hero__anim--out");
      setTimeout(() => { if (stop) stop(); old.remove(); }, FADE_MS);
    }
  }

  function stopLoading() {
    busy = false;
    hero.classList.remove("is-loading");
    button.removeAttribute("aria-disabled");
    labelKey.textContent = "now playing · ";
  }

  async function show(index, { withLoader = false } = {}) {
    const previous = wanted;
    wanted = index;
    const entry = ANIMATIONS[index];
    if (withLoader) startLoading(entry);
    let mount;
    try {
      [mount] = await Promise.all([load(entry), withLoader ? wait(LOADING_MS) : null]);
    } catch (error) {
      console.warn("Landing animation:", error.message);
      if (withLoader) {
        stopLoading();
        if (previous >= 0) show(previous);   // already loaded, so it comes straight back
      }
      return;
    }
    if (wanted !== index) return;   // another switch came in while this one loaded

    // A fresh canvas per animation, so no drawing state carries over.
    if (destroy) destroy();
    if (canvas) canvas.remove();
    canvas = document.createElement("canvas");
    canvas.className = withLoader ? "hero__anim hero__anim--in" : "hero__anim";
    canvas.setAttribute("aria-hidden", "true");
    hero.prepend(canvas);
    destroy = mount(canvas, { visibleMargin: visibleMargin() });

    if (withLoader) stopLoading();
    labelName.textContent = entry.name;
    label.hidden = false;
    button.hidden = false;
  }

  button.addEventListener("click", () => {
    if (busy) return;
    show((Math.max(wanted, 0) + 1) % ANIMATIONS.length, { withLoader: true });
  });
  show(0);
})();
