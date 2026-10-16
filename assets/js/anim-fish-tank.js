/*
  Landing animation: fish tank.
  Ported from docs/animations/fish-tank.html. Loaded on demand by
  hero-animation.js, which calls mountFishTank(canvas) and keeps the
  returned destroy() for when the visitor switches animation.

  Changes from the original:
    - no grid: waterGap is 0 (its 1px minimum is gone), so ripple and dot
      squares touch. The fish are untouched; their dark edge is part of
      each fish's colouring, not a grid line.
    - no background: still water is transparent, and the canvas is cleared
      each frame. Ripples lay their crest or trough colour over the page at
      the original strength.
    - colours come from --tank-ripple, --tank-trough, --tank-dot-dark and
      --tank-dot-light
    - accepts a visibleMargin option, so it can pause behind a sticky header
    - registers its mount function instead of mounting itself
*/
(() => {
  "use strict";

  /*
    Fish tank: five pixel-art fish seen from above, in water that ripples.

    Fish body.  A spine of nodes from snout (s = 0) to tail-fin tip (s = 1).
    Motion is curvature along the spine, integrated into positions:

      curvature(s) = travelling wave   amp · envelope(s) · sin(2π(s/λ − phase))
                   + turn bend         proportional to yaw rate (the C-coil)
                   + pulse             a single tail flick (the twitch)

    Segment angles are re-centred so their mass-weighted mean is the heading,
    and the mass-weighted centroid is the fish's position (recoil).
    Thrust ∝ (tail-tip lateral speed)²; drag is linear + quadratic + fin drag.

    Pixel art.  Every frame each fish is rasterised onto a world-aligned square
    grid: each cell is tested against the bending body (nearest spine segment →
    distance along the body s, sideways offset d), then outlined and coloured.

    Behaviour.  hover → (twitch | fin flick)* → coil → burst → glide → cruise | hover
    Any calm fish whose personal space is entered startles: coil → small or long dash.

    Bodies.  Each fish is a chain of collider circles. They never overlap and
    never cross the glass.

    Water.  A 2D wave equation on a grid of square cells. Each dash splashes
    where it starts; the glass reflects the rings. Green dots on the same grid
    blink slowly; some drift a little around their home cell on a spring.

    Units.  Fish physics uses body lengths (L) and seconds; layout uses CSS px;
    drawing uses device pixels so every square lands on whole pixels.
  */

  const TAU = Math.PI * 2;

  const config = Object.freeze({
    fishCount: 5,

    // Fish length as a fraction of the tank's shorter side.
    lengthFraction: 0.13,
    minLength: 44,
    maxLength: 108,
    sizeVariation: 0.12,          // ± per fish
    fishPixelsPerLength: 26,      // pixel-art resolution along a body

    // Spine geometry (fractions of body length).
    nodeCount: 21,
    bodyEnd: 0.8,                 // caudal peduncle; the tail fin fills the rest
    maxHalfWidth: 0.092,          // widest point of the body
    tailNotch: 0.9,               // where the V between the lobes begins
    lobeHalfSpread: 0.12,         // half-spread of the forked tail at its tips
    lobeSweep: 0.035,             // lobe tips reach back past the last node
    pectoralNode: 5,              // s = 0.25
    pectoralLength: 0.17,
    pectoralWidth: 0.065,
    pectoralTucked: 0.22,         // rad from the body axis
    pectoralFlared: 1.35,
    eyeNode: 2,
    eyeOffset: 0.55,              // across the head, as a share of its half-width

    // Hydrodynamics (L, s).
    thrustGain: 0.9,              // thrust per (tail lateral speed)²
    maxTailSpeed: 7,              // a tail can only push water so hard
    dragLinear: 0.3,
    dragQuadratic: 0.55,
    finDrag: 2.2,                 // extra linear drag at full flare, both fins
    lateralDamping: 7,            // sideslip dies out fast: streamlined body
    yawDamping: 4.5,
    finTorque: 2.2,               // yaw torque per unit fin extension speed
    bendGain: 0.3,                // body curvature per unit yaw rate
    maxBend: 4.5,

    // Fin spring (fast, slightly under-damped flick).
    finStiffness: 900,
    finDamping: 48,

    // Behaviour.
    burstRoom: 5.5,               // free body lengths wanted ahead of a burst
    dashRoom: 2.5,                // … ahead of a small escape dash
    wallMargin: 1.3,              // body lengths: soft wall avoidance starts here
    avoidRadius: 1.4,             // body lengths between centroids: steer apart
    avoidStrength: 1.0,

    // Personal space and escapes.
    personalSpace: 0.7,           // body lengths of gap between bodies
    longDashThreat: 0.6,          // threat above this → long dash
    escapeRefractory: [0.9, 1.5], // seconds before a fish can startle again

    // Collisions.
    collisionIterations: 4,
    collisionMargin: 0.012,       // body lengths of water between bodies
    restitution: 0.1,

    // Water grid.
    waterCell: 5,                 // CSS px per square, including any gap
    waterGap: 0,                  // CSS px between squares; 0 draws them edge to edge
    waterStep: 1 / 120,
    waveSpeed2: 0.22,             // c² in cells²/step² (stable below 0.5)
    waterDamping: 0.988,          // per step: a ring fades within about a second
    splashSigma: 2.2,             // cells
    splashBase: 0.6,              // splash height for a dash…
    splashPerBeat: 0.25,          // …plus this per tail beat it will take
    slopeGain: 18,                // wave slope → shade level

    // Background dots.
    dotDensity: 1 / 7000,         // per CSS px²
    minDots: 24,
    maxDots: 160,
    blinkPeriod: [3, 9],          // seconds per blink, per dot
    blinkSharpness: 3,            // higher = shorter, rarer bright moments
    driftShare: 0.4,              // fraction of dots that drift
    maxDrift: 10,                 // CSS px from the home cell, at most
    driftSpring: 1.5,             // 1/s²: pull back toward home
    driftDamping: 1.4,            // 1/s
    driftWander: 6,               // px/s², slow wandering push
    stirReach: 0.4,               // body lengths beyond a fish that it stirs
    stirStrength: 3,              // 1/s: dragged along with a passing fish

    // Loop.
    step: 1 / 120,
    maxStepsPerFrame: 12,
    warmUpSteps: 120,
    reducedMotionSteps: 900,
  });

  /*
    Gaits: targets the wave parameters ease toward.
      amp        wave curvature amplitude (rad per body length)
      freq       tail beats per second
      wavelength in body lengths
      onset      where along the body the wave starts to grow
      headShare  fraction of the wave already present at the head
      response   how fast the current wave eases to this gait (1/s)
  */
  const GAITS = Object.freeze({
    hover:  { amp: 0,   freq: 0,   wavelength: 0.9,  onset: 0.6,  headShare: 0,   response: 8 },
    cruise: { amp: 2.7, freq: 2.0, wavelength: 0.85, onset: 0.62, headShare: 0,   response: 3 },
    burst:  { amp: 4.5, freq: 4.4, wavelength: 1.0,  onset: 0.05, headShare: 0.3, response: 30 },
    glide:  { amp: 0,   freq: 0,   wavelength: 1.0,  onset: 0.6,  headShare: 0,   response: 16 },
  });

  /*
    Fish colourways: a primary body colour with a minor marking in a
    secondary colour. Colour slots per style:
      outline  1-pixel body edge              tail   caudal fin
      base     primary body colour            fin    pectoral fins
      mark     secondary (marking) colour     eye
    marking: "bars"   thin crossbars over the back
             "spots"  a few small round spots
             "dots"   single-pixel speckles
             "stripe" a thin line down the spine
  */
  const FISH_STYLES = Object.freeze([
    // Dark teal with silver crossbars.
    { marking: "bars",   outline: "#142c2a", base: "#26524e", mark: "#a3adae", tail: "#2f605b", fin: "#3a6c67", eye: "#081211" },
    // Dark grey with orange spots.
    { marking: "spots",  outline: "#232528", base: "#45494e", mark: "#a86f45", tail: "#51565b", fin: "#5c6166", eye: "#0c0d0e" },
    // Dark blue with light blue dots.
    { marking: "dots",   outline: "#132036", base: "#283f60", mark: "#8199b8", tail: "#304a6e", fin: "#3b5579", eye: "#070c15" },
    // Dark purple with a yellow stripe.
    { marking: "stripe", outline: "#211830", base: "#3f3052", mark: "#b8a05a", tail: "#4a3a5f", fin: "#55456b", eye: "#0c0812" },
    // Dark red with white spots.
    { marking: "spots",  outline: "#341716", base: "#682c29", mark: "#cdc6ba", tail: "#773735", fin: "#83423f", eye: "#140808" },
  ]);
  const COLOR_SLOTS = ["outline", "base", "mark", "tail", "fin", "eye"];
  const SLOT = Object.freeze(Object.fromEntries(COLOR_SLOTS.map((name, i) => [name, i + 1])));

  /* ---------- small helpers ---------- */

  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  const random = (lo, hi) => lo + Math.random() * (hi - lo);
  const randomIn = ([lo, hi]) => random(lo, hi);
  const randomInt = (lo, hi) => Math.floor(random(lo, hi + 1));
  const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  function smoothstep(edge0, edge1, x) {
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  // Frame-rate independent exponential approach.
  function approach(current, target, rate, dt) {
    return current + (target - current) * (1 - Math.exp(-rate * dt));
  }

  /* ---------- body profile (shared by all fish) ---------- */

  const NODES = config.nodeCount;
  const SEGMENTS = NODES - 1;
  const DS = 1 / SEGMENTS;
  const PEDUNCLE = Math.round(config.bodyEnd * SEGMENTS);
  const BODY_END = PEDUNCLE * DS;
  const TIP = NODES - 1;

  // Tail coordinates: t = 0 at the peduncle, 1 at the last node.
  const TAIL_NOTCH_T = (config.tailNotch - BODY_END) / (1 - BODY_END);
  const TAIL_END_T = (1 + config.lobeSweep - BODY_END) / (1 - BODY_END);
  const LAST_SEGMENT_REACH = 1 + config.lobeSweep / DS;  // lets the lobes overhang

  // Half-width per node: round snout, widest near a third, taper to the peduncle.
  const HALF_WIDTH = (() => {
    const raw = new Float64Array(NODES);
    let peak = 0;
    for (let i = 0; i <= PEDUNCLE; i++) {
      const u = i / PEDUNCLE;
      raw[i] = Math.sqrt(u) * (1 - u) + 0.12 * u * u * u;
      peak = Math.max(peak, raw[i]);
    }
    for (let i = 0; i <= PEDUNCLE; i++) raw[i] *= config.maxHalfWidth / peak;
    return raw;
  })();
  const PEDUNCLE_HALF = HALF_WIDTH[PEDUNCLE];

  function halfWidthAt(s) {
    const f = clamp(s, 0, BODY_END) / DS;
    const i = Math.min(Math.floor(f), PEDUNCLE - 1);
    return HALF_WIDTH[i] + (HALF_WIDTH[i + 1] - HALF_WIDTH[i]) * (f - i);
  }

  // Segment mass ~ cross-section ~ width². The tail fin weighs almost nothing.
  const MASS = (() => {
    const mass = new Float64Array(SEGMENTS);
    const finMass = 0.02 * config.maxHalfWidth ** 2;
    for (let i = 0; i < SEGMENTS; i++) {
      mass[i] = i < PEDUNCLE
        ? ((HALF_WIDTH[i] + HALF_WIDTH[i + 1]) / 2) ** 2
        : finMass;
    }
    return mass;
  })();
  const TOTAL_MASS = MASS.reduce((sum, m) => sum + m, 0);

  // The tail fin is stiffer than the body, so it bends less.
  const STIFFNESS = Float64Array.from({ length: NODES }, (_, i) =>
    1 - 0.5 * smoothstep(0.78, 0.92, i * DS));

  // Collider circles along the spine: body width up to the peduncle, then a
  // share of the tail fin's spread. Radii are fractions of body length.
  const COLLIDERS = (() => {
    const list = [];
    for (let i = 1; i < NODES; i += 2) {
      const t = Math.max(0, (i - PEDUNCLE) / (TIP - PEDUNCLE));
      const radius = i <= PEDUNCLE
        ? Math.max(HALF_WIDTH[i], 0.03)
        : 0.6 * (PEDUNCLE_HALF + (config.lobeHalfSpread - PEDUNCLE_HALF) * t);
      list.push({ node: i, radius });
    }
    return Object.freeze(list);
  })();

  /* ---------- pixel-art raster scratch (shared, grown on demand) ---------- */

  const CELL_EMPTY = 0;
  const CELL_BODY = 1;
  const CELL_TAIL = 2;
  const CELL_FIN = 3;

  const raster = {
    size: 0,
    kind: new Uint8Array(0),     // CELL_* per cell
    along: new Float32Array(0),  // s, distance along the body
    across: new Float32Array(0), // d / half-width, −1 … 1 on the body
    color: new Uint8Array(0),    // SLOT index, 0 = nothing to paint
    ensure(count) {
      if (count <= this.size) return;
      this.size = Math.ceil(count * 1.5);
      this.kind = new Uint8Array(this.size);
      this.along = new Float32Array(this.size);
      this.across = new Float32Array(this.size);
      this.color = new Uint8Array(this.size);
    },
  };

  // Per-segment geometry for the current frame (offsets from the centroid).
  const segment = {
    dx: new Float64Array(SEGMENTS),
    dy: new Float64Array(SEGMENTS),
    length: new Float64Array(SEGMENTS),
    inverseLength2: new Float64Array(SEGMENTS),
  };

  /* ---------- fish ---------- */

  // Marking layout in body coordinates (along: 0 snout … 0.8 peduncle;
  // across: −1 … 1 of the local half-width), chosen once per fish.
  function createMarkings(kind) {
    switch (kind) {
      case "bars": {
        const count = randomInt(3, 4);
        const items = Array.from({ length: count }, (_, i) =>
          0.22 + (0.46 * (i + 0.5)) / count + random(-0.015, 0.015));
        return { kind, items, width: 0.012 };
      }
      case "stripe":
        return { kind, from: random(0.1, 0.16), to: random(0.66, 0.74) };
      case "dots":
        return { kind, items: scatter(randomInt(6, 9), 0, 0.15, 0.72, 0.7) };
      case "spots":
        return { kind, items: scatter(randomInt(2, 3), random(0.035, 0.05), 0.2, 0.68, 0.45) };
      default:
        throw new Error(`Unknown fish marking: ${kind}`);
    }
  }

  // Discs spread along the body, kept apart so they read as separate marks.
  function scatter(count, radius, from, to, maxAcross) {
    const items = [];
    for (let attempt = 0; items.length < count && attempt < 200; attempt++) {
      const spot = {
        along: random(from, to),
        across: random(-maxAcross, maxAcross),
        radius: radius * random(0.8, 1.2),
      };
      if (items.every((other) => Math.abs(other.along - spot.along) > 0.07)) items.push(spot);
    }
    return items;
  }

  class PectoralFin {
    constructor() {
      this.angle = 0.3;   // 0 = tucked, 1 = fully flared
      this.velocity = 0;
      this.flick = 0;     // seconds left in a forced flare
    }

    step(target, dt) {
      if (this.flick > 0) {
        this.flick -= dt;
        target = 1;
      }
      const accel = config.finStiffness * (target - this.angle) - config.finDamping * this.velocity;
      this.velocity += accel * dt;
      this.angle = clamp(this.angle + this.velocity * dt, 0, 1.1);
    }

    // Only the power stroke (extension) pushes water.
    get stroke() { return Math.max(0, this.velocity); }
  }

  class Fish {
    constructor(tank, x, y, heading, size, style) {
      this.tank = tank;
      this.size = size;                 // relative length multiplier
      this.style = style;
      this.palette = [null, ...COLOR_SLOTS.map((slot) => style[slot])];
      this.markings = createMarkings(style.marking);
      this.cellCss = 1;                 // fish pixel size, set while drawing
      this.x = x;                       // centroid, px
      this.y = y;
      this.heading = heading;
      this.yawRate = 0;
      this.vx = 0;                      // velocity, L/s
      this.vy = 0;

      this.wave = { ...GAITS.hover };   // current wave, eased toward gait
      this.gait = GAITS.hover;
      this.phase = Math.random();

      this.pulse = null;                // { time, duration, amp }
      this.left = new PectoralFin();
      this.right = new PectoralFin();
      this.finTarget = 0.35;
      this.sculling = Math.random() * TAU;

      this.desiredHeading = heading;
      this.turnGain = 0;                // heading spring stiffness for steering
      this.turnFlare = 0;               // cruise: inner pectoral opens on turns
      this.target = null;

      this.escapeCooldown = 0;
      this.threat = 0;                  // filled in by the tank's sensing pass
      this.threatSource = null;

      // Spine, recomputed each step. Offsets are px from the centroid.
      this.angles = new Float64Array(SEGMENTS);
      this.nodeX = new Float64Array(NODES);
      this.nodeY = new Float64Array(NODES);
      this.tailLateral = 0;
      this.tailLateralSpeed = 0;
      this.solveSpine(0);

      this.enterHover(random(0.5, 4));
    }

    get length() { return this.tank.fishLength * this.size; }
    get mass() { return this.size * this.size; }
    get speed() { return this.vx * Math.cos(this.heading) + this.vy * Math.sin(this.heading); }
    get isDashing() { return this.mode === "coil" || this.mode === "burst"; }

    /* ----- behaviour ----- */

    setMode(mode, duration) {
      this.mode = mode;
      this.modeTime = 0;
      this.modeDuration = duration;
    }

    enterHover(duration = random(2.5, 6)) {
      this.setMode("hover", duration);
      this.gait = GAITS.hover;
      this.turnGain = 0;                // turning is left to the fins
      this.nextEvent = random(0.4, 1.4);
    }

    // Spontaneous fast-start toward open water; cruise if there is no room.
    planDash() {
      const heading = this.tank.pickHeading(this, this.heading, 2.2, config.burstRoom, 0.15, false);
      if (heading === null) this.enterCruise();
      else this.enterCoil(heading, random(2, 3.5), false);
    }

    // Stage one of a fast-start: bend into a C while yawing to the new heading.
    // The dash splashes the water where it starts.
    enterCoil(heading, beats, startle) {
      const turn = Math.abs(wrapAngle(heading - this.heading));
      const duration = startle ? 0.06 + 0.1 * turn / Math.PI : 0.09 + 0.14 * turn / Math.PI;
      this.setMode("coil", duration);
      this.burstHeading = heading;
      this.burstBeats = beats;
      this.desiredHeading = heading;
      this.gait = GAITS.glide;          // no wave: the turn bend forms the C
      this.turnGain = startle ? 300 : 220;
      this.finTarget = 0;
      this.tank.water.splash(this.x, this.y, config.splashBase + config.splashPerBeat * beats);
    }

    enterBurst() {
      this.setMode("burst", this.burstBeats / GAITS.burst.freq);
      this.gait = GAITS.burst;
      this.turnGain = 40;
      this.finTarget = 0;
    }

    enterGlide() {
      this.setMode("glide", 4);
      this.gait = GAITS.glide;
      this.turnGain = 3;
      this.finTarget = 0.04;
      this.glideExitSpeed = random(0.45, 0.7);
    }

    enterCruise() {
      this.setMode("cruise", random(4, 9));
      this.gait = GAITS.cruise;
      this.turnGain = 6;
      this.turnFlare = 0;
      this.target = this.tank.pickWanderTarget(this);
    }

    // Called by the tank when another fish is inside this one's personal space.
    react() {
      const source = this.threatSource;
      this.threatSource = null;
      if (!source || this.isDashing || this.escapeCooldown > 0) return;

      const away = Math.atan2(this.y - source.y, this.x - source.x);
      const long = this.threat > config.longDashThreat;
      const room = long ? config.burstRoom : config.dashRoom;
      const heading = this.tank.pickHeading(this, away, 0.9, room, 0.05, true);
      this.enterCoil(heading, long ? random(2.5, 3.5) : random(1, 1.5), true);
      this.pulse = null;
      this.escapeCooldown = randomIn(config.escapeRefractory);
    }

    updateBehaviour(dt) {
      this.modeTime += dt;
      this.escapeCooldown = Math.max(0, this.escapeCooldown - dt);
      const L = this.length;
      const wallAhead = this.tank.distanceToWall(this.x, this.y, this.heading) / L;

      switch (this.mode) {
        case "hover": {
          this.sculling += TAU * 0.7 * dt;
          this.finTarget = 0.4;
          this.nextEvent -= dt;
          if (this.nextEvent <= 0 && !this.pulse && Math.abs(this.speed) < 0.35) {
            this.hoverEvent(wallAhead);
            this.nextEvent = random(0.7, 1.9);
          }
          if (this.modeTime > this.modeDuration && !this.pulse) {
            if (Math.random() < 0.55) this.planDash();
            else this.enterCruise();
          }
          break;
        }

        case "coil": {
          const error = Math.abs(wrapAngle(this.burstHeading - this.heading));
          if (this.modeTime >= this.modeDuration || (error < 0.08 && this.modeTime > 0.05)) {
            this.enterBurst();
          }
          break;
        }

        case "burst": {
          this.desiredHeading = this.steer(Math.cos(this.burstHeading), Math.sin(this.burstHeading), 0.5);
          if (this.modeTime >= this.modeDuration || wallAhead < 1.8) this.enterGlide();
          break;
        }

        case "glide": {
          this.desiredHeading = this.steer(Math.cos(this.heading), Math.sin(this.heading), 1);
          this.finTarget = wallAhead < 1.5 ? 0.9 : 0.04;   // flare to brake near glass
          if (this.speed < this.glideExitSpeed || this.modeTime > this.modeDuration) {
            if (Math.random() < 0.5) this.enterCruise();
            else this.enterHover();
          }
          break;
        }

        case "cruise": {
          const dx = this.target.x - this.x;
          const dy = this.target.y - this.y;
          const distance = Math.hypot(dx, dy);
          if (distance < L * 1.2) this.target = this.tank.pickWanderTarget(this);
          this.desiredHeading = this.steer(dx / (distance || 1), dy / (distance || 1), 1);
          // The fin on the inside of a turn opens a little.
          const turn = clamp(wrapAngle(this.desiredHeading - this.heading), -1, 1);
          this.finTarget = 0.14;
          this.turnFlare = 0.35 * turn;
          if (this.modeTime > this.modeDuration) {
            if (Math.random() < 0.55) this.enterHover();
            else this.planDash();
          }
          break;
        }
      }
    }

    // A hovering fish either snaps its tail once or flicks one pectoral fin.
    hoverEvent(wallAhead) {
      const away = this.steer(Math.cos(this.heading), Math.sin(this.heading), 1);
      const turnAway = wrapAngle(away - this.heading);

      if (wallAhead < 2.2 && Math.abs(turnAway) > 0.05) {
        this.flickToward(turnAway);
      } else if (Math.random() < 0.5 && wallAhead > 1.2) {
        const side = Math.random() < 0.5 ? -1 : 1;
        this.pulse = { time: 0, duration: random(0.13, 0.18), amp: random(1.9, 2.5) * side };
      } else {
        this.flickToward(random(-1, 1));
      }
    }

    // Left fin stroke turns the fish right (clockwise on screen), like an oar.
    flickToward(turn) {
      (turn > 0 ? this.left : this.right).flick = random(0.08, 0.13);
    }

    // Blend a goal direction with wall and neighbour avoidance; returns a heading.
    steer(goalX, goalY, goalWeight) {
      const L = this.length;
      const lookAhead = L * (0.6 + 0.5 * Math.max(0, this.speed));
      const px = this.x + Math.cos(this.heading) * lookAhead;
      const py = this.y + Math.sin(this.heading) * lookAhead;
      const margin = L * config.wallMargin;
      const { width, height } = this.tank;

      let sx = goalX * goalWeight;
      let sy = goalY * goalWeight;

      if (px < margin) sx += ((margin - px) / margin) ** 2 * 3;
      if (px > width - margin) sx -= ((px - (width - margin)) / margin) ** 2 * 3;
      if (py < margin) sy += ((margin - py) / margin) ** 2 * 3;
      if (py > height - margin) sy -= ((py - (height - margin)) / margin) ** 2 * 3;

      const radius = L * config.avoidRadius;
      for (const other of this.tank.fish) {
        if (other === this) continue;
        const dx = this.x - other.x;
        const dy = this.y - other.y;
        const d = Math.hypot(dx, dy);
        if (d > 0 && d < radius) {
          const push = (1 - d / radius) * config.avoidStrength;
          sx += (dx / d) * push;
          sy += (dy / d) * push;
        }
      }
      return Math.atan2(sy, sx);
    }

    /* ----- physics ----- */

    step(dt) {
      this.updateBehaviour(dt);

      // Ease the wave toward the current gait.
      const gait = this.gait;
      const wave = this.wave;
      for (const key of ["amp", "freq", "wavelength", "onset", "headShare"]) {
        wave[key] = approach(wave[key], gait[key], gait.response, dt);
      }
      this.phase = (this.phase + wave.freq * dt) % 1;

      if (this.pulse) {
        this.pulse.time += dt;
        if (this.pulse.time >= this.pulse.duration) this.pulse = null;
      }

      // Pectoral fins: gentle alternate sculling while hovering, plus turn flare.
      const scull = this.mode === "hover" ? 0.06 : 0;
      const flare = this.mode === "cruise" ? this.turnFlare : 0;
      this.left.step(this.finTarget + scull * Math.sin(this.sculling) + Math.max(0, -flare), dt);
      this.right.step(this.finTarget + scull * Math.sin(this.sculling + Math.PI) + Math.max(0, flare), dt);

      // Yaw: steering spring + fin strokes, against water damping.
      const damping = Math.max(config.yawDamping, 2 * Math.sqrt(this.turnGain));
      const steering = this.turnGain * wrapAngle(this.desiredHeading - this.heading);
      const fins = config.finTorque * (this.left.stroke - this.right.stroke);
      this.yawRate += (steering + fins - damping * this.yawRate) * dt;
      this.heading = wrapAngle(this.heading + this.yawRate * dt);

      this.solveSpine(dt);

      // Surge and sway, in body lengths per second.
      const cos = Math.cos(this.heading);
      const sin = Math.sin(this.heading);
      let surge = this.vx * cos + this.vy * sin;
      let sway = -this.vx * sin + this.vy * cos;

      const finOpen = (this.left.angle + this.right.angle) / 2;
      const thrust = config.thrustGain * Math.min(this.tailLateralSpeed ** 2, config.maxTailSpeed ** 2);
      const drag = (config.dragLinear + config.finDrag * finOpen) * surge
                 + config.dragQuadratic * surge * Math.abs(surge);
      surge += (thrust - drag) * dt;
      sway *= Math.exp(-config.lateralDamping * dt);

      this.vx = surge * cos - sway * sin;
      this.vy = surge * sin + sway * cos;

      const L = this.length;
      this.x += this.vx * L * dt;
      this.y += this.vy * L * dt;
    }

    curvature(s, i) {
      const w = this.wave;
      const envelope = w.headShare + (1 - w.headShare) * smoothstep(w.onset, 0.82, s);
      let k = w.amp * envelope * Math.sin(TAU * (s / w.wavelength - this.phase));

      // Turn bend: turning right (yaw > 0) curves the body concave-right.
      k -= clamp(config.bendGain * this.yawRate, -config.maxBend, config.maxBend) * Math.sin(Math.PI * s) * 1.6;

      if (this.pulse) {
        const p = this.pulse;
        k += p.amp * Math.sin(Math.PI * p.time / p.duration) * smoothstep(0.5, 0.82, s);
      }
      return k * STIFFNESS[i];
    }

    // Integrate curvature into segment angles and node offsets around the centroid.
    solveSpine(dt) {
      const angles = this.angles;
      let angle = 0;
      let weighted = 0;
      for (let i = 0; i < SEGMENTS; i++) {
        if (i > 0) angle += this.curvature(i * DS, i) * DS;
        angles[i] = angle;
        weighted += MASS[i] * angle;
      }

      // Recoil: the mass-weighted mean angle is the heading.
      const offset = this.heading - weighted / TOTAL_MASS;
      for (let i = 0; i < SEGMENTS; i++) angles[i] += offset;

      // Each segment's angle is its forward direction, so nodes run backwards.
      const step = this.length * DS;
      const nx = this.nodeX;
      const ny = this.nodeY;
      nx[0] = 0;
      ny[0] = 0;
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < SEGMENTS; i++) {
        nx[i + 1] = nx[i] - Math.cos(angles[i]) * step;
        ny[i + 1] = ny[i] - Math.sin(angles[i]) * step;
        cx += MASS[i] * (nx[i] + nx[i + 1]) / 2;
        cy += MASS[i] * (ny[i] + ny[i + 1]) / 2;
      }
      cx /= TOTAL_MASS;
      cy /= TOTAL_MASS;
      for (let i = 0; i < NODES; i++) {
        nx[i] -= cx;
        ny[i] -= cy;
      }

      // Tail-tip sideways position in the body frame, in body lengths.
      const lateral = (-nx[TIP] * Math.sin(this.heading) + ny[TIP] * Math.cos(this.heading)) / this.length;
      this.tailLateralSpeed = dt > 0 ? (lateral - this.tailLateral) / dt : 0;
      this.tailLateral = lateral;
    }

    /* ----- pixel art ----- */

    // Unit normal (towards the fish's left) at node i.
    normalAt(i) {
      const a = this.angles;
      const angle = i === 0 ? a[0] : i === SEGMENTS ? a[SEGMENTS - 1] : (a[i - 1] + a[i]) / 2;
      return [Math.sin(angle), -Math.cos(angle)];
    }

    // The two pectoral fins as { x, y, dx, dy } roots and directions (px from the centroid).
    pectoralFins() {
      const p = config.pectoralNode;
      const [ux, uy] = this.normalAt(p);
      const edge = HALF_WIDTH[p] * this.length;
      const back = this.angles[p] + Math.PI;
      const span = config.pectoralFlared - config.pectoralTucked;
      return [[1, this.left], [-1, this.right]].map(([side, fin]) => {
        const direction = back + (config.pectoralTucked + span * Math.min(fin.angle, 1)) * side;
        return {
          x: this.nodeX[p] + ux * edge * side,
          y: this.nodeY[p] + uy * edge * side,
          dx: Math.cos(direction),
          dy: Math.sin(direction),
        };
      });
    }

    /*
      Classify the point (qx, qy), px from the centroid, into raster cell i:
      body, tail or pectoral fin, plus its body coordinates.
    */
    classify(qx, qy, i, fins, bias) {
      const L = this.length;
      const nx = this.nodeX;
      const ny = this.nodeY;

      // Nearest spine segment → distance along the body and signed offset.
      let best = Infinity;
      let along = 0;
      let across = 0;
      let pastTip = false;
      for (let k = 0; k < SEGMENTS; k++) {
        const ax = nx[k];
        const ay = ny[k];
        const sx = segment.dx[k];
        const sy = segment.dy[k];
        const reach = k === SEGMENTS - 1 ? LAST_SEGMENT_REACH : 1;
        const t = clamp(((qx - ax) * sx + (qy - ay) * sy) * segment.inverseLength2[k], 0, reach);
        const ex = ax + sx * t - qx;
        const ey = ay + sy * t - qy;
        const distance2 = ex * ex + ey * ey;
        if (distance2 < best) {
          best = distance2;
          along = (k + t) * DS;
          across = ((qx - ax) * -sy + (qy - ay) * sx) / segment.length[k];
          pastTip = t === reach && k === SEGMENTS - 1;
        }
      }

      let kind = CELL_EMPTY;
      if (along <= BODY_END) {
        // True distance to the spine, so points ahead of the snout don't count
        // as inside just because they sit on the spine's extension.
        const half = halfWidthAt(along) * L;
        if (Math.sqrt(best) <= half + bias) {
          kind = CELL_BODY;
          raster.across[i] = across / Math.max(half, 1e-6);
        }
      } else if (!pastTip) {
        // Forked tail: outer edge grows to the lobe tips, a V notch opens inside.
        // Measured across the spine, since the lobes spread sideways.
        const offset = Math.abs(across);
        const t = (along - BODY_END) / (1 - BODY_END);
        const outer = (PEDUNCLE_HALF + (config.lobeHalfSpread - PEDUNCLE_HALF) * Math.min(t, 1)) * L;
        const inner = t <= TAIL_NOTCH_T
          ? -Infinity
          : config.lobeHalfSpread * L * (t - TAIL_NOTCH_T) / (TAIL_END_T - TAIL_NOTCH_T);
        if (offset <= outer + bias && offset >= inner && t < TAIL_END_T) kind = CELL_TAIL;
      }

      if (kind === CELL_EMPTY) {
        // Pectoral fins: a teardrop along each fin's axis.
        const length = config.pectoralLength * L;
        const width = config.pectoralWidth * L;
        for (const fin of fins) {
          const rx = qx - fin.x;
          const ry = qy - fin.y;
          const u = (rx * fin.dx + ry * fin.dy) / length;
          if (u < 0 || u > 1) continue;
          const perpendicular = Math.abs(rx * fin.dy - ry * fin.dx);
          if (perpendicular <= width * Math.min(1, u * 3.5) * (1 - u) * 1.35 + bias * 0.5) {
            kind = CELL_FIN;
            break;
          }
        }
      }

      raster.kind[i] = kind;
      raster.along[i] = along;
      return kind;
    }

    // Body colour for a body cell: primary, or secondary on the marking.
    bodyColor(along, across) {
      const L = this.length;
      const half = halfWidthAt(along) * L;
      const sideways = across * half;           // px from the spine
      const marks = this.markings;
      switch (marks.kind) {
        case "bars":
          for (const bar of marks.items) {
            if (Math.abs(along - bar) * L <= Math.max(marks.width * L, this.cellCss * 0.55)) return SLOT.mark;
          }
          return SLOT.base;
        case "stripe":
          return along > marks.from && along < marks.to && Math.abs(sideways) <= this.cellCss * 0.6
            ? SLOT.mark : SLOT.base;
        default: {
          // "spots" and "dots": discs placed in body coordinates. A radius of at
          // least 0.71 pixel always covers one pixel centre, so none vanish.
          for (const spot of marks.items) {
            const dx = (along - spot.along) * L;
            const dy = sideways - spot.across * halfWidthAt(spot.along) * L;
            const radius = Math.max(spot.radius * L, this.cellCss * 0.71);
            if (dx * dx + dy * dy <= radius * radius) return SLOT.mark;
          }
          return SLOT.base;
        }
      }
    }

    /*
      Rasterise onto the shared pixel grid (cell = `pixel` device px) and paint.
      Cells are classified, edge cells outlined, then filled one colour at a time.
    */
    draw(ctx, pixel, dpr) {
      const L = this.length;
      const nx = this.nodeX;
      const ny = this.nodeY;
      const cellCss = pixel / dpr;
      this.cellCss = cellCss;

      for (let k = 0; k < SEGMENTS; k++) {
        const dx = nx[k + 1] - nx[k];
        const dy = ny[k + 1] - ny[k];
        const length2 = dx * dx + dy * dy || 1e-9;
        segment.dx[k] = dx;
        segment.dy[k] = dy;
        segment.length[k] = Math.sqrt(length2);
        segment.inverseLength2[k] = 1 / length2;
      }

      // Bounding box in grid cells, padded for fins and lobes.
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let k = 0; k < NODES; k++) {
        minX = Math.min(minX, nx[k]);
        maxX = Math.max(maxX, nx[k]);
        minY = Math.min(minY, ny[k]);
        maxY = Math.max(maxY, ny[k]);
      }
      const pad = (config.pectoralLength + config.maxHalfWidth + config.lobeSweep) * L + cellCss;
      const gx0 = Math.floor((this.x + minX - pad) / cellCss);
      const gy0 = Math.floor((this.y + minY - pad) / cellCss);
      const w = Math.floor((this.x + maxX + pad) / cellCss) - gx0 + 1;
      const h = Math.floor((this.y + maxY + pad) / cellCss) - gy0 + 1;
      raster.ensure(w * h);

      // Classify each cell centre.
      const fins = this.pectoralFins();
      const bias = cellCss * 0.3;   // round partially covered edge cells in
      for (let cy = 0, i = 0; cy < h; cy++) {
        const qy = (gy0 + cy + 0.5) * cellCss - this.y;
        for (let cx = 0; cx < w; cx++, i++) {
          this.classify((gx0 + cx + 0.5) * cellCss - this.x, qy, i, fins, bias);
        }
      }

      // Colour: a 1-cell outline around the body, then its marking.
      const { kind, color } = raster;
      for (let cy = 0, i = 0; cy < h; cy++) {
        for (let cx = 0; cx < w; cx++, i++) {
          const k = kind[i];
          if (k === CELL_EMPTY) {
            color[i] = 0;
          } else if (k === CELL_FIN) {
            color[i] = SLOT.fin;
          } else if (k === CELL_TAIL) {
            color[i] = SLOT.tail;       // fins are too thin to carry an outline
          } else {
            const edge = cx === 0 || cy === 0 || cx === w - 1 || cy === h - 1
              || isOpen(kind[i - 1]) || isOpen(kind[i + 1]) || isOpen(kind[i - w]) || isOpen(kind[i + w]);
            color[i] = edge ? SLOT.outline : this.bodyColor(raster.along[i], raster.across[i]);
          }
        }
      }

      // Eyes: one dark pixel on each side of the head.
      const e = config.eyeNode;
      const [ux, uy] = this.normalAt(e);
      const eyeReach = HALF_WIDTH[e] * L * config.eyeOffset;
      for (const side of [1, -1]) {
        const cx = Math.floor((this.x + nx[e] + ux * eyeReach * side) / cellCss) - gx0;
        const cy = Math.floor((this.y + ny[e] + uy * eyeReach * side) / cellCss) - gy0;
        const i = cy * w + cx;
        if (cx >= 0 && cy >= 0 && cx < w && cy < h && kind[i] === CELL_BODY) color[i] = SLOT.eye;
      }

      // Paint, one fill colour at a time.
      for (let slot = 1; slot < this.palette.length; slot++) {
        ctx.fillStyle = this.palette[slot];
        for (let cy = 0, i = 0; cy < h; cy++) {
          for (let cx = 0; cx < w; cx++, i++) {
            if (color[i] === slot) ctx.fillRect((gx0 + cx) * pixel, (gy0 + cy) * pixel, pixel, pixel);
          }
        }
      }
    }
  }

  // Outside the body for outlining: empty water or a fin.
  const isOpen = (kind) => kind !== CELL_BODY;

  /* ---------- water ---------- */

  class Water {
    constructor(palette) {
      this.palette = palette;
      this.canvas = document.createElement("canvas");
      this.ctx = this.canvas.getContext("2d");
      this.backlog = 0;
    }

    resize(width, height, dpr) {
      // Whole device pixels per cell and per gap keep the grid even.
      this.cellDevice = Math.max(3, Math.round(config.waterCell * dpr));
      this.gapDevice = Math.max(0, Math.round(config.waterGap * dpr));
      this.cellCss = this.cellDevice / dpr;

      const cols = Math.max(3, Math.ceil(width / this.cellCss));
      const rows = Math.max(3, Math.ceil(height / this.cellCss));
      const count = cols * rows;
      this.cols = cols;
      this.rows = rows;
      this.height = new Float32Array(count);     // surface height
      this.velocity = new Float32Array(count);   // vertical surface speed
      this.shown = new Uint8Array(count).fill(255);  // last shade level drawn per cell

      this.canvas.width = cols * this.cellDevice;
      this.canvas.height = rows * this.cellDevice;
      this.image = this.ctx.createImageData(this.canvas.width, this.canvas.height);
      this.pixels = new Uint32Array(this.image.data.buffer);
      this.pixels.fill(0);   // transparent: still water shows the page behind
      this.ctx.putImageData(this.image, 0, 0);
    }

    // A dash starting here: a Gaussian bump that spreads into a ring.
    splash(x, y, amplitude) {
      const cx = Math.floor(x / this.cellCss);
      const cy = Math.floor(y / this.cellCss);
      const sigma = config.splashSigma;
      const radius = Math.ceil(sigma * 3);
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const gx = cx + dx;
          const gy = cy + dy;
          if (gx < 1 || gy < 1 || gx > this.cols - 2 || gy > this.rows - 2) continue;
          this.height[gy * this.cols + gx] += amplitude * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
        }
      }
    }

    step(dt) {
      this.backlog += dt;
      while (this.backlog >= config.waterStep) {
        this.propagate();
        this.backlog -= config.waterStep;
      }
    }

    // One step of the 2D wave equation (symplectic Euler). The outer ring of
    // cells is held at zero, so waves reflect off the glass.
    propagate() {
      const { cols, rows, height: h, velocity: v } = this;
      const c2 = config.waveSpeed2;
      const damping = config.waterDamping;
      for (let y = 1; y < rows - 1; y++) {
        let i = y * cols + 1;
        for (let x = 1; x < cols - 1; x++, i++) {
          const laplacian = h[i - 1] + h[i + 1] + h[i - cols] + h[i + cols] - 4 * h[i];
          v[i] = (v[i] + c2 * laplacian) * damping;
        }
      }
      for (let y = 1; y < rows - 1; y++) {
        let i = y * cols + 1;
        for (let x = 1; x < cols - 1; x++, i++) h[i] += v[i];
      }
    }

    // Shade each cell by its slope; repaint only changed cells and upload
    // only the rectangle that changed.
    render() {
      const { cols, rows, height: h, shown } = this;
      let minX = cols;
      let minY = rows;
      let maxX = -1;
      let maxY = -1;
      for (let y = 1; y < rows - 1; y++) {
        let i = y * cols + 1;
        for (let x = 1; x < cols - 1; x++, i++) {
          // Light from the upper left: the slope facing it brightens.
          const slope = (h[i - 1] - h[i + 1]) + (h[i - cols] - h[i + cols]);
          const level = clamp(Math.round(slope * config.slopeGain), -2, 3) + 2;
          if (level === shown[i]) continue;
          shown[i] = level;
          this.paintCell(x, y, this.palette.water[level]);
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      if (maxX < 0) return;
      const c = this.cellDevice;
      this.ctx.putImageData(this.image, 0, 0, minX * c, minY * c, (maxX - minX + 1) * c, (maxY - minY + 1) * c);
    }

    // Fill a cell's square, leaving any gap along its right and bottom edges.
    paintCell(cx, cy, color) {
      const size = this.cellDevice;
      const lit = size - this.gapDevice;
      const stride = this.canvas.width;
      let row = cy * size * stride + cx * size;
      for (let py = 0; py < lit; py++, row += stride) {
        this.pixels.fill(color, row, row + lit);
      }
    }

    draw(ctx) {
      ctx.drawImage(this.canvas, 0, 0);
    }
  }

  /* ---------- background dots ---------- */

  /*
    Dots on the water grid. Each rests dark green and blinks lighter on its own
    period; brightness is quantised to the palette's steps. Some dots drift:
    a damped spring ties them to their home cell, a slow wander and passing
    fish push them, and they never stray more than maxDrift.
  */
  class Dots {
    constructor(colors) {
      this.colors = colors;   // fills, darkest (resting) first
      this.items = [];
      this.time = 0;
    }

    // Scatter dots over distinct grid cells, keeping the outer frame empty.
    reset(width, height, cellCss) {
      const cols = Math.floor(width / cellCss);
      const rows = Math.floor(height / cellCss);
      const count = Math.min(
        clamp(Math.round(width * height * config.dotDensity), config.minDots, config.maxDots),
        Math.max(0, (cols - 2) * (rows - 2)));
      const used = new Set();
      this.items = [];
      while (this.items.length < count) {
        const cx = randomInt(1, cols - 2);
        const cy = randomInt(1, rows - 2);
        if (used.has(cy * cols + cx)) continue;
        used.add(cy * cols + cx);
        this.items.push({
          homeX: (cx + 0.5) * cellCss,   // CSS px, the home cell's centre
          homeY: (cy + 0.5) * cellCss,
          offsetX: 0,                    // drift from home, CSS px
          offsetY: 0,
          vx: 0,
          vy: 0,
          drifts: Math.random() < config.driftShare,
          wanderRate: random(0.15, 0.4),
          wanderPhase: random(0, TAU),
          period: randomIn(config.blinkPeriod),
          phase: Math.random(),
        });
      }
    }

    rescale(sx, sy) {
      for (const dot of this.items) {
        dot.homeX *= sx;
        dot.homeY *= sy;
      }
    }

    step(dt, fish) {
      this.time += dt;
      const t = this.time;
      for (const dot of this.items) {
        if (!dot.drifts) continue;
        const angle = dot.wanderPhase + t * dot.wanderRate;
        let ax = Math.cos(angle) * config.driftWander
               - config.driftSpring * dot.offsetX - config.driftDamping * dot.vx;
        let ay = Math.sin(angle * 1.3) * config.driftWander
               - config.driftSpring * dot.offsetY - config.driftDamping * dot.vy;

        // A passing fish drags nearby water, and the dot with it.
        const x = dot.homeX + dot.offsetX;
        const y = dot.homeY + dot.offsetY;
        for (const f of fish) {
          const L = f.length;
          const reach = config.stirReach * L;
          const dx = x - f.x;
          const dy = y - f.y;
          if (dx * dx + dy * dy > (0.8 * L + reach) ** 2) continue;
          let nearest = Infinity;
          for (const c of COLLIDERS) {
            const d = Math.hypot(x - f.x - f.nodeX[c.node], y - f.y - f.nodeY[c.node]) - c.radius * L;
            nearest = Math.min(nearest, d);
          }
          if (nearest >= reach) continue;
          const falloff = 1 - Math.max(0, nearest) / reach;
          ax += (f.vx * L - dot.vx) * config.stirStrength * falloff;
          ay += (f.vy * L - dot.vy) * config.stirStrength * falloff;
        }

        dot.vx += ax * dt;
        dot.vy += ay * dt;
        dot.offsetX += dot.vx * dt;
        dot.offsetY += dot.vy * dt;

        // Never stray far: clamp the offset and drop outward speed at the limit.
        const drift = Math.hypot(dot.offsetX, dot.offsetY);
        if (drift > config.maxDrift) {
          const nx = dot.offsetX / drift;
          const ny = dot.offsetY / drift;
          dot.offsetX = nx * config.maxDrift;
          dot.offsetY = ny * config.maxDrift;
          const outward = dot.vx * nx + dot.vy * ny;
          if (outward > 0) {
            dot.vx -= outward * nx;
            dot.vy -= outward * ny;
          }
        }
      }
    }

    // Snap to the water grid and fill a lit square, one colour at a time.
    draw(ctx, water, dpr) {
      const size = water.cellDevice;
      const lit = size - water.gapDevice;
      const steps = this.colors.length;
      for (let level = 0; level < steps; level++) {
        ctx.fillStyle = this.colors[level];
        for (const dot of this.items) {
          const blink = Math.max(0, Math.sin(TAU * (this.time / dot.period + dot.phase))) ** config.blinkSharpness;
          if (Math.min(steps - 1, Math.floor(blink * steps)) !== level) continue;
          const cx = Math.floor(((dot.homeX + dot.offsetX) * dpr) / size);
          const cy = Math.floor(((dot.homeY + dot.offsetY) * dpr) / size);
          ctx.fillRect(cx * size, cy * size, lit, lit);
        }
      }
    }
  }

  /* ---------- tank ---------- */

  class Tank {
    constructor(colors) {
      this.width = 0;
      this.height = 0;
      this.dpr = 1;
      this.fishLength = 0;
      this.fishPixel = 2;
      this.fish = [];
      this.water = new Water(colors.water);
      this.dots = new Dots(colors.dots);
    }

    resize(width, height, dpr) {
      const rescale = this.width > 0 && this.height > 0;
      if (rescale) {
        const sx = width / this.width;
        const sy = height / this.height;
        for (const f of this.fish) {
          f.x *= sx;
          f.y *= sy;
          if (f.target) {
            f.target.x *= sx;
            f.target.y *= sy;
          }
        }
        this.dots.rescale(sx, sy);
      }
      this.width = width;
      this.height = height;
      this.dpr = dpr;
      this.fishLength = clamp(Math.min(width, height) * config.lengthFraction,
        config.minLength, config.maxLength);
      this.fishPixel = Math.max(2, Math.round((this.fishLength / config.fishPixelsPerLength) * dpr));
      this.water.resize(width, height, dpr);
      if (!rescale) this.dots.reset(width, height, this.water.cellCss);
      if (this.fish.length === 0) this.populate();
      this.resolveCollisions();
    }

    populate() {
      for (let i = 0; i < config.fishCount; i++) {
        const size = 1 + random(-config.sizeVariation, config.sizeVariation);
        const spot = this.pickWanderTarget(null);
        const style = FISH_STYLES[i % FISH_STYLES.length];
        this.fish.push(new Fish(this, spot.x, spot.y, random(-Math.PI, Math.PI), size, style));
      }
    }

    // A point inside the safe area, as far as possible from the other fish.
    pickWanderTarget(fish) {
      const margin = this.fishLength * 1.5;
      const w = Math.max(this.width - 2 * margin, 1);
      const h = Math.max(this.height - 2 * margin, 1);
      let best = null;
      let bestScore = -Infinity;
      for (let k = 0; k < 8; k++) {
        const point = { x: margin + Math.random() * w, y: margin + Math.random() * h };
        let nearest = Infinity;
        for (const other of this.fish) {
          if (other !== fish) nearest = Math.min(nearest, Math.hypot(point.x - other.x, point.y - other.y));
        }
        if (nearest > bestScore) {
          bestScore = nearest;
          best = point;
        }
      }
      return best;
    }

    distanceToWall(x, y, heading) {
      const dx = Math.cos(heading);
      const dy = Math.sin(heading);
      const tx = dx > 1e-6 ? (this.width - x) / dx : dx < -1e-6 ? -x / dx : Infinity;
      const ty = dy > 1e-6 ? (this.height - y) / dy : dy < -1e-6 ? -y / dy : Infinity;
      return Math.max(0, Math.min(tx, ty));
    }

    /*
      A dash heading within ±spread of center with open water ahead and no
      fish in the way. Returns null when no candidate has enough room, unless
      forced (an escape), in which case the roomiest candidate wins.
    */
    pickHeading(fish, center, spread, roomLengths, turnCost, forced) {
      const L = fish.length;
      const need = roomLengths * L;
      let best = null;
      let bestScore = -Infinity;
      let roomiest = center;
      let mostRoom = -Infinity;
      for (let k = 0; k < 16; k++) {
        const heading = wrapAngle(center + random(-spread, spread));
        const room = this.distanceToWall(fish.x, fish.y, heading) - L;
        if (room > mostRoom) {
          mostRoom = room;
          roomiest = heading;
        }
        if (room < need) continue;

        let score = Math.min(room, need * 1.5) / need
                  - turnCost * Math.abs(wrapAngle(heading - fish.heading));
        for (const other of this.fish) {
          if (other === fish) continue;
          const dx = other.x - fish.x;
          const dy = other.y - fish.y;
          const d = Math.hypot(dx, dy);
          const off = Math.abs(wrapAngle(Math.atan2(dy, dx) - heading));
          if (d < need && off < 0.6) score -= 1.5 * (1 - d / need);
        }
        if (score > bestScore) {
          bestScore = score;
          best = heading;
        }
      }
      return best ?? (forced ? roomiest : null);
    }

    // Can these two bodies possibly be within `extra` px of each other?
    near(a, b, extra) {
      const reach = 0.7 * (a.length + b.length) + extra;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      return dx * dx + dy * dy < reach * reach;
    }

    // Smallest gap between two bodies' collider chains, in px.
    bodyGap(a, b) {
      let gap = Infinity;
      for (const ca of COLLIDERS) {
        const ax = a.x + a.nodeX[ca.node];
        const ay = a.y + a.nodeY[ca.node];
        const ra = ca.radius * a.length;
        for (const cb of COLLIDERS) {
          const d = Math.hypot(ax - b.x - b.nodeX[cb.node], ay - b.y - b.nodeY[cb.node]);
          gap = Math.min(gap, d - ra - cb.radius * b.length);
        }
      }
      return gap;
    }

    // Push overlapping bodies apart (size-weighted) and keep them inside the
    // glass. Containment runs inside each pass so a fish pinned against the
    // wall pushes its neighbour away instead of being pushed through.
    resolveCollisions() {
      const fish = this.fish;
      for (let iteration = 0; iteration < config.collisionIterations; iteration++) {
        for (let i = 0; i < fish.length; i++) {
          for (let j = i + 1; j < fish.length; j++) {
            const a = fish[i];
            const b = fish[j];
            if (this.near(a, b, 0)) this.separate(a, b);
          }
        }
        for (const f of fish) this.contain(f);
      }
    }

    // One pass of pairwise separation, then remove the closing velocity so
    // the bodies don't grind into each other.
    separate(a, b) {
      const margin = config.collisionMargin * (a.length + b.length) / 2;
      const wa = b.mass / (a.mass + b.mass);
      const wb = 1 - wa;
      let touched = false;
      let normalX = 0;
      let normalY = 0;

      for (const ca of COLLIDERS) {
        for (const cb of COLLIDERS) {
          const dx = (a.x + a.nodeX[ca.node]) - (b.x + b.nodeX[cb.node]);
          const dy = (a.y + a.nodeY[ca.node]) - (b.y + b.nodeY[cb.node]);
          const d = Math.hypot(dx, dy) || 1e-6;
          const overlap = ca.radius * a.length + cb.radius * b.length + margin - d;
          if (overlap <= 0) continue;
          const nx = dx / d;
          const ny = dy / d;
          a.x += nx * overlap * wa;
          a.y += ny * overlap * wa;
          b.x -= nx * overlap * wb;
          b.y -= ny * overlap * wb;
          normalX += nx * overlap;
          normalY += ny * overlap;
          touched = true;
        }
      }
      if (!touched) return;

      // Closing speed along the contact normal, in px/s.
      const n = Math.hypot(normalX, normalY) || 1;
      const nx = normalX / n;
      const ny = normalY / n;
      const closing = (a.vx * a.length - b.vx * b.length) * nx + (a.vy * a.length - b.vy * b.length) * ny;
      if (closing >= 0) return;
      const impulse = -closing * (1 + config.restitution);
      a.vx += (nx * impulse * wa) / a.length;
      a.vy += (ny * impulse * wa) / a.length;
      b.vx -= (nx * impulse * wb) / b.length;
      b.vy -= (ny * impulse * wb) / b.length;
    }

    // Keep every collider circle inside the glass.
    contain(fish) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const c of COLLIDERS) {
        const r = c.radius * fish.length;
        const x = fish.x + fish.nodeX[c.node];
        const y = fish.y + fish.nodeY[c.node];
        minX = Math.min(minX, x - r);
        maxX = Math.max(maxX, x + r);
        minY = Math.min(minY, y - r);
        maxY = Math.max(maxY, y + r);
      }
      if (minX < 0) { fish.x -= minX; fish.vx = Math.max(0, fish.vx); }
      else if (maxX > this.width) { fish.x -= maxX - this.width; fish.vx = Math.min(0, fish.vx); }
      if (minY < 0) { fish.y -= minY; fish.vy = Math.max(0, fish.vy); }
      else if (maxY > this.height) { fish.y -= maxY - this.height; fish.vy = Math.min(0, fish.vy); }
    }

    // Personal space: each fish notes its worst intruder, then reacts.
    sense() {
      const fish = this.fish;
      for (const f of fish) {
        f.threat = 0;
        f.threatSource = null;
      }
      const maxSpace = config.personalSpace * config.maxLength;
      for (let i = 0; i < fish.length; i++) {
        for (let j = i + 1; j < fish.length; j++) {
          const a = fish[i];
          const b = fish[j];
          if (!this.near(a, b, maxSpace)) continue;
          const gap = Math.max(0, this.bodyGap(a, b));
          this.assess(a, b, gap);
          this.assess(b, a, gap);
        }
      }
      for (const f of fish) if (f.threatSource) f.react();
    }

    /*
      Threat to `me` from `other`: how deep into my personal space it is, plus
      how fast it is closing in. Only the fish being approached reacts; if
      neither is really moving, both react once the gap is very small.
    */
    assess(me, other, gap) {
      const space = config.personalSpace * me.length;
      if (gap >= space) return;
      const dx = me.x - other.x;
      const dy = me.y - other.y;
      const d = Math.hypot(dx, dy) || 1;
      const ux = dx / d;
      const uy = dy / d;
      // Speeds toward each other, in my body lengths per second.
      const otherIn = (other.vx * ux + other.vy * uy) * other.length / me.length;
      const meIn = -(me.vx * ux + me.vy * uy);
      const threat = clamp(1 - gap / space + 0.2 * Math.max(0, otherIn), 0, 1.5);
      const approached = otherIn >= meIn - 0.05 || threat > 0.8;
      if (approached && threat > me.threat) {
        me.threat = threat;
        me.threatSource = other;
      }
    }

    step(dt) {
      for (const f of this.fish) f.step(dt);
      this.resolveCollisions();
      this.sense();
      this.water.step(dt);
      this.dots.step(dt, this.fish);
    }

    // Layers: water, dots, fish. Device pixels.
    draw(ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);   // the water is see-through now
      ctx.imageSmoothingEnabled = false;
      this.water.render();
      this.water.draw(ctx);
      this.dots.draw(ctx, this.water, this.dpr);
      for (const f of this.fish) f.draw(ctx, this.fishPixel, this.dpr);
    }
  }

  /* ---------- colours ---------- */

  function parseHex(hex, fallback) {
    const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
    const n = parseInt(match ? match[1] : fallback.slice(1), 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  }

  const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

  // Pack an [r, g, b] colour into one Uint32 pixel for ImageData.
  function packPixel([r, g, b], a = 255) {
    return LITTLE_ENDIAN
      ? ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
      : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
  }

  function mix(a, b, t) {
    return a.map((v, i) => Math.round(v + (b[i] - v) * t));
  }

  function readColors(element) {
    const style = getComputedStyle(element);
    const read = (name, fallback) => parseHex(style.getPropertyValue(name) || fallback, fallback);
    const ripple = read("--tank-ripple", "#5e8f99");
    const trough = read("--tank-trough", "#0c0e0f");
    const dotDark = read("--tank-dot-dark", "#223a2a");
    const dotLight = read("--tank-dot-light", "#4b6e52");
    const alpha = (amount) => Math.round(amount * 255);

    return {
      // Packed pixels for the water grid, shade levels −2 … +3. Still water is
      // transparent; a ripple lays the trough or crest colour over the page at
      // the strength the original mixed it into its own background, so over
      // that background the shades come out the same.
      water: {
        water: [
          packPixel(trough, alpha(1)),
          packPixel(trough, alpha(0.5)),
          0,
          packPixel(ripple, alpha(0.16)),
          packPixel(ripple, alpha(0.3)),
          packPixel(ripple, alpha(0.48)),
        ],
      },
      // Dot fills from resting dark green to the blink's peak.
      dots: [0, 0.5, 1].map((t) => `rgb(${mix(dotDark, dotLight, t).join(",")})`),
    };
  }

  /* ---------- mounting ---------- */

  function mountFishTank(canvas, { visibleMargin = "0px" } = {}) {
    const ctx = canvas.getContext("2d");
    const tank = new Tank(readColors(canvas));
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    let started = false;
    let onScreen = true;
    let frameId = 0;
    let lastTime = 0;
    let backlog = 0;

    function resize() {
      const { width, height } = canvas.getBoundingClientRect();
      if (width < 1 || height < 1) return;   // wait until the container has a size
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      tank.resize(width, height, dpr);

      if (!started) {
        started = true;
        const steps = reducedMotion.matches ? config.reducedMotionSteps : config.warmUpSteps;
        for (let s = 0; s < steps; s++) tank.step(config.step);
      }
      tank.draw(ctx);
      updateLoop();
    }

    function frame(now) {
      backlog += Math.min((now - lastTime) / 1000, 0.25);
      lastTime = now;

      let steps = 0;
      while (backlog >= config.step && steps < config.maxStepsPerFrame) {
        tank.step(config.step);
        backlog -= config.step;
        steps++;
      }
      if (steps === config.maxStepsPerFrame) backlog = 0;

      tank.draw(ctx);
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
    }, { rootMargin: visibleMargin });
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

  (window.heroAnimationRegistry = window.heroAnimationRegistry || {})["fish-tank"] = mountFishTank;
})();
