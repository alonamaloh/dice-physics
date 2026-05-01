import * as THREE from 'three';
import { V, Die, World } from './physics.js?v=0537416';
import { DiceRenderer, topFaceValue } from './render.js?v=0537416';

const canvas = document.getElementById('stage');
const resultEl = document.getElementById('result');
const rollBtn = document.getElementById('roll');
const countInput = document.getElementById('count');

const DIE_SIZE = 0.85;
// Tray bounds — extended in Z (±7) so the player-side spawn at z≈6
// has room. Ceiling at 5 lets dice pile freely on impact; KE-only
// settle test with drop-bounds-on-low-KE means we don't need a low
// ceiling to suppress stacking.
const BOUNDS = {minX: -3.6, maxX: 3.6, minZ: -7, maxZ: 7, maxY: 5};
// "Disabled" bounds: walls placed far enough away that no clamp ever
// triggers, no ceiling. Swap world.bounds to this once dice reach the
// low-KE threshold so a die leaning on an invisible wall has a chance
// to tip free.
const DISABLED_BOUNDS = {minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000};

const world = new World({
  gravity: -90,
  damping: 0.997,
  friction: 0.03,
  bounds: BOUNDS,
  iterations: 8,
});

const renderer = new DiceRenderer(canvas, {
  bounds: BOUNDS,
  dieSize: DIE_SIZE,
});

const PAUSE_MS = 350;
const TRANSITION_MS = 550;
const ROW_GAP = 0.25;

// --- Click synth -----------------------------------------------------------
// A single AudioContext, lazily created on the first user gesture (browsers,
// and especially iOS Safari, block AudioContext.start() until the user
// interacts). iOS additionally requires that a sound be played from within
// the unlocking gesture — we use a one-sample silent buffer for that.
let audioCtx = null;
function unlockAudio() {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return;
  if (!audioCtx) {
    audioCtx = new Ctor();
    // Silent buffer to satisfy iOS's "must play sound from gesture" rule.
    try {
      const buf = audioCtx.createBuffer(1, 1, 22050);
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(audioCtx.destination);
      src.start(0);
    } catch (_) {}
  }
  // Explicit resume — newly created contexts on iOS start `suspended`,
  // and start() on a buffer source does not auto-resume. Calling resume()
  // synchronously from inside the gesture handler is the only path that
  // reliably flips iOS Safari into the running state.
  if (audioCtx.state !== 'running') {
    audioCtx.resume().catch(() => {});
  }
}

// Tunable synth parameters, bound to the on-page slider panel.
const soundParams = {
  q: 3.0,
  thudHz: 400,
  clickHz: 1200,
  thudDecayMs: 35,
  clickDecayMs: 18,
  pairHz: 3500,
  pairDecayMs: 5,
  gain: 0.6,
};

// One short noise burst, exp-decay envelope, bandpass-filtered. Lower
// `freq` + longer `decayMs` give a thuddier sound; higher freq + shorter
// decay give a clickier one. Volume scales with the impact speed (m/s).
function playClick(speed, freq = 2200, decayMs = 10) {
  if (!audioCtx) return;
  const sr = audioCtx.sampleRate;
  const dur = Math.max(0.05, decayMs / 1000 * 5);
  const len = Math.floor(dur * sr);
  const buf = audioCtx.createBuffer(1, len, sr);
  const data = buf.getChannelData(0);
  const tau = decayMs / 1000;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    data[i] = (Math.random() * 2 - 1) * Math.exp(-t / tau);
  }
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  const bp = audioCtx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq;
  bp.Q.value = soundParams.q;
  const gain = audioCtx.createGain();
  // Volume curve: speed=0.5 m/s → barely audible; 5 m/s → near max.
  const v = Math.max(0, Math.min(1, (speed - 0.4) / 5.0));
  gain.gain.value = v * v * soundParams.gain;
  src.connect(bp); bp.connect(gain); gain.connect(audioCtx.destination);
  src.start();
  src.stop(audioCtx.currentTime + dur + 0.005);
}

function consumeAudioEvents() {
  if (!audioCtx) { world.events.length = 0; return; }
  for (const e of world.events) {
    if (e.speed < 0.4) continue; // skip near-silent contacts
    if (e.type === 'ground') {
      // Speed-dependent timbre: low-speed contacts thuddy, high-speed
      // clicky. t ∈ [0,1] interpolates the freq + decay sliders.
      const t = Math.max(0, Math.min(1, (e.speed - 0.5) / 4.5));
      const freq = soundParams.thudHz + t * (soundParams.clickHz - soundParams.thudHz);
      const decayMs = soundParams.thudDecayMs + t * (soundParams.clickDecayMs - soundParams.thudDecayMs);
      playClick(e.speed, freq, decayMs);
    } else if (e.type === 'pair') {
      playClick(e.speed, soundParams.pairHz, soundParams.pairDecayMs);
    }
  }
  world.events.length = 0;
}

function spawnDice(n) {
  world.dice = [];
  // Spaced spawn so the constraint solver doesn't see overlaps (which
  // would launch dice apart at 100s of m/s on the first substep).
  // Single row up to 5; for 6+ dice we split into a lower and upper
  // row stacked in Y so each row stays short enough that even the
  // edge dice's tumbling corners (L·√3/2 ≈ 0.74) fit inside the
  // ±3.6 X walls. Y separation between rows (~1.5) keeps the hard
  // centre-distance constraint inactive.
  const spawnSpacing = 1.0;
  const useTwoRows = n > 5;
  const lowerCount = useTwoRows ? Math.ceil(n / 2) : n;
  const upperCount = n - lowerCount;
  for (let i = 0; i < n; i++) {
    const inUpper = i >= lowerCount;
    const rowIdx  = inUpper ? i - lowerCount : i;
    const rowSize = inUpper ? upperCount : lowerCount;
    const rowLineHalf = (rowSize - 1) * spawnSpacing / 2;
    const startX = -rowLineHalf + rowIdx * spawnSpacing + (Math.random() - 0.5) * 0.08;
    const startZ = 6.0 + (Math.random() - 0.5) * 0.3;
    const startY = useTwoRows
      ? (inUpper ? 4.5 : 3.0) + Math.random() * 0.3
      : 3.0 + Math.random() * 1.0;
    const die = new Die(DIE_SIZE, {x: startX, y: startY, z: startZ});
    const ax = V.norm({
      x: Math.random() - 0.5,
      y: Math.random() - 0.5,
      z: Math.random() - 0.5,
    });
    die.rotateAbout(ax, Math.random() * Math.PI * 2);
    // Horizontal velocity points roughly north (toward -Z, toward the
    // top of the screen) with ±45° spread. Combined with the southern
    // spawn, the dice arc across the visible table from the player's
    // side toward the far end.
    const speed = 4.0 + Math.random() * 2.4;
    const heading = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI / 2;
    // Constant extra -Z bias on top of the heading's Z component so the
    // throw carries dice well past centre toward the north wall.
    const linVel = {
      x: speed * Math.cos(heading),
      y: -0.8 + Math.random() * 0.6,
      z: speed * Math.sin(heading) - 2.0,
    };
    const angVel = {
      x: (Math.random() - 0.5) * 30,
      y: (Math.random() - 0.5) * 30,
      z: (Math.random() - 0.5) * 30,
    };
    die.setMotion(linVel, angVel, 1/60);
    world.dice.push(die);
  }
}

// Phases of one rolling cycle:
//   'rolling'    — physics is running; waiting for dice to settle
//   'pause'      — settled; brief delay before reformatting
//   'transition' — sliding settled dice toward their row positions
//   'display'    — held at row positions until the next roll
let phase = 'rolling';
let settledFrames = 0;
let pauseStart = 0;
let transitionStart = 0;
let transitionFrom = [];
let transitionTo = [];
let lastT = performance.now();
let rollingStart = performance.now();
let stuckLogged = false;

// If the dice still haven't settled after 10s, dump per-die state to the
// console. The most useful fields for diagnosing a "won't stop rolling"
// die are the per-substep displacement (a velocity proxy) and the
// min/max particle y — together they reveal whether the die is bouncing
// off geometry, flying through air, or churning in place against its
// own constraints.
const SUB_RATE = 240; // matches the substep rate in frame()
function logStuckState() {
  const elapsed = ((performance.now() - rollingStart) / 1000).toFixed(2);
  console.warn(`dice-physics: not settled after ${elapsed}s`);
  for (let i = 0; i < world.dice.length; i++) {
    const d = world.dice[i];
    const c = d.center();
    let avgVx = 0, avgVy = 0, avgVz = 0;
    let minY = Infinity, maxY = -Infinity;
    for (let p = 0; p < 8; p++) {
      avgVx += d.x[p].x - d.xPrev[p].x;
      avgVy += d.x[p].y - d.xPrev[p].y;
      avgVz += d.x[p].z - d.xPrev[p].z;
      minY = Math.min(minY, d.x[p].y);
      maxY = Math.max(maxY, d.x[p].y);
    }
    avgVx = (avgVx / 8) * SUB_RATE;
    avgVy = (avgVy / 8) * SUB_RATE;
    avgVz = (avgVz / 8) * SUB_RATE;
    console.warn(`die ${i}`, {
      center: {x: +c.x.toFixed(3), y: +c.y.toFixed(3), z: +c.z.toFixed(3)},
      vCenterMS: {x: +avgVx.toFixed(2), y: +avgVy.toFixed(2), z: +avgVz.toFixed(2)},
      kineticEnergy: d.kineticEnergy().toExponential(3),
      minY: +minY.toFixed(3),
      maxY: +maxY.toFixed(3),
      onGround: d.x.some(p => p.y <= 1e-3),
      particles:     d.x.map(p => `(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})`),
      particlesPrev: d.xPrev.map(p => `(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})`),
    });
  }
}

function showResult() {
  // Read values in on-screen left-to-right order — same x-sort the
  // transition uses to assign dice to row slots, so the readout matches
  // the visual ordering during both pause and display phases.
  const sorted = [...world.dice].sort((a, b) => a.center().x - b.center().x);
  const values = sorted.map(topFaceValue);
  resultEl.textContent = 'rolled: ' + values.join('  ') +
    '   (sum ' + values.reduce((a, b) => a + b, 0) + ')';
}

function startPause() {
  showResult();
  pauseStart = performance.now();
  phase = 'pause';
}

// Workspace objects reused across frames to avoid per-frame allocations.
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();

// Pull the die's current orthonormal rotation as a Three.Quaternion.
function readDieQuat(die, out) {
  const axes = die.axes();
  const ax = V.norm(axes.x);
  const dot = V.dot(ax, axes.y);
  const ay = V.norm({
    x: axes.y.x - ax.x * dot,
    y: axes.y.y - ax.y * dot,
    z: axes.y.z - ax.z * dot,
  });
  const az = V.cross(ax, ay);
  _m.set(
    ax.x, ay.x, az.x, 0,
    ax.y, ay.y, az.y, 0,
    ax.z, ay.z, az.z, 0,
    0,    0,    0,    1,
  );
  out.setFromRotationMatrix(_m);
}

// Snap a near-axis-aligned vector to the closest world axis (with sign),
// optionally excluding an axis index already taken.
function snapAxis(v, excludeIdx) {
  const ax = excludeIdx === 0 ? -Infinity : Math.abs(v.x);
  const ay = excludeIdx === 1 ? -Infinity : Math.abs(v.y);
  const az = excludeIdx === 2 ? -Infinity : Math.abs(v.z);
  if (ax >= ay && ax >= az) return {axis: {x: Math.sign(v.x) || 1, y: 0, z: 0}, idx: 0};
  if (ay >= az)             return {axis: {x: 0, y: Math.sign(v.y) || 1, z: 0}, idx: 1};
  return                           {axis: {x: 0, y: 0, z: Math.sign(v.z) || 1}, idx: 2};
}

// Build the closest cube-symmetry rotation: snap each body axis to the
// nearest available world axis, then make z = x × y to keep right-handed.
function readSnappedQuat(die, out) {
  const axes = die.axes();
  const ax = V.norm(axes.x);
  const dot = V.dot(ax, axes.y);
  const ay = V.norm({
    x: axes.y.x - ax.x * dot,
    y: axes.y.y - ax.y * dot,
    z: axes.y.z - ax.z * dot,
  });
  const sx = snapAxis(ax, -1);
  const sy = snapAxis(ay, sx.idx);
  const sz = V.cross(sx.axis, sy.axis);
  _m.set(
    sx.axis.x, sy.axis.x, sz.x, 0,
    sx.axis.y, sy.axis.y, sz.y, 0,
    sx.axis.z, sy.axis.z, sz.z, 0,
    0,         0,         0,    1,
  );
  out.setFromRotationMatrix(_m);
}

function startTransition() {
  const n = world.dice.length;
  const spacing = DIE_SIZE + ROW_GAP;
  const totalW = (n - 1) * spacing;
  // Optimal slot assignment: sort dice by current x and match to slots in
  // ascending order. For collinear targets and any cost f(d)=√(dx²+dz²)
  // (or really, any function increasing in |dx|), this is provably the
  // minimum-total-distance permutation by the rearrangement inequality.
  const order = world.dice
    .map((d, i) => ({i, x: d.center().x}))
    .sort((a, b) => a.x - b.x)
    .map(o => o.i);
  transitionFrom = world.dice.map(d => {
    const c = d.center();
    const q = new THREE.Quaternion();
    readDieQuat(d, q);
    return {center: {x: c.x, y: c.y, z: c.z}, quat: q};
  });
  transitionTo = new Array(n);
  for (let k = 0; k < n; k++) {
    const dieIdx = order[k];
    const q = new THREE.Quaternion();
    readSnappedQuat(world.dice[dieIdx], q);
    transitionTo[dieIdx] = {
      center: {x: -totalW / 2 + k * spacing, y: DIE_SIZE / 2, z: 0},
      quat: q,
    };
  }
  transitionStart = performance.now();
  phase = 'transition';
}

// Place each particle at center + R(quat) * canonical_body_offset, and zero
// the implicit velocity so no leftover momentum carries into a future step.
function setDieTransform(die, center, quat) {
  const L = die.L;
  for (let i = 0; i < 8; i++) {
    const bx = (i & 1)        ? L / 2 : -L / 2;
    const by = ((i >> 1) & 1) ? L / 2 : -L / 2;
    const bz = ((i >> 2) & 1) ? L / 2 : -L / 2;
    _v.set(bx, by, bz).applyQuaternion(quat);
    die.x[i].x = center.x + _v.x;
    die.x[i].y = center.y + _v.y;
    die.x[i].z = center.z + _v.z;
    die.xPrev[i].x = die.x[i].x;
    die.xPrev[i].y = die.x[i].y;
    die.xPrev[i].z = die.x[i].z;
  }
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Place 5 dice in their final row positions showing the requested face
// values, so the page opens with the dice "already settled" and the
// user has to click to see them roll.
function setupInitialDisplay(faces) {
  const n = faces.length;
  const spacing = DIE_SIZE + ROW_GAP;
  const totalW = (n - 1) * spacing;
  // Body axis (in canonical body frame) that needs to point world +Y so
  // the named face value reads on top. Mirrors PIP_COUNTS in render.js:
  // +X→1, -X→6, +Y→2, -Y→5, +Z→3, -Z→4.
  const bodyUpForFace = {
    1: new THREE.Vector3( 1,  0,  0),
    6: new THREE.Vector3(-1,  0,  0),
    2: new THREE.Vector3( 0,  1,  0),
    5: new THREE.Vector3( 0, -1,  0),
    3: new THREE.Vector3( 0,  0,  1),
    4: new THREE.Vector3( 0,  0, -1),
  };
  const worldY = new THREE.Vector3(0, 1, 0);
  world.dice = [];
  for (let i = 0; i < n; i++) {
    const die = new Die(DIE_SIZE, {x: 0, y: 0, z: 0});
    const q = new THREE.Quaternion().setFromUnitVectors(bodyUpForFace[faces[i]], worldY);
    const center = {x: -totalW / 2 + i * spacing, y: DIE_SIZE / 2, z: 0};
    setDieTransform(die, center, q);
    world.dice.push(die);
  }
  phase = 'display';
}

function frame(t) {
  const dt = Math.min(0.033, (t - lastT) / 1000);
  lastT = t;

  if (phase === 'rolling') {
    const sub = 1 / 240;
    let acc = dt;
    while (acc > 0) {
      world.step(Math.min(sub, acc));
      acc -= sub;
    }
    consumeAudioEvents();
    // Two-tier settle test:
    //   • Low KE + low PE (centre below 0.6·L → resting on a face, not
    //     edge/corner balanced) ⇒ settle immediately.
    //   • Low KE only (cocked) ⇒ give gravity up to 60 frames (~1 s) to
    //     resolve the unstable balance, then settle anyway.
    // Once low-KE is reached, drop the bounding box so a die leaning
    // against an invisible wall can topple free; bounds are restored
    // when roll() starts a new cycle.
    if (world.dice.length > 0 && world.isSettled(2e-5)) {
      if (world.bounds === BOUNDS) world.bounds = DISABLED_BOUNDS;
      settledFrames++;
      const lowPE = world.isSettled(2e-5, DIE_SIZE * 0.6);
      if (lowPE || settledFrames >= 60) startPause();
    } else {
      settledFrames = 0;
    }
    if (!stuckLogged && performance.now() - rollingStart > 10000) {
      logStuckState();
      stuckLogged = true;
    }
  } else if (phase === 'pause') {
    if (performance.now() - pauseStart >= PAUSE_MS) startTransition();
  } else if (phase === 'transition') {
    const u = Math.min(1, (performance.now() - transitionStart) / TRANSITION_MS);
    const e = easeInOutCubic(u);
    for (let i = 0; i < world.dice.length; i++) {
      const f = transitionFrom[i];
      const tt = transitionTo[i];
      _q.slerpQuaternions(f.quat, tt.quat, e);
      const c = {
        x: f.center.x + (tt.center.x - f.center.x) * e,
        y: f.center.y + (tt.center.y - f.center.y) * e,
        z: f.center.z + (tt.center.z - f.center.z) * e,
      };
      setDieTransform(world.dice[i], c, _q);
    }
    if (u >= 1) phase = 'display';
  }
  // 'display' phase: hold position until next roll.

  renderer.update(world.dice);
  renderer.render();
  requestAnimationFrame(frame);
}

function roll() {
  const n = Math.max(1, Math.min(8, parseInt(countInput.value, 10) || 5));
  resultEl.textContent = '';
  settledFrames = 0;
  phase = 'rolling';
  rollingStart = performance.now();
  stuckLogged = false;
  // Restore the real bounding box (it was disabled at the end of the
  // previous roll once dice settled).
  world.bounds = BOUNDS;
  spawnDice(n);
  // Drop any contact events from the spawn position-clobbering so the very
  // first frame doesn't fire a phantom click.
  world.events.length = 0;
  world._pairContact = new Set();
}

// Wrap roll() so audio unlocks happen *inside* the gesture's call stack —
// some iOS versions invalidate the context if it's resumed asynchronously
// from a non-gesture context.
function userRoll() {
  unlockAudio();
  roll();
}
// Bind the sound-tuning sliders to soundParams. Each slider has an
// associated <output> element for the live value readout.
function bindSoundSlider(id, key, format) {
  const slider = document.getElementById(id);
  const out = document.getElementById(id + '-val');
  if (!slider || !out) return;
  slider.value = soundParams[key];
  out.textContent = format(soundParams[key]);
  slider.addEventListener('input', () => {
    soundParams[key] = parseFloat(slider.value);
    out.textContent = format(soundParams[key]);
  });
}
bindSoundSlider('s-q',    'q',            v => v.toFixed(1));
bindSoundSlider('s-flo',  'thudHz',       v => Math.round(v).toString());
bindSoundSlider('s-fhi',  'clickHz',      v => Math.round(v).toString());
bindSoundSlider('s-dlo',  'thudDecayMs',  v => Math.round(v).toString());
bindSoundSlider('s-dhi',  'clickDecayMs', v => Math.round(v).toString());
bindSoundSlider('s-pf',   'pairHz',       v => Math.round(v).toString());
bindSoundSlider('s-pd',   'pairDecayMs',  v => Math.round(v).toString());
bindSoundSlider('s-gain', 'gain',         v => v.toFixed(2));

// Same pattern for the physics panel — each slider live-mutates a
// property on `world`. World.step() reads these every substep, so
// changes take effect on the next physics tick.
function bindPhysicsSlider(id, prop, format) {
  const slider = document.getElementById(id);
  const out = document.getElementById(id + '-val');
  if (!slider || !out) return;
  slider.value = world[prop];
  out.textContent = format(world[prop]);
  slider.addEventListener('input', () => {
    world[prop] = parseFloat(slider.value);
    out.textContent = format(world[prop]);
  });
}
// Camera-tilt slider lives in the 'view' panel. Drives renderer.setTilt
// directly (the renderer owns the camera transform).
const tiltSlider = document.getElementById('v-tilt');
const tiltOut    = document.getElementById('v-tilt-val');
if (tiltSlider && tiltOut) {
  tiltOut.textContent = Math.round(parseFloat(tiltSlider.value)).toString();
  tiltSlider.addEventListener('input', () => {
    const v = parseFloat(tiltSlider.value);
    tiltOut.textContent = Math.round(v).toString();
    renderer.setTilt(v);
  });
}

bindPhysicsSlider('p-grav', 'gravity',    v => Math.round(v).toString());
bindPhysicsSlider('p-damp', 'damping',    v => v.toFixed(3));
bindPhysicsSlider('p-fric', 'friction',   v => v.toFixed(2));
bindPhysicsSlider('p-iter', 'iterations', v => Math.round(v).toString());

rollBtn.addEventListener('click', userRoll);
canvas.addEventListener('click', userRoll);
window.addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    userRoll();
  }
});

setupInitialDisplay([1, 2, 3, 4, 5]);
requestAnimationFrame(frame);
