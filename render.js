import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

import { V } from './physics.js?v=0537416';

// Explicit ColorManagement on — defaults to true in modern Three.js but
// some Android Chrome builds report it as off, which causes textures to
// be sampled without sRGB→linear conversion and renders as half-dark.
THREE.ColorManagement.enabled = true;

// Pip count per face, in BoxGeometry's face-group order (+X, -X, +Y, -Y,
// +Z, -Z). Opposite faces sum to 7. Used by topFaceValue().
const PIP_COUNTS = [1, 6, 2, 5, 3, 4];

// Pip layout in face-local UV space (u, v) ∈ [0, 1]².
const PIPS = {
  1: [[0.5, 0.5]],
  2: [[0.27, 0.27], [0.73, 0.73]],
  3: [[0.25, 0.25], [0.5, 0.5], [0.75, 0.75]],
  4: [[0.27, 0.27], [0.73, 0.27], [0.27, 0.73], [0.73, 0.73]],
  5: [[0.25, 0.25], [0.75, 0.25], [0.5, 0.5], [0.25, 0.75], [0.75, 0.75]],
  6: [[0.27, 0.22], [0.73, 0.22], [0.27, 0.5], [0.73, 0.5], [0.27, 0.78], [0.73, 0.78]],
};

// Per-face frames in body coordinates: outward normal + two in-plane axes
// to map (u, v) ∈ [0, 1]² onto a body-space pip position.
const PIP_FACE_FRAMES = [
  { count: 1, normal: [+1,  0,  0], u: [ 0, +1,  0], v: [ 0,  0, +1] }, // +X
  { count: 6, normal: [-1,  0,  0], u: [ 0, +1,  0], v: [ 0,  0, -1] }, // -X
  { count: 2, normal: [ 0, +1,  0], u: [+1,  0,  0], v: [ 0,  0, +1] }, // +Y
  { count: 5, normal: [ 0, -1,  0], u: [+1,  0,  0], v: [ 0,  0, -1] }, // -Y
  { count: 3, normal: [ 0,  0, +1], u: [+1,  0,  0], v: [ 0, +1,  0] }, // +Z
  { count: 4, normal: [ 0,  0, -1], u: [-1,  0,  0], v: [ 0, +1,  0] }, // -Z
];

export class DiceRenderer {
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.bounds = opts.bounds;
    this.dieSize = opts.dieSize;

    this.renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: false});
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // No tone mapping: ACES quietly darkens highlights, so the lit floor
    // and scene background were rendering visibly darker than the literal
    // CSS hex shown by the surrounding HTML. Pass colours straight
    // through; the lights below are tuned so a fully-lit floor lands at
    // its input value without saturating.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#f2efe9');

    // Orthographic camera positioned above and slightly behind the
    // scene (20° default tilt from vertical), looking at the origin.
    // Parallel projection means dice keep a constant size regardless of
    // distance — the tilt provides the only perspective cue, in the form
    // of the floor's foreshortening along Z.
    this.viewHalfTray = 5.2;
    this.cameraHeight = 10;
    this.cameraTiltDeg = 0;
    const tilt = this.cameraTiltDeg * Math.PI / 180;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 60);
    this.camera.up.set(0, 1, 0);
    this.camera.position.set(
      0,
      this.cameraHeight * Math.cos(tilt),
      this.cameraHeight * Math.sin(tilt),
    );
    this.camera.lookAt(0, 0, 0);

    // White lights, all channels multiplied by the same factor — the lit
    // floor is just a uniformly-brighter version of its input colour.
    // Modern Three.js (≥ r155) divides directional contributions by π in
    // its physically-correct lighting model, so directional intensities
    // here are pre-multiplied by π to land the lit-floor factor at ~1.0
    // (so the floor renders at its input hex). Ambient is not divided.
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    // Soft shadow via N small lights in a ring at the sun's direction,
    // each casting its own shadow. Partially-shadowed points (penumbra)
    // are blocked from only some of the lights → a smooth gradient
    // instead of one hard PCF edge. Total intensity = sum(per-light) so
    // overall scene brightness is unchanged.
    const SUN_LIGHTS = 6;
    const SUN_TOTAL_INTENSITY = 2.1;
    const SUN_POS = [2, 10, 1.5];
    const SUN_SPREAD = 0.7;
    for (let i = 0; i < SUN_LIGHTS; i++) {
      const a = (i / SUN_LIGHTS) * Math.PI * 2;
      const dx = Math.cos(a) * SUN_SPREAD;
      const dz = Math.sin(a) * SUN_SPREAD;
      const sun = new THREE.DirectionalLight(0xffffff, SUN_TOTAL_INTENSITY / SUN_LIGHTS);
      sun.position.set(SUN_POS[0] + dx, SUN_POS[1], SUN_POS[2] + dz);
      sun.castShadow = true;
      // Smaller shadow maps per light — many lights, but each's shadow
      // only contributes 1/N of the darkening so per-light fidelity
      // matters less.
      sun.shadow.mapSize.set(512, 512);
      sun.shadow.camera.left = -6;
      sun.shadow.camera.right = 6;
      sun.shadow.camera.top = 6;
      sun.shadow.camera.bottom = -6;
      sun.shadow.camera.near = 1;
      sun.shadow.camera.far = 30;
      sun.shadow.bias = -0.0005;
      sun.shadow.radius = 4;
      sun.shadow.intensity = 0.10;
      this.scene.add(sun);
    }
    const fill = new THREE.DirectionalLight(0xffffff, 0.48);
    fill.position.set(-4, 5, -3);
    this.scene.add(fill);

    // Tray floor — sized well beyond the dice bounding box so shadows
    // extending past the bounds still have a surface to fall on. Centred
    // on the bounds; cast shadows reach at most ~0.2·L past the bounds
    // with our near-vertical sun, so 30×30 is far more than needed.
    const floorGeom = new THREE.PlaneGeometry(30, 30);
    const floorMat = new THREE.MeshPhongMaterial({color: 0xf2efe9, shininess: 0});
    const floor = new THREE.Mesh(floorGeom, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(
      (this.bounds.minX + this.bounds.maxX) / 2,
      0,
      (this.bounds.minZ + this.bounds.maxZ) / 2,
    );
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Shared materials and geometry. The die body is a single-material
    // RoundedBoxGeometry; pips are separate sphere meshes parented to
    // each die's group, so the body never needs to know about the pip
    // pattern (and we never depend on canvas textures or normal maps,
    // both of which are flaky on some Android Chrome WebGL drivers).
    this.bodyMaterial = new THREE.MeshPhongMaterial({
      color: 0x7a4fb0,
      shininess: 32,
      specular: 0x2a1a40,
    });
    this.pipMaterial = new THREE.MeshPhongMaterial({
      color: 0xffffff,
      shininess: 30,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.bodyGeom = new RoundedBoxGeometry(
      this.dieSize, this.dieSize, this.dieSize, 4, this.dieSize * 0.10,
    );
    const pipR = this.dieSize * 0.090;
    this.pipGeom = new THREE.CircleGeometry(pipR, 22);
    // 5-pointed star for the 1-face, matching the SVG shape used by
    // Kevin's Dice. Outer/inner radius ratio is 1/φ² ≈ 0.382 (the
    // canonical proportions for a regular star polygon).
    const starOuterR = this.dieSize * 0.22;
    const starInnerR = starOuterR * 0.382;
    const starShape = new THREE.Shape();
    for (let i = 0; i < 10; i++) {
      const angle = -Math.PI / 2 + i * Math.PI / 5;
      const r = (i % 2 === 0) ? starOuterR : starInnerR;
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      if (i === 0) starShape.moveTo(x, y);
      else starShape.lineTo(x, y);
    }
    starShape.closePath();
    this.starGeom = new THREE.ShapeGeometry(starShape);

    this.dieMeshes = []; // Group instances; each contains body + pip children.

    this._tmpMat = new THREE.Matrix4();

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  // Set camera tilt-from-vertical (in degrees), keeping the same focal
  // distance to the origin and the same lookAt target.
  setTilt(deg) {
    this.cameraTiltDeg = deg;
    const tilt = deg * Math.PI / 180;
    this.camera.position.set(
      0,
      this.cameraHeight * Math.cos(tilt),
      this.cameraHeight * Math.sin(tilt),
    );
    this.camera.lookAt(0, 0, 0);
  }

  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    const aspect = w / Math.max(h, 1);
    // OrthographicCamera uses left/right/top/bottom in world units. Pick
    // halfH so viewHalfTray fits the smaller dimension: in landscape
    // the vertical extent is the bottleneck, in portrait widen halfH
    // by 1/aspect.
    const halfH = aspect >= 1 ? this.viewHalfTray : this.viewHalfTray / aspect;
    this.camera.left   = -halfH * aspect;
    this.camera.right  =  halfH * aspect;
    this.camera.top    =  halfH;
    this.camera.bottom = -halfH;
    this.camera.updateProjectionMatrix();
  }

  // Build one die: a Group whose matrix we drive directly each frame, with
  // the cube body and 21 pip-spheres as static children in body frame.
  _buildDie() {
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;

    const body = new THREE.Mesh(this.bodyGeom, this.bodyMaterial);
    body.castShadow = true;
    group.add(body);

    const L = this.dieSize;
    const zAxis = new THREE.Vector3(0, 0, 1);
    const tmp = new THREE.Vector3();
    for (const f of PIP_FACE_FRAMES) {
      // CircleGeometry's disc lies in the XY plane with normal +Z. Rotate
      // each pip so its disc-normal aligns with this face's outward normal.
      tmp.set(f.normal[0], f.normal[1], f.normal[2]);
      const faceQuat = new THREE.Quaternion().setFromUnitVectors(zAxis, tmp);
      // 1-face renders as a single 5-pointed star; all other faces use
      // CircleGeometry pip discs.
      const geomForFace = (f.count === 1) ? this.starGeom : this.pipGeom;
      for (const [u, v] of PIPS[f.count]) {
        const lu = (u - 0.5) * L;
        const lv = (v - 0.5) * L;
        const px = (L / 2) * f.normal[0] + lu * f.u[0] + lv * f.v[0];
        const py = (L / 2) * f.normal[1] + lu * f.u[1] + lv * f.v[1];
        const pz = (L / 2) * f.normal[2] + lu * f.u[2] + lv * f.v[2];
        const pip = new THREE.Mesh(geomForFace, this.pipMaterial);
        pip.position.set(px, py, pz);
        pip.quaternion.copy(faceQuat);
        group.add(pip);
      }
    }
    return group;
  }

  _ensureMeshCount(n) {
    while (this.dieMeshes.length < n) {
      const g = this._buildDie();
      this.scene.add(g);
      this.dieMeshes.push(g);
    }
    while (this.dieMeshes.length > n) {
      const g = this.dieMeshes.pop();
      this.scene.remove(g);
    }
  }

  update(dice) {
    this._ensureMeshCount(dice.length);
    for (let i = 0; i < dice.length; i++) {
      const d = dice[i];
      const c = d.center();
      const axes = d.axes();
      const ax = V.norm(axes.x);
      const ayRaw = axes.y;
      const dotXY = V.dot(ax, ayRaw);
      const ay = V.norm({
        x: ayRaw.x - ax.x * dotXY,
        y: ayRaw.y - ax.y * dotXY,
        z: ayRaw.z - ax.z * dotXY,
      });
      const az = V.cross(ax, ay);
      this._tmpMat.set(
        ax.x, ay.x, az.x, c.x,
        ax.y, ay.y, az.y, c.y,
        ax.z, ay.z, az.z, c.z,
        0,    0,    0,    1,
      );
      this.dieMeshes[i].matrix.copy(this._tmpMat);
    }
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}

// Returns 1..6 — pip count of the face whose outward world-space normal
// points most upward.
export function topFaceValue(die) {
  const axes = die.axes();
  const candidates = [
    {n:  axes.x, pip: PIP_COUNTS[0]},
    {n: {x: -axes.x.x, y: -axes.x.y, z: -axes.x.z}, pip: PIP_COUNTS[1]},
    {n:  axes.y, pip: PIP_COUNTS[2]},
    {n: {x: -axes.y.x, y: -axes.y.y, z: -axes.y.z}, pip: PIP_COUNTS[3]},
    {n:  axes.z, pip: PIP_COUNTS[4]},
    {n: {x: -axes.z.x, y: -axes.z.y, z: -axes.z.z}, pip: PIP_COUNTS[5]},
  ];
  let bestPip = 1, bestY = -Infinity;
  for (const c of candidates) {
    const ny = c.n.y / V.len(c.n);
    if (ny > bestY) { bestY = ny; bestPip = c.pip; }
  }
  return bestPip;
}
