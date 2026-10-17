/*
  Landing animation: murmuration.
  Ported from docs/animations/murmuration.html. Loaded on demand by
  hero-animation.js, which calls mountMurmuration(canvas) and keeps the
  returned destroy() for when the visitor switches animation.

  Changes from the original:
    - the birds wear Conway's five colours (--life-1 … --life-8): each bird
      keeps one flat colour for life, with no shades, drawn one fill per colour
    - accepts a visibleMargin option, so it can pause behind a sticky header
    - registers its mount function instead of mounting itself
  It already cleared to a transparent canvas, so the page shows through.
*/
"use strict";

/*
  Murmuration: a 2D flocking simulation.

  Each bird looks only at its 7 nearest neighbours (topological tracking).
  Each of those neighbours falls into one of three zones by distance:

    repulsion  (d < repulsionRadius)   move away; this overrides everything else
    alignment  (d < alignmentRadius)   match the neighbour's heading
    attraction (beyond that)           steer toward the neighbour

  Speed is matched to the neighbours' average. Turning is rate-limited
  and carries a little random noise, so no two runs are the same.
*/
(() => {
  const DEFAULTS = Object.freeze({
    // Who a bird watches
    neighbors: 7,               // topological: always the 7 nearest
    perceptionRadius: 220,      // px, upper limit so lone birds don't search the whole sky

    // Zones of interaction, px
    repulsionRadius: 11,        // larger than a bird, so birds never overlap
    alignmentRadius: 38,

    // How strongly each zone pulls on the desired heading
    alignmentWeight: 1,
    attractionWeight: 0.7,

    // Motion
    baseSpeed: 30,              // px/s at 1x
    speedMultiplier: 4,         // the 4x setting
    speedSpread: 0.25,          // birds cruise within ±25% of the base speed
    speedMatching: 1.5,         // 1/s, how fast a bird adopts its neighbours' speed
    maxTurnRate: 4,             // rad/s
    noise: 0.9,                 // rad/√s, random wobble in each bird's heading

    // Keep the flock inside the panel
    edgeMargin: 90,             // px
    edgeWeight: 2.5,

    // Population: one bird per areaPerBird px², within limits
    areaPerBird: 1500,
    minBirds: 120,
    maxBirds: 600,

    // Drawing, px
    birdLength: 7,
    birdWidth: 5,

    // Simulation clock
    step: 1 / 60,               // fixed timestep in seconds
    maxStepsPerFrame: 4,        // after a stall, skip time instead of catching up
    warmUpSteps: 120,           // simulated before the first frame, so it opens as a flock
    reducedMotionSteps: 400,    // simulated once, then drawn as a still image
    visibleMargin: "0px",       // rootMargin for the on-screen check; a negative top
                                // margin excludes a sticky header's area
  });

  const TAU = Math.PI * 2;

  class Flock {
    constructor(config, colorCount) {
      this.config = config;
      this.colorCount = colorCount;
      const capacity = config.maxBirds;

      // Struct-of-arrays: tight, allocation-free updates.
      this.x  = new Float32Array(capacity);
      this.y  = new Float32Array(capacity);
      this.vx = new Float32Array(capacity);
      this.vy = new Float32Array(capacity);
      this.nextVx = new Float32Array(capacity);  // every bird decides from the same snapshot
      this.nextVy = new Float32Array(capacity);
      this.colorOf = new Uint8Array(capacity);   // palette index, fixed for the bird's life
      this.count = 0;

      this.width = 0;
      this.height = 0;
      this.cruise = config.baseSpeed * config.speedMultiplier;

      // Uniform grid for neighbour search, rebuilt every step with a counting sort.
      this.cellSize = config.alignmentRadius * 0.65;
      this.cols = 0;
      this.rows = 0;
      this.cellStart = new Int32Array(1);
      this.cellCursor = new Int32Array(1);
      this.cellOf = new Int32Array(capacity);
      this.order = new Int32Array(capacity);
      this.maxRing = Math.ceil(config.perceptionRadius / this.cellSize);

      // Scratch space for the k-nearest search, sorted by distance.
      this.nearIndex = new Int32Array(config.neighbors);
      this.nearDist2 = new Float32Array(config.neighbors);
    }

    resize(width, height) {
      const firstSize = this.count === 0;
      this.width = width;
      this.height = height;

      this.cols = Math.max(1, Math.ceil(width / this.cellSize));
      this.rows = Math.max(1, Math.ceil(height / this.cellSize));
      const cells = this.cols * this.rows;
      if (this.cellCursor.length !== cells) {
        this.cellStart = new Int32Array(cells + 1);
        this.cellCursor = new Int32Array(cells);
      }

      const { areaPerBird, minBirds, maxBirds } = this.config;
      const target = Math.round(clamp((width * height) / areaPerBird, minBirds, maxBirds));

      if (firstSize) {
        this.spawnCluster(target);
      } else if (target > this.count) {
        this.addBirds(target - this.count);
      } else {
        this.count = target;  // the extra birds simply leave the sky
      }
    }

    // A loose, roughly aligned disc in the middle of the panel.
    spawnCluster(n) {
      const { repulsionRadius } = this.config;
      const radius = Math.sqrt(n) * repulsionRadius * 0.9;
      const heading = Math.random() * TAU;

      for (let i = 0; i < n; i++) {
        const r = radius * Math.sqrt(Math.random());
        const a = Math.random() * TAU;
        this.x[i] = this.width / 2 + Math.cos(a) * r;
        this.y[i] = this.height / 2 + Math.sin(a) * r;
        this.setVelocity(i, heading + (Math.random() - 0.5) * 0.6, this.randomCruise());
        this.colorOf[i] = i % this.colorCount;   // equal shares; positions are random
      }
      this.count = n;
    }

    // New birds join next to a random existing bird, flying its way.
    addBirds(n) {
      const { repulsionRadius } = this.config;
      for (let k = 0; k < n; k++) {
        const i = this.count++;
        const j = (Math.random() * (i || 1)) | 0;
        this.x[i] = this.x[j] + (Math.random() - 0.5) * repulsionRadius * 2;
        this.y[i] = this.y[j] + (Math.random() - 0.5) * repulsionRadius * 2;
        this.vx[i] = this.vx[j];
        this.vy[i] = this.vy[j];
        this.colorOf[i] = this.colorOf[j];       // joins in its neighbour's colour
      }
    }

    randomCruise() {
      return this.cruise * (1 + (Math.random() * 2 - 1) * this.config.speedSpread);
    }

    setVelocity(i, heading, speed) {
      this.vx[i] = Math.cos(heading) * speed;
      this.vy[i] = Math.sin(heading) * speed;
    }

    buildGrid() {
      const { cols, rows, cellSize, cellStart, cellCursor, cellOf, order, count } = this;
      cellCursor.fill(0);

      for (let i = 0; i < count; i++) {
        const cx = clamp((this.x[i] / cellSize) | 0, 0, cols - 1);
        const cy = clamp((this.y[i] / cellSize) | 0, 0, rows - 1);
        const c = cy * cols + cx;
        cellOf[i] = c;
        cellCursor[c]++;
      }

      cellStart[0] = 0;
      for (let c = 0; c < cellCursor.length; c++) {
        cellStart[c + 1] = cellStart[c] + cellCursor[c];
        cellCursor[c] = cellStart[c];
      }

      for (let i = 0; i < count; i++) {
        order[cellCursor[cellOf[i]]++] = i;
      }
    }

    /*
      Finds the k nearest birds to bird i by scanning rings of grid cells
      outward. It stops once the k-th distance is closer than anything an
      outer ring could hold, or at the perception limit. Returns how many
      neighbours were found; they sit in nearIndex / nearDist2, nearest first.
    */
    findNearest(i) {
      const { cols, rows, cellSize, cellStart, order, nearIndex, nearDist2, maxRing } = this;
      const k = this.config.neighbors;
      const perception2 = this.config.perceptionRadius ** 2;
      const xi = this.x[i];
      const yi = this.y[i];
      const cx0 = this.cellOf[i] % cols;
      const cy0 = (this.cellOf[i] / cols) | 0;
      let found = 0;

      for (let ring = 0; ring <= maxRing; ring++) {
        for (let cy = cy0 - ring; cy <= cy0 + ring; cy++) {
          if (cy < 0 || cy >= rows) continue;
          const onEdgeRow = cy === cy0 - ring || cy === cy0 + ring;
          // Inside rows only need the ring's two side cells.
          const stepX = onEdgeRow || ring === 0 ? 1 : ring * 2;

          for (let cx = cx0 - ring; cx <= cx0 + ring; cx += stepX) {
            if (cx < 0 || cx >= cols) continue;
            const c = cy * cols + cx;

            for (let p = cellStart[c]; p < cellStart[c + 1]; p++) {
              const j = order[p];
              if (j === i) continue;
              const dx = this.x[j] - xi;
              const dy = this.y[j] - yi;
              const d2 = dx * dx + dy * dy;
              if (d2 > perception2) continue;

              let slot;
              if (found < k) slot = found++;
              else if (d2 < nearDist2[k - 1]) slot = k - 1;
              else continue;

              while (slot > 0 && nearDist2[slot - 1] > d2) {
                nearDist2[slot] = nearDist2[slot - 1];
                nearIndex[slot] = nearIndex[slot - 1];
                slot--;
              }
              nearDist2[slot] = d2;
              nearIndex[slot] = j;
            }
          }
        }

        // Every bird in the next ring is at least ring * cellSize away.
        const reach = ring * cellSize;
        if (found === k && nearDist2[k - 1] <= reach * reach) break;
      }
      return found;
    }

    step(dt) {
      const c = this.config;
      const repulsion2 = c.repulsionRadius ** 2;
      const alignment2 = c.alignmentRadius ** 2;
      const minSpeed = this.cruise * (1 - c.speedSpread);
      const maxSpeed = this.cruise * (1 + c.speedSpread);
      const maxTurn = c.maxTurnRate * dt;
      const noiseAmount = c.noise * Math.sqrt(dt);
      const matchAmount = Math.min(1, c.speedMatching * dt);

      this.buildGrid();

      for (let i = 0; i < this.count; i++) {
        const xi = this.x[i];
        const yi = this.y[i];
        const vxi = this.vx[i];
        const vyi = this.vy[i];
        const speed = Math.hypot(vxi, vyi) || this.cruise;

        const found = this.findNearest(i);

        let repelX = 0, repelY = 0, repelN = 0;
        let alignX = 0, alignY = 0, alignN = 0;
        let attractX = 0, attractY = 0, attractN = 0;
        let speedSum = 0;

        for (let n = 0; n < found; n++) {
          const j = this.nearIndex[n];
          const d2 = this.nearDist2[n];
          const d = Math.sqrt(d2) || 1e-6;
          const ux = (this.x[j] - xi) / d;
          const uy = (this.y[j] - yi) / d;
          const vxj = this.vx[j];
          const vyj = this.vy[j];
          const sj = Math.hypot(vxj, vyj) || 1;
          speedSum += sj;

          if (d2 < repulsion2) {
            repelX -= ux; repelY -= uy; repelN++;
          } else if (d2 < alignment2) {
            alignX += vxj / sj; alignY += vyj / sj; alignN++;
          } else {
            attractX += ux; attractY += uy; attractN++;
          }
        }

        // Desired heading: repulsion wins outright; otherwise blend alignment and attraction.
        let wantX = 0, wantY = 0;
        if (repelN > 0) {
          wantX = repelX; wantY = repelY;
        } else {
          if (alignN > 0) {
            const m = Math.hypot(alignX, alignY) || 1;
            wantX += (alignX / m) * c.alignmentWeight;
            wantY += (alignY / m) * c.alignmentWeight;
          }
          if (attractN > 0) {
            const m = Math.hypot(attractX, attractY) || 1;
            wantX += (attractX / m) * c.attractionWeight;
            wantY += (attractY / m) * c.attractionWeight;
          }
        }
        if (wantX === 0 && wantY === 0) {
          wantX = vxi; wantY = vyi;  // nobody nearby: hold course
        } else {
          const m = Math.hypot(wantX, wantY);
          wantX /= m; wantY /= m;
        }

        // Soft walls: the closer to an edge, the harder the turn back inside.
        const m = c.edgeMargin;
        if (xi < m) wantX += ((m - xi) / m) * c.edgeWeight;
        else if (xi > this.width - m) wantX -= ((xi - (this.width - m)) / m) * c.edgeWeight;
        if (yi < m) wantY += ((m - yi) / m) * c.edgeWeight;
        else if (yi > this.height - m) wantY -= ((yi - (this.height - m)) / m) * c.edgeWeight;

        // Turn toward the desired heading, limited per step, plus noise.
        const heading = Math.atan2(vyi, vxi);
        const turn = clamp(wrapAngle(Math.atan2(wantY, wantX) - heading), -maxTurn, maxTurn);
        const nextHeading = heading + turn + (Math.random() * 2 - 1) * noiseAmount;

        // Ease toward the neighbours' average speed, within the cruise band.
        const targetSpeed = found > 0 ? speedSum / found : this.cruise;
        const nextSpeed = clamp(speed + (targetSpeed - speed) * matchAmount, minSpeed, maxSpeed);

        this.nextVx[i] = Math.cos(nextHeading) * nextSpeed;
        this.nextVy[i] = Math.sin(nextHeading) * nextSpeed;
      }

      [this.vx, this.nextVx] = [this.nextVx, this.vx];
      [this.vy, this.nextVy] = [this.nextVy, this.vy];

      for (let i = 0; i < this.count; i++) {
        this.x[i] += this.vx[i] * dt;
        this.y[i] += this.vy[i] * dt;
      }
    }

    // Each bird is a small dart pointing where it flies. Birds of one colour
    // share a path, so a frame is one fill per colour.
    draw(ctx, colors) {
      const half = this.config.birdLength / 2;
      const wing = this.config.birdWidth / 2;
      const notch = this.config.birdLength / 4;

      ctx.clearRect(0, 0, this.width, this.height);
      for (let c = 0; c < colors.length; c++) {
        ctx.fillStyle = colors[c];
        ctx.beginPath();
        for (let i = 0; i < this.count; i++) {
          if (this.colorOf[i] === c) this.trace(ctx, i, half, wing, notch);
        }
        ctx.fill();
      }
    }

    // Adds bird i's dart to the current path.
    trace(ctx, i, half, wing, notch) {
      const speed = Math.hypot(this.vx[i], this.vy[i]) || 1;
      const fx = this.vx[i] / speed;   // forward
      const fy = this.vy[i] / speed;
      const sx = -fy;                  // sideways
      const sy = fx;
      const x = this.x[i];
      const y = this.y[i];

      ctx.moveTo(x + fx * half, y + fy * half);
      ctx.lineTo(x - fx * half + sx * wing, y - fy * half + sy * wing);
      ctx.lineTo(x - fx * notch, y - fy * notch);
      ctx.lineTo(x - fx * half - sx * wing, y - fy * half - sy * wing);
      ctx.closePath();
    }
  }

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  function wrapAngle(a) {
    return a - TAU * Math.floor((a + Math.PI) / TAU);
  }

  // Conway's base colours, from the same CSS variables, so the two animations
  // always share one palette.
  function readColors(element) {
    const style = getComputedStyle(element);
    const colors = [];
    for (let k = 1; k <= 8; k++) {
      const value = style.getPropertyValue(`--life-${k}`).trim();
      if (!value) break;
      colors.push(value);
    }
    return colors.length ? colors : ["#34445e", "#2f5652", "#5e3533", "#6b5035", "#4a3b55"];
  }

  /*
    Wires a Flock to a canvas: sizing, the animation loop, and pausing when
    the panel is off-screen or the viewer prefers reduced motion.
    Returns a function that tears everything down.
  */
  function mountMurmuration(canvas, overrides = {}) {
    const config = Object.freeze({ ...DEFAULTS, ...overrides });
    const ctx = canvas.getContext("2d");
    const colors = readColors(canvas);
    const flock = new Flock(config, colors.length);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    let frameId = 0;
    let lastTime = 0;
    let backlog = 0;
    let onScreen = true;
    let started = false;

    function resize() {
      const { width, height } = canvas.getBoundingClientRect();
      if (width === 0 || height === 0) return;

      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      flock.resize(width, height);

      if (!started) {
        started = true;
        const steps = reducedMotion.matches ? config.reducedMotionSteps : config.warmUpSteps;
        for (let s = 0; s < steps; s++) flock.step(config.step);
      }
      flock.draw(ctx, colors);
      updateLoop();
    }

    function frame(now) {
      backlog += Math.min((now - lastTime) / 1000, 0.25);
      lastTime = now;

      let steps = 0;
      while (backlog >= config.step && steps < config.maxStepsPerFrame) {
        flock.step(config.step);
        backlog -= config.step;
        steps++;
      }
      if (steps === config.maxStepsPerFrame) backlog = 0;

      flock.draw(ctx, colors);
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

  (window.heroAnimationRegistry = window.heroAnimationRegistry || {})["murmuration"] = mountMurmuration;
})();
