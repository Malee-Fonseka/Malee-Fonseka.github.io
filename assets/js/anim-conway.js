/*
  Landing animation: Conway's Game of Life.
  Ported from docs/animations/conway.html. Loaded on demand by
  hero-animation.js, which calls mountGameOfLife(canvas) and keeps the
  returned destroy() for when the visitor switches animation.

  Changes from the original:
    - no grid: the gap option and the gap pattern are gone, cells touch
    - no background: empty cells are transparent, and a cell's brightness is
      now its opacity, so trails fade into the page instead of into grey.
      Over the original background the colours come out the same.
    - colours come from --life-1 … --life-8, --life-light and --life-shade
    - accepts a visibleMargin option, so it can pause behind a sticky header
    - registers its mount function instead of mounting itself
*/
(() => {
  "use strict";

  /*
    Conway's Game of Life (B3/S23) on a toroidal grid.

    Lineage.  Every live cell carries a hue. A newborn takes the majority hue of
    its three parents, or a random parent's hue if all three differ, so colour
    regions compete and blend along their borders.

    Shades.  A cell's tone follows its age: a light tint when born, the base hue
    as an adult, then four darker shades mixed toward a dark grey. Active
    fronts read light; settled still lifes sink into deep tones.

    Motion.  Generations advance on a fixed clock. Between them each frame
    interpolates by phase t: newborns fade in, ageing cells darken through
    sub-tones, and dying cells drop to a dim ghost that fades over a few
    generations, leaving trails.

    Keeping it alive.  The rules stay pure B3/S23, so individual clusters still
    die. After each generation, keepAlive() plants a pattern into a cleared
    patch when one of these holds, in priority order:
      1. a hue falls below its population floor (immediately if it hits zero),
         so every colour family is on the board after every generation;
      2. a 16×16-cell region has been empty too long, so no area stays dark;
      3. the board has gone quiet, or too long has passed since the last stir.
    Revivals use long-growing methuselahs; stirs may also use spaceships.
    If the whole population collapses, the board is reseeded.

    Rendering.  Each cell's colour is looked up in a prebuilt table indexed by
    (hue, tone, brightness), written into a one-pixel-per-cell ImageData, and
    drawn upscaled without smoothing, so neighbouring cells touch with no grid
    lines. Empty cells are transparent and brightness is opacity, so the page
    behind the canvas shows through. A frame is a handful of canvas calls no
    matter how many cells there are.
  */

  const DEFAULTS = Object.freeze({
    cellSize: 10,                 // CSS px per cell; cells touch, with no grid lines
    generationTime: 0.14,         // seconds per generation
    maxGenerationsPerFrame: 2,    // catch-up limit after a slow frame
    initialDensity: 0.3,          // live fraction of a fresh soup
    territories: 8,               // hue regions in a fresh soup
    trailLength: 4,               // generations a dead cell takes to fade out
    ghostLevel: 0.38,             // brightness a dying cell drops to first
    keepAlive: true,              // false runs pure Life with no interventions
    hueFloor: 0.003,              // live fraction per hue below which it is revived
    hueReviveGap: 30,             // generations between revivals of the same hue
    regionSize: 16,               // cells per side of a watched region
    regionEmptyLimit: 50,         // generations a region may stay empty
    minSparkGap: 40,              // generations between stirs: at least...
    maxSparkGap: 120,             // ...and at most
    quietActivity: 0.006,         // births per cell per generation that counts as quiet
    reseedPopulation: 0.02,       // live fraction below which the board is reseeded
    warmUpGenerations: 6,
    reducedMotionGenerations: 240,
    seed: undefined,              // a number gives a repeatable run
    visibleMargin: "0px",         // rootMargin for the on-screen check; a negative top
                                  // margin excludes a sticky header's area
  });

  const TONES = 6;                                   // newborn, adult, four darker ages
  const TONE_STEPS = 4;                              // sub-steps between neighbouring tones
  const TONE_COUNT = (TONES - 1) * TONE_STEPS + 1;
  const LEVELS = 32;                                 // brightness steps, empty to fully lit
  const NEVER = 255;                                 // `since` value: nothing left to show
  const MAX_AGE = 65535;

  // How each tone is made from a base hue: [toward "light" or "shade", amount].
  const TONE_RECIPE = Object.freeze([
    ["light", 0.2],       // newborn
    ["shade", 0],         // adult
    ["shade", 0.15],
    ["shade", 0.27],
    ["shade", 0.38],
    ["shade", 0.48],      // long-lived
  ]);

  // Tone by age: newborn 0, ages 1–3 → 1, 4–7 → 2, 8–15 → 3, 16–31 → 4, 32+ → 5.
  const TONE_BY_AGE = new Uint8Array(64);
  for (let a = 1; a < 64; a++) TONE_BY_AGE[a] = Math.min(TONES - 1, 1 + (32 - Math.clz32(a >> 2)));
  const toneOf = (age) => (age < 64 ? TONE_BY_AGE[age] : TONES - 1);

  const FALLBACK_HUES = ["#34445e", "#2f5652", "#5e3533", "#6b5035", "#4a3b55"];

  // Small seeds that grow for hundreds of generations: used to revive.
  const METHUSELAHS = Object.freeze([
    ".OO|OO.|.O.",                  // R-pentomino
    ".O.....|...O...|OO..OOO",      // acorn
    "OOO|O.O|O.O",                  // pi-heptomino
    "O.OO|OOO.|.O..",               // B-heptomino
  ].map(parsePattern));

  // Everything a stir may drop, for variety.
  const PATTERNS = Object.freeze([
    ...METHUSELAHS,
    ...[
      "......O.|OO......|.O...OOO",   // diehard
      ".O.|..O|OOO",                  // glider
      ".O..O|O....|O...O|OOOO.",      // lightweight spaceship
    ].map(parsePattern),
  ]);

  /* ---------- simulation ---------- */

  class Life {
    constructor(config, rng, hueCount) {
      this.config = config;
      this.rng = rng;
      this.hueCount = hueCount;
      this.cols = 0;
      this.rows = 0;
      this.generation = 0;
      this.lastSpark = 0;
      this.population = 0;
      this.activity = config.quietActivity * 4;   // assume busy until measured
      this.hueCounts = new Uint32Array(hueCount);
      this.hueRevived = new Float64Array(hueCount).fill(-Infinity);
      this.sparks = { revive: 0, region: 0, stir: 0 };
      this.neighbours = new Int32Array(8);
      this.parents = new Uint8Array(3);
    }

    // Watched regions: each cell maps to one through a column and a row lookup.
    allocateRegions() {
      const size = this.config.regionSize;
      this.regionCols = Math.ceil(this.cols / size);
      this.regionRows = Math.ceil(this.rows / size);
      this.regionOfCol = Uint32Array.from({ length: this.cols }, (_, x) => Math.floor(x / size));
      this.regionOfRow = Uint32Array.from({ length: this.rows }, (_, y) => Math.floor(y / size) * this.regionCols);
      this.regionCount = new Uint32Array(this.regionCols * this.regionRows);
      this.regionEmpty = new Uint32Array(this.regionCols * this.regionRows);   // generations empty
    }

    // Keeps the existing cells, centred; only newly exposed area gets fresh soup.
    resize(cols, rows) {
      if (cols === this.cols && rows === this.rows) return;
      const old = this.cols > 0 ? {
        cols: this.cols, rows: this.rows,
        alive: this.alive, hue: this.hue, age: this.age, since: this.since, from: this.from,
      } : null;

      const n = cols * rows;
      this.cols = cols;
      this.rows = rows;
      this.alive = new Uint8Array(n);
      this.next = new Uint8Array(n);
      this.hue = new Uint8Array(n);
      this.age = new Uint16Array(n);
      this.since = new Uint8Array(n).fill(NEVER);
      this.from = new Float32Array(n);
      this.allocateRegions();

      let ox = 0;
      let oy = 0;
      if (old) {
        ox = Math.floor((cols - old.cols) / 2);
        oy = Math.floor((rows - old.rows) / 2);
        for (let y = 0; y < old.rows; y++) {
          const ny = y + oy;
          if (ny < 0 || ny >= rows) continue;
          for (let x = 0; x < old.cols; x++) {
            const nx = x + ox;
            if (nx < 0 || nx >= cols) continue;
            const j = y * old.cols + x;
            const i = ny * cols + nx;
            this.alive[i] = old.alive[j];
            this.hue[i] = old.hue[j];
            this.age[i] = old.age[j];
            this.since[i] = old.since[j];
            this.from[i] = old.from[j];
          }
        }
      }

      const isFresh = old
        ? (x, y) => x < ox || x >= ox + old.cols || y < oy || y >= oy + old.rows
        : () => true;
      this.seedSoup(isFresh);
    }

    // Random soup over the cells `include` accepts, hued by Voronoi territories.
    seedSoup(include = () => true) {
      const { cols, rows, rng, hueCount } = this;
      const { territories, initialDensity } = this.config;
      const offset = Math.floor(rng() * hueCount);
      const centres = Array.from({ length: territories }, (_, k) => ({
        x: rng() * cols,
        y: rng() * rows,
        hue: (k + offset) % hueCount,
      }));

      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          if (!include(x, y) || rng() >= initialDensity) continue;
          let best = Infinity;
          let hue = 0;
          for (const c of centres) {
            const dx = Math.min(Math.abs(x - c.x), cols - Math.abs(x - c.x));   // toroidal distance
            const dy = Math.min(Math.abs(y - c.y), rows - Math.abs(y - c.y));
            const d = dx * dx + dy * dy;
            if (d < best) { best = d; hue = c.hue; }
          }
          this.birth(y * cols + x, hue);
        }
      }
    }

    // Brightness a dead cell shows at the end of the current generation (t = 1).
    ghostAtEnd(since) {
      const { ghostLevel, trailLength } = this.config;
      if (since === NEVER) return 0;
      if (since === 0) return ghostLevel;
      return Math.max(0, ghostLevel * (1 - since / trailLength));
    }

    // birth() and kill() keep hueCounts current between steps, so several
    // keepAlive() triggers in one generation see each other's changes.
    birth(i, hue) {
      if (this.alive[i]) return;
      this.from[i] = this.ghostAtEnd(this.since[i]);
      this.alive[i] = 1;
      this.hue[i] = hue;
      this.age[i] = 0;
      this.hueCounts[hue]++;
    }

    kill(i) {
      if (!this.alive[i]) return;
      this.alive[i] = 0;
      this.since[i] = 0;
      this.hueCounts[this.hue[i]]--;
    }

    /*
      One generation. Only `alive` is double-buffered: hue, age and the fade
      fields are updated in place. That is safe because a birth reads only the
      hues of cells that were alive before the step, and those never change.
    */
    step() {
      const { cols, rows, alive, next, hue, age, since, from, hueCounts, regionCount, regionOfCol } = this;
      const { trailLength } = this.config;
      let births = 0;
      let population = 0;
      hueCounts.fill(0);
      regionCount.fill(0);

      for (let y = 0; y < rows; y++) {
        const up = (y === 0 ? rows - 1 : y - 1) * cols;
        const row = y * cols;
        const down = (y === rows - 1 ? 0 : y + 1) * cols;
        const regionRow = this.regionOfRow[y];

        for (let x = 0; x < cols; x++) {
          const left = x === 0 ? cols - 1 : x - 1;
          const right = x === cols - 1 ? 0 : x + 1;
          const i = row + x;
          const n =
            alive[up + left] + alive[up + x] + alive[up + right] +
            alive[row + left] + alive[row + right] +
            alive[down + left] + alive[down + x] + alive[down + right];

          if (alive[i]) {
            if (n === 2 || n === 3) {
              next[i] = 1;
              if (age[i] < MAX_AGE) age[i]++;
              population++;
              hueCounts[hue[i]]++;
              regionCount[regionRow + regionOfCol[x]]++;
            } else {
              next[i] = 0;
              since[i] = 0;
            }
          } else if (n === 3) {
            next[i] = 1;
            from[i] = this.ghostAtEnd(since[i]);
            hue[i] = this.parentHue(up, row, down, left, x, right);
            age[i] = 0;
            births++;
            population++;
            hueCounts[hue[i]]++;
            regionCount[regionRow + regionOfCol[x]]++;
          } else {
            next[i] = 0;
            const s = since[i];
            if (s !== NEVER) since[i] = s >= trailLength ? NEVER : s + 1;
          }
        }
      }

      this.alive = next;
      this.next = alive;
      this.generation++;
      this.population = population;

      const { regionEmpty } = this;
      for (let r = 0; r < regionCount.length; r++) regionEmpty[r] = regionCount[r] ? 0 : regionEmpty[r] + 1;

      const cells = cols * rows;
      this.activity += (births / cells - this.activity) * 0.1;
      if (!this.config.keepAlive) return;
      if (population < cells * this.config.reseedPopulation) this.seedSoup();
      this.keepAlive();
    }

    keepAlive() {
      const { config, generation, hueCount, hueCounts } = this;

      // 1. Every colour family keeps a foothold; a vanished one returns at once.
      const floor = Math.max(1, Math.round(this.cols * this.rows * config.hueFloor));
      const start = Math.floor(this.rng() * hueCount);
      for (let k = 0; k < hueCount; k++) {
        const h = (start + k) % hueCount;
        const due = generation - this.hueRevived[h] >= config.hueReviveGap;
        if (hueCounts[h] === 0 || (hueCounts[h] < floor && due)) {
          this.spark(h, METHUSELAHS, this.targetRegion());
          this.hueRevived[h] = generation;
          this.sparks.revive++;
        }
      }

      // 2. No region stays dark for long: refill every overdue one now.
      const { regionEmpty } = this;
      for (let r = 0; r < regionEmpty.length; r++) {
        if (regionEmpty[r] < config.regionEmptyLimit) continue;
        this.spark(this.rarestHue(), METHUSELAHS, r);
        this.sparks.region++;
      }

      // 3. A quiet board gets stirred, and so does one left alone too long.
      const gap = generation - this.lastSpark;
      const quiet = this.activity < config.quietActivity;
      if (gap >= config.maxSparkGap || (quiet && gap >= config.minSparkGap)) {
        this.spark(this.rarestHue(), PATTERNS, this.targetRegion());
        this.lastSpark = generation;
        this.sparks.stir++;
      }
    }

    // The region empty longest, else the least populated; random tie-break.
    targetRegion() {
      const { regionEmpty, regionCount } = this;
      const n = regionCount.length;
      const start = Math.floor(this.rng() * n);
      let best = start;
      for (let k = 1; k < n; k++) {
        const r = (start + k) % n;
        if (regionEmpty[r] > regionEmpty[best] ||
            (regionEmpty[r] === regionEmpty[best] && regionCount[r] < regionCount[best])) best = r;
      }
      return best;
    }

    // Majority hue of the three live neighbours; a random one if all differ.
    parentHue(up, row, down, left, x, right) {
      const { alive, hue, neighbours: nb, parents: p } = this;
      nb[0] = up + left;   nb[1] = up + x;   nb[2] = up + right;
      nb[3] = row + left;                    nb[4] = row + right;
      nb[5] = down + left; nb[6] = down + x; nb[7] = down + right;

      let found = 0;
      for (let k = 0; k < 8 && found < 3; k++) {
        if (alive[nb[k]]) p[found++] = hue[nb[k]];
      }
      if (p[0] === p[1] || p[0] === p[2]) return p[0];
      if (p[1] === p[2]) return p[1];
      return p[Math.floor(this.rng() * 3)];
    }

    // Clears a patch inside `region` and drops a randomly oriented pattern there.
    spark(hue, patterns, region) {
      const { cols, rows, rng } = this;
      const size = this.config.regionSize;
      const pattern = orient(patterns[Math.floor(rng() * patterns.length)], rng);
      const x0 = (region % this.regionCols) * size + Math.floor(rng() * Math.max(1, size - pattern.width));
      const y0 = Math.floor(region / this.regionCols) * size + Math.floor(rng() * Math.max(1, size - pattern.height));
      const margin = 2;
      const at = (x, y) => (((y % rows) + rows) % rows) * cols + (((x % cols) + cols) % cols);

      for (let dy = -margin; dy < pattern.height + margin; dy++) {
        for (let dx = -margin; dx < pattern.width + margin; dx++) this.kill(at(x0 + dx, y0 + dy));
      }
      for (const [px, py] of pattern.cells) this.birth(at(x0 + px, y0 + py), hue);

      // Mark the region as occupied so another trigger this generation looks elsewhere.
      this.regionEmpty[region] = 0;
      this.regionCount[region] += pattern.cells.length;
    }

    rarestHue() {
      const start = Math.floor(this.rng() * this.hueCount);   // random start breaks ties
      let best = start;
      for (let k = 1; k < this.hueCount; k++) {
        const h = (start + k) % this.hueCount;
        if (this.hueCounts[h] < this.hueCounts[best]) best = h;
      }
      return best;
    }
  }

  /* ---------- patterns ---------- */

  function parsePattern(source) {
    const lines = source.split("|");
    const cells = [];
    lines.forEach((line, y) => {
      for (let x = 0; x < line.length; x++) if (line[x] === "O") cells.push([x, y]);
    });
    return { width: Math.max(...lines.map((l) => l.length)), height: lines.length, cells };
  }

  // One of the 8 rotations and reflections of a pattern.
  function orient(pattern, rng) {
    const swap = rng() < 0.5;
    const flipX = rng() < 0.5;
    const flipY = rng() < 0.5;
    const width = swap ? pattern.height : pattern.width;
    const height = swap ? pattern.width : pattern.height;
    const cells = pattern.cells.map(([x, y]) => {
      let px = swap ? y : x;
      let py = swap ? x : y;
      if (flipX) px = width - 1 - px;
      if (flipY) py = height - 1 - py;
      return [px, py];
    });
    return { width, height, cells };
  }

  /* ---------- colour ---------- */

  const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

  function packPixel([r, g, b], a = 255) {
    return LITTLE_ENDIAN
      ? ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
      : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
  }

  function parseHex(value, fallback) {
    const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((value || "").trim());
    if (!match) return fallback === undefined ? null : parseHex(fallback);
    let hex = match[1];
    if (hex.length === 3) hex = hex.replace(/./g, "$&$&");
    const n = parseInt(hex, 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  }

  function mix(a, b, t) {
    return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * t));
  }

  function readColors(element) {
    const style = getComputedStyle(element);
    const read = (name, fallback) => parseHex(style.getPropertyValue(name), fallback);

    const hues = [];
    for (let k = 1; k <= 8; k++) {
      const hue = read(`--life-${k}`);
      if (!hue) break;
      hues.push(hue);
    }
    return {
      shade: read("--life-shade", "#141617"),
      light: read("--life-light", "#a9a49b"),
      hues: hues.length ? hues : FALLBACK_HUES.map((h) => parseHex(h)),
    };
  }

  /*
    lut[(hue * TONE_COUNT + tone) * LEVELS + level] is the packed pixel for a
    hue at a (sub-)tone, with brightness as opacity: a fading cell fades into
    whatever is behind the canvas instead of into a fixed empty-cell colour.
  */
  function buildPalette({ shade, light, hues }) {
    const lut = new Uint32Array(hues.length * TONE_COUNT * LEVELS);
    hues.forEach((base, h) => {
      const tones = TONE_RECIPE.map(([toward, amount]) => mix(base, toward === "light" ? light : shade, amount));
      for (let q = 0; q < TONE_COUNT; q++) {
        const f = q / TONE_STEPS;
        const lo = Math.floor(f);
        const hi = Math.min(lo + 1, TONES - 1);
        const color = mix(tones[lo], tones[hi], f - lo);
        for (let l = 0; l < LEVELS; l++) {
          lut[(h * TONE_COUNT + q) * LEVELS + l] = packPixel(color, Math.round((255 * l) / (LEVELS - 1)));
        }
      }
    });
    return {
      lut,
      hueCount: hues.length,
      empty: 0,   // fully transparent
    };
  }

  /* ---------- rendering ---------- */

  class Renderer {
    constructor(ctx, palette, config) {
      this.ctx = ctx;
      this.palette = palette;
      this.config = config;
      this.buffer = document.createElement("canvas");
      this.bufferCtx = this.buffer.getContext("2d");
    }

    // All sizes are in device pixels.
    resize(width, height, cellPx, cols, rows) {
      this.width = width;
      this.height = height;
      this.cellPx = cellPx;
      this.cols = cols;
      this.rows = rows;
      // Centre the grid so partial cells are split between opposite edges.
      this.offsetX = Math.floor((width - cols * cellPx) / 2);
      this.offsetY = Math.floor((height - rows * cellPx) / 2);

      this.buffer.width = cols;
      this.buffer.height = rows;
      this.image = this.bufferCtx.createImageData(cols, rows);
      this.pixels = new Uint32Array(this.image.data.buffer);
    }

    // t is the phase within the current generation, 0..1.
    draw(life, t) {
      const { ctx, pixels, palette, cellPx } = this;
      const { lut, empty } = palette;
      const { alive, hue, age, since, from } = life;
      const { ghostLevel, trailLength } = this.config;
      const e = t * t * (3 - 2 * t);   // smoothstep
      const top = LEVELS - 1;

      for (let i = 0; i < pixels.length; i++) {
        let level;
        let tone;
        const a = age[i];

        if (alive[i]) {
          if (a === 0) {
            level = from[i] + (1 - from[i]) * e;
            tone = 0;
          } else {
            level = 1;
            const before = toneOf(a - 1);
            tone = before + (toneOf(a) - before) * e;
          }
        } else {
          const s = since[i];
          if (s === NEVER) { pixels[i] = empty; continue; }
          level = s === 0
            ? 1 + (ghostLevel - 1) * e
            : ghostLevel * (1 - (s - 1 + t) / trailLength);
          tone = toneOf(a);   // the tone it died with
        }

        pixels[i] = lut[(hue[i] * TONE_COUNT + Math.round(tone * TONE_STEPS)) * LEVELS + Math.round(level * top)];
      }

      this.bufferCtx.putImageData(this.image, 0, 0);
      // Cells can be see-through, so clear the previous frame first.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.width, this.height);
      ctx.setTransform(1, 0, 0, 1, this.offsetX, this.offsetY);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.buffer, 0, 0, this.cols * cellPx, this.rows * cellPx);
    }
  }

  /* ---------- mounting ---------- */

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let r = Math.imul(a ^ (a >>> 15), a | 1);
      r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  /*
    Wires a Life board to a canvas: sizing, the animation loop, and pausing
    when the panel is off-screen or the viewer prefers reduced motion.
    Returns a function that tears everything down.
  */
  function mountGameOfLife(canvas, overrides = {}) {
    const config = Object.freeze({ ...DEFAULTS, ...overrides });
    const ctx = canvas.getContext("2d");
    const seed = config.seed ?? Math.floor(Math.random() * 4294967296);
    const palette = buildPalette(readColors(canvas));
    const life = new Life(config, mulberry32(seed), palette.hueCount);
    const renderer = new Renderer(ctx, palette, config);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const interval = config.generationTime;

    let started = false;
    let onScreen = true;
    let frameId = 0;
    let lastTime = 0;
    let backlog = 0;

    const phase = () => (frameId ? Math.min(backlog / interval, 1) : 1);

    function resize() {
      const { width, height } = canvas.getBoundingClientRect();
      if (width < 1 || height < 1) return;   // wait until the container has a size

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      const cellPx = Math.max(2, Math.round(config.cellSize * dpr));
      const cols = Math.ceil(canvas.width / cellPx);
      const rows = Math.ceil(canvas.height / cellPx);

      life.resize(cols, rows);
      renderer.resize(canvas.width, canvas.height, cellPx, cols, rows);

      if (!started) {
        started = true;
        const steps = reducedMotion.matches ? config.reducedMotionGenerations : config.warmUpGenerations;
        for (let s = 0; s < steps; s++) life.step();
      }
      renderer.draw(life, phase());   // resizing clears the canvas, so repaint now
      updateLoop();
    }

    function frame(now) {
      backlog += Math.min((now - lastTime) / 1000, 0.25);
      lastTime = now;

      let steps = 0;
      while (backlog >= interval && steps < config.maxGenerationsPerFrame) {
        life.step();
        backlog -= interval;
        steps++;
      }
      if (backlog >= interval) backlog = 0;   // fell behind: drop the rest

      renderer.draw(life, backlog / interval);
      frameId = requestAnimationFrame(frame);
    }

    function updateLoop() {
      const shouldRun = started && onScreen && !reducedMotion.matches;
      if (shouldRun && !frameId) {
        lastTime = performance.now();
        backlog = 0;
        frameId = requestAnimationFrame(frame);
      } else if (!shouldRun && frameId) {
        cancelAnimationFrame(frameId);
        frameId = 0;
      }
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);

    const visibilityObserver = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      updateLoop();
    }, { rootMargin: config.visibleMargin });
    visibilityObserver.observe(canvas);

    reducedMotion.addEventListener("change", updateLoop);

    return function destroy() {
      cancelAnimationFrame(frameId);
      frameId = 0;
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      reducedMotion.removeEventListener("change", updateLoop);
    };
  }

  (window.heroAnimationRegistry = window.heroAnimationRegistry || {})["conway"] = mountGameOfLife;
})();
