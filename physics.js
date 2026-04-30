// Verlet rigid-cube physics for visual dice. Each die is 8 corner particles
// with all 28 pairwise distances enforced as constraints — that's the full
// rigidity set, redundant but trivially correct after a few iteration passes
// (Jakobsen, "Advanced Character Physics", GDC 2001).

export const V = {
  add:   (a, b) => ({x: a.x + b.x, y: a.y + b.y, z: a.z + b.z}),
  sub:   (a, b) => ({x: a.x - b.x, y: a.y - b.y, z: a.z - b.z}),
  scale: (a, s) => ({x: a.x * s, y: a.y * s, z: a.z * s}),
  dot:   (a, b) => a.x*b.x + a.y*b.y + a.z*b.z,
  cross: (a, b) => ({
    x: a.y*b.z - a.z*b.y,
    y: a.z*b.x - a.x*b.z,
    z: a.x*b.y - a.y*b.x,
  }),
  len:   a => Math.sqrt(a.x*a.x + a.y*a.y + a.z*a.z),
  norm:  a => { const l = V.len(a); return l > 1e-9 ? V.scale(a, 1/l) : {x:0,y:0,z:0}; },
};

// Corner i = (bz<<2) | (by<<1) | bx, with bit values 0 = -L/2, 1 = +L/2.
// So corner 0 = (-,-,-), corner 7 = (+,+,+).
// Edges connect corners differing in exactly one bit — 4 along each axis.
const EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7],  // x-direction
  [0, 2], [1, 3], [4, 6], [5, 7],  // y-direction
  [0, 4], [1, 5], [2, 6], [3, 7],  // z-direction
];

export class Die {
  constructor(L, center, faceColor) {
    this.L = L;
    this.faceColor = faceColor || '#f5f1e8';
    this.x = [];
    this.xPrev = [];
    for (let i = 0; i < 8; i++) {
      const bx = i & 1, by = (i >> 1) & 1, bz = (i >> 2) & 1;
      const p = {
        x: center.x + (bx - 0.5) * L,
        y: center.y + (by - 0.5) * L,
        z: center.z + (bz - 0.5) * L,
      };
      this.x.push({...p});
      this.xPrev.push({...p});
    }
    this.constraints = [];
    for (let i = 0; i < 8; i++) {
      for (let j = i + 1; j < 8; j++) {
        this.constraints.push({i, j, d: V.len(V.sub(this.x[i], this.x[j]))});
      }
    }
  }

  center() {
    let cx = 0, cy = 0, cz = 0;
    for (const p of this.x) { cx += p.x; cy += p.y; cz += p.z; }
    return {x: cx/8, y: cy/8, z: cz/8};
  }

  // Cube's body axes recovered from the (slightly sheared) particle layout.
  // Rendering needs face orientation; collision needs to test points in the
  // cube's local frame.
  axes() {
    const x = this.x;
    const ax = V.scale(V.sub(
      V.add(V.add(x[1], x[3]), V.add(x[5], x[7])),
      V.add(V.add(x[0], x[2]), V.add(x[4], x[6])),
    ), 0.25);
    const ay = V.scale(V.sub(
      V.add(V.add(x[2], x[3]), V.add(x[6], x[7])),
      V.add(V.add(x[0], x[1]), V.add(x[4], x[5])),
    ), 0.25);
    const az = V.scale(V.sub(
      V.add(V.add(x[4], x[5]), V.add(x[6], x[7])),
      V.add(V.add(x[0], x[1]), V.add(x[2], x[3])),
    ), 0.25);
    return {x: ax, y: ay, z: az};
  }

  setMotion(linearVel, angularVel, dt) {
    const c = this.center();
    for (let i = 0; i < 8; i++) {
      const r = V.sub(this.x[i], c);
      const rot = V.cross(angularVel, r);
      const v = V.add(linearVel, rot);
      this.xPrev[i] = V.sub(this.x[i], V.scale(v, dt));
    }
  }

  // Apply a rotation (Rodrigues) about the die's centre — used to randomise
  // the initial orientation of a freshly-spawned die.
  rotateAbout(axisUnit, theta) {
    const c = this.center();
    const cosT = Math.cos(theta), sinT = Math.sin(theta);
    const k = axisUnit;
    for (let i = 0; i < 8; i++) {
      const v = V.sub(this.x[i], c);
      const dot = V.dot(k, v);
      const cr = V.cross(k, v);
      const r = {
        x: v.x*cosT + cr.x*sinT + k.x*dot*(1 - cosT),
        y: v.y*cosT + cr.y*sinT + k.y*dot*(1 - cosT),
        z: v.z*cosT + cr.z*sinT + k.z*dot*(1 - cosT),
      };
      this.x[i] = V.add(c, r);
      this.xPrev[i] = {...this.x[i]};
    }
  }

  // Snap all 8 particles (and their xPrev counterparts) back to a perfectly
  // rigid configuration matching the current best-fit centre + orthonormal
  // frame. Removes any constraint-induced shear/stretch left over from the
  // iteration loop, so deformation energy can't pump into rotational or
  // translational motion across substeps.
  regularize() {
    const halfL = this.L / 2;

    const fitFrame = (pts) => {
      let cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < 8; i++) { cx += pts[i].x; cy += pts[i].y; cz += pts[i].z; }
      const c = {x: cx / 8, y: cy / 8, z: cz / 8};
      // Same recovery as Die.axes() — body x/y/z derived as the difference
      // of opposite-face mean positions, divided by 4.
      const axRaw = V.scale(V.sub(
        V.add(V.add(pts[1], pts[3]), V.add(pts[5], pts[7])),
        V.add(V.add(pts[0], pts[2]), V.add(pts[4], pts[6])),
      ), 0.25);
      const ayRaw = V.scale(V.sub(
        V.add(V.add(pts[2], pts[3]), V.add(pts[6], pts[7])),
        V.add(V.add(pts[0], pts[1]), V.add(pts[4], pts[5])),
      ), 0.25);
      const ax = V.norm(axRaw);
      const dotXY = V.dot(ax, ayRaw);
      const ay = V.norm({
        x: ayRaw.x - ax.x * dotXY,
        y: ayRaw.y - ax.y * dotXY,
        z: ayRaw.z - ax.z * dotXY,
      });
      const az = V.cross(ax, ay);
      return {c, ax, ay, az};
    };

    const cur  = fitFrame(this.x);
    const prev = fitFrame(this.xPrev);

    for (let i = 0; i < 8; i++) {
      const sx = (i & 1)        ? halfL : -halfL;
      const sy = ((i >> 1) & 1) ? halfL : -halfL;
      const sz = ((i >> 2) & 1) ? halfL : -halfL;
      this.x[i].x = cur.c.x + cur.ax.x * sx + cur.ay.x * sy + cur.az.x * sz;
      this.x[i].y = cur.c.y + cur.ax.y * sx + cur.ay.y * sy + cur.az.y * sz;
      this.x[i].z = cur.c.z + cur.ax.z * sx + cur.ay.z * sy + cur.az.z * sz;
      this.xPrev[i].x = prev.c.x + prev.ax.x * sx + prev.ay.x * sy + prev.az.x * sz;
      this.xPrev[i].y = prev.c.y + prev.ax.y * sx + prev.ay.y * sy + prev.az.y * sz;
      this.xPrev[i].z = prev.c.z + prev.ax.z * sx + prev.ay.z * sy + prev.az.z * sz;
    }
  }

  kineticEnergy() {
    let s = 0;
    for (let i = 0; i < 8; i++) {
      const dx = this.x[i].x - this.xPrev[i].x;
      const dy = this.x[i].y - this.xPrev[i].y;
      const dz = this.x[i].z - this.xPrev[i].z;
      s += dx*dx + dy*dy + dz*dz;
    }
    return s / 8;
  }
}

export class World {
  constructor(opts = {}) {
    this.dice = [];
    this.gravity    = opts.gravity    ?? -32;
    this.damping    = opts.damping    ?? 0.997;
    this.friction   = opts.friction   ?? 0.18;
    this.bounds     = opts.bounds     ?? {minX: -4, maxX: 4, minZ: -4, maxZ: 4, maxY: 2.5};
    this.iterations = opts.iterations ?? 8;
    // Per-step rising-edge contact events. Drained by the application
    // (main.js) after each frame's substep loop. Each event has type
    // ('ground' | 'pair') and a `speed` field — m/s of the impact, used as
    // an audio-volume proxy.
    this.events = [];
    this._pairContact = new Set();
  }

  step(dt) {
    // 1) Verlet integrate.
    for (const d of this.dice) {
      for (let i = 0; i < 8; i++) {
        const xi = d.x[i], xp = d.xPrev[i];
        const vx = (xi.x - xp.x) * this.damping;
        const vy = (xi.y - xp.y) * this.damping;
        const vz = (xi.z - xp.z) * this.damping;
        d.xPrev[i] = {x: xi.x, y: xi.y, z: xi.z};
        xi.x += vx;
        xi.y += vy + this.gravity * dt * dt;
        xi.z += vz;
      }
    }
    // Floor-impact detection. After Verlet but before the constraint
    // iterations clamp, a particle with x.y < 0 represents a real
    // penetration; (xPrev.y - x.y) / dt is its true impact velocity. A
    // velocity threshold filters out the gravity-tick on already-resting
    // particles (their downward speed is just g·dt ≈ 0.2 m/s) and lets
    // through real impacts (initial fall, tipping corner coming down,
    // bounce-down). One event per die per substep, with the max impact
    // speed across vertices that just hit.
    const IMPACT_SPEED_MIN = 0.5;
    for (let di = 0; di < this.dice.length; di++) {
      const d = this.dice[di];
      let maxImpact = 0;
      for (let p = 0; p < 8; p++) {
        if (d.x[p].y < 0) {
          const v = (d.xPrev[p].y - d.x[p].y) / dt;
          if (v > IMPACT_SPEED_MIN && v > maxImpact) maxImpact = v;
        }
      }
      if (maxImpact > 0) {
        this.events.push({type: 'ground', dieIdx: di, speed: maxImpact});
      }
    }
    // 2) Iteratively project constraints + collisions.
    for (let it = 0; it < this.iterations; it++) {
      for (const d of this.dice) {
        for (const c of d.constraints) {
          const a = d.x[c.i], b = d.x[c.j];
          const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
          const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
          if (dist < 1e-9) continue;
          const k = (dist - c.d) / dist * 0.5;
          const px = dx*k, py = dy*k, pz = dz*k;
          a.x += px; a.y += py; a.z += pz;
          b.x -= px; b.y -= py; b.z -= pz;
        }
      }
      // Hard min-distance constraint between centres: dA and dB must be at
      // least (LA+LB)/2 apart. Fully projected per iteration ("infinite
      // stiffness") so this dominates and the per-feature pass below only
      // needs to clean up rotation-induced overlap.
      for (let i = 0; i < this.dice.length; i++) {
        for (let j = i + 1; j < this.dice.length; j++) {
          const dA = this.dice[i], dB = this.dice[j];
          const ca = dA.center(), cb = dB.center();
          const dx = cb.x - ca.x, dy = cb.y - ca.y, dz = cb.z - ca.z;
          const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
          const minDist = (dA.L + dB.L) * 0.5;
          if (dist >= minDist || dist < 1e-9) continue;
          const k = (minDist - dist) * 0.5 / dist;
          const px = dx * k, py = dy * k, pz = dz * k;
          for (let m = 0; m < 8; m++) {
            dA.x[m].x -= px; dA.x[m].y -= py; dA.x[m].z -= pz;
            dB.x[m].x += px; dB.x[m].y += py; dB.x[m].z += pz;
          }
        }
      }
      // Dice-vs-dice. Vertex tests alone miss edge-on-edge contacts (two cubes
      // can interlock with no vertex of either inside the other), so we also
      // test edge midpoints — virtual feature points whose pushes are
      // distributed back to the two endpoint particles.
      for (let i = 0; i < this.dice.length; i++) {
        for (let j = 0; j < this.dice.length; j++) {
          if (i === j) continue;
          this._resolveCubeVsCube(this.dice[i], this.dice[j]);
        }
      }
      // Floor + walls + ceiling clamps. Floor handling embeds friction:
      // when a particle is below the floor, lerp its horizontal position
      // toward the impact point (where the segment pp→p first crosses
      // y=0) by `friction`. friction=0 means full slide (p stays at the
      // post-impact projection); friction=1 means no slide (p lands at
      // the impact point). For a particle already on the floor with
      // pp.y=0, the impact point degenerates to (pp.x, 0, pp.z), so the
      // same formula gives sliding friction.
      for (const d of this.dice) {
        for (let i = 0; i < 8; i++) {
          const p = d.x[i], pp = d.xPrev[i];
          if (p.y < 0) {
            // Find the intersection of the ray pp + t·(p - pp) with the
            // floor (y=0). Clamp t to [0, 1] so a previously-penetrating
            // pp (pp.y < 0, e.g. numerical drift) doesn't push the
            // impact point off the segment.
            const ppy = pp.y;
            const py = p.y;
            const denom = ppy - py;
            let t = denom > 1e-12 ? ppy / denom : 0;
            if (t < 0) t = 0;
            else if (t > 1) t = 1;
            const P1x = pp.x + t * (p.x - pp.x);
            const P1z = pp.z + t * (p.z - pp.z);
            p.x = this.friction * P1x + (1 - this.friction) * p.x;
            p.z = this.friction * P1z + (1 - this.friction) * p.z;
            p.y = 0;
          }
          if (p.x < this.bounds.minX) p.x = this.bounds.minX;
          if (p.x > this.bounds.maxX) p.x = this.bounds.maxX;
          if (p.z < this.bounds.minZ) p.z = this.bounds.minZ;
          if (p.z > this.bounds.maxZ) p.z = this.bounds.maxZ;
          if (this.bounds.maxY !== undefined && p.y > this.bounds.maxY) {
            p.y = this.bounds.maxY;
            if (pp.y < p.y) pp.y = p.y;
          }
        }
      }
    }
    // Shape-matching: snap each die back to a perfectly rigid configuration
    // (and snap its xPrev to the rigid frame from the start of this
    // substep). Deformation energy left in the cube edges by the iteration
    // loop is dissipated here instead of being pumped back into linear/
    // angular motion on subsequent steps.
    for (const d of this.dice) d.regularize();

    // Pair contacts: in-contact when centres are within ~L*1.02. The hard
    // separator keeps centres ≥ L apart, so this rises only when two dice
    // genuinely meet, not from numerical jitter at the boundary.
    const newPairs = new Set();
    for (let i = 0; i < this.dice.length; i++) {
      for (let j = i + 1; j < this.dice.length; j++) {
        const dA = this.dice[i], dB = this.dice[j];
        const ca = dA.center(), cb = dB.center();
        const dx = ca.x - cb.x, dy = ca.y - cb.y, dz = ca.z - cb.z;
        const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
        const minDist = (dA.L + dB.L) * 0.5;
        if (dist < minDist * 1.02) {
          const key = i + '_' + j;
          newPairs.add(key);
          if (!this._pairContact.has(key)) {
            // Approximate closing speed along the centre-to-centre axis.
            const vax = (ca.x - this._prevCenterX(dA)) / dt;
            const vay = (ca.y - this._prevCenterY(dA)) / dt;
            const vaz = (ca.z - this._prevCenterZ(dA)) / dt;
            const vbx = (cb.x - this._prevCenterX(dB)) / dt;
            const vby = (cb.y - this._prevCenterY(dB)) / dt;
            const vbz = (cb.z - this._prevCenterZ(dB)) / dt;
            const rel = Math.sqrt(
              (vax - vbx) * (vax - vbx) +
              (vay - vby) * (vay - vby) +
              (vaz - vbz) * (vaz - vbz)
            );
            this.events.push({type: 'pair', i, j, speed: rel});
          }
        }
      }
    }
    this._pairContact = newPairs;
  }

  // Average of the saved xPrev positions — i.e., the die's centre at the
  // start of this substep, used for relative-velocity estimates.
  _prevCenterX(d) { let s = 0; for (let i = 0; i < 8; i++) s += d.xPrev[i].x; return s / 8; }
  _prevCenterY(d) { let s = 0; for (let i = 0; i < 8; i++) s += d.xPrev[i].y; return s / 8; }
  _prevCenterZ(d) { let s = 0; for (let i = 0; i < 8; i++) s += d.xPrev[i].z; return s / 8; }

  _resolveCubeVsCube(dA, dB) {
    const half = dB.L / 2;
    const center = dB.center();
    const axes = dB.axes();
    const lx2 = V.len(axes.x), ly2 = V.len(axes.y), lz2 = V.len(axes.z);
    if (lx2 < 1e-9 || ly2 < 1e-9 || lz2 < 1e-9) return;
    const ux = V.scale(axes.x, 1/lx2);
    const uy = V.scale(axes.y, 1/ly2);
    const uz = V.scale(axes.z, 1/lz2);

    // Push a feature point of A out of B's box, recoiling B's centre.
    // applyA() distributes the +0.5*push share across the particle(s)
    // backing this feature point.
    const test = (point, applyA) => {
      const rx = point.x - center.x, ry = point.y - center.y, rz = point.z - center.z;
      const lx = rx*ux.x + ry*ux.y + rz*ux.z;
      const ly = rx*uy.x + ry*uy.y + rz*uy.z;
      const lz = rx*uz.x + ry*uz.y + rz*uz.z;
      const ax = Math.abs(lx), ay = Math.abs(ly), az = Math.abs(lz);
      if (ax >= half || ay >= half || az >= half) return;
      const px = half - ax, py = half - ay, pz = half - az;
      let pX, pY, pZ;
      if (px <= py && px <= pz) {
        const s = Math.sign(lx) * px;
        pX = ux.x * s; pY = ux.y * s; pZ = ux.z * s;
      } else if (py <= pz) {
        const s = Math.sign(ly) * py;
        pX = uy.x * s; pY = uy.y * s; pZ = uy.z * s;
      } else {
        const s = Math.sign(lz) * pz;
        pX = uz.x * s; pY = uz.y * s; pZ = uz.z * s;
      }
      applyA(pX, pY, pZ);
      const bx = -pX/16, by = -pY/16, bz = -pZ/16;
      for (let m = 0; m < 8; m++) {
        dB.x[m].x += bx; dB.x[m].y += by; dB.x[m].z += bz;
      }
    };

    // 8 corner vertices.
    for (let k = 0; k < 8; k++) {
      const v = dA.x[k];
      test(v, (pX, pY, pZ) => {
        v.x += pX * 0.5; v.y += pY * 0.5; v.z += pZ * 0.5;
      });
    }
    // 12 edge midpoints — virtual points whose +0.5*push is split
    // 50/50 across the two endpoint particles.
    for (let e = 0; e < EDGES.length; e++) {
      const a = EDGES[e][0], b = EDGES[e][1];
      const pa = dA.x[a], pb = dA.x[b];
      const mid = {
        x: (pa.x + pb.x) * 0.5,
        y: (pa.y + pb.y) * 0.5,
        z: (pa.z + pb.z) * 0.5,
      };
      test(mid, (pX, pY, pZ) => {
        pa.x += pX * 0.25; pa.y += pY * 0.25; pa.z += pZ * 0.25;
        pb.x += pX * 0.25; pb.y += pY * 0.25; pb.z += pZ * 0.25;
      });
    }
  }

  isSettled(threshold = 1e-4, maxCenterY = Infinity) {
    // A die counts as settled only if it's nearly stationary AND its centre
    // is below `maxCenterY`. The height check rules out two false positives:
    // a die at the apex of a bounce (zero velocity, mid-air) and a die
    // stacked on top of another (low velocity, but well above the floor).
    for (const d of this.dice) {
      if (d.kineticEnergy() > threshold) return false;
      if (d.center().y > maxCenterY) return false;
    }
    return true;
  }
}

