import * as THREE from 'three';
import { Octree } from 'three/examples/jsm/math/Octree.js';
import { PALETTE as P, toon, textTexture } from '../core/toon.js';
import { applySky } from './sky.js';

/*
  Layout (metres). Player spawns at z = +40 looking toward -Z.

          -X  ◄──────────────────────────────────►  +X
    ┌─────────────────────────────────────────────────────────┐
    │ PILLARS     MANTLE     SHOOTING LANE   VAULT     SLIDE   │  z = -40
    │ x≈-52       x≈-30      x∈[-12,12]      x≈29      x≈53    │
    │                                                          │
    │                         ▲ spawn (0, 40)                  │  z = +50
    └─────────────────────────────────────────────────────────┘
*/

const mats = new Map();
function mat(color) {
  if (!mats.has(color)) mats.set(color, toon(color, { rim: 0.14 }));
  return mats.get(color);
}

export class TestRange {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.colliders = new THREE.Group();
    this.group.add(this.colliders);
    scene.add(this.group);

    this.spawn = { position: new THREE.Vector3(0, 0, 40), yaw: 0 };
    this.#atmosphere();
    this.#ground();
    this.#perimeter();
    this.#shootingLane();
    this.#vaultCourse();
    this.#mantleCourse();
    this.#slideRamp();
    this.#pillars();
    this.#backdrop();

    this.colliders.updateMatrixWorld(true);
    this.octree = new Octree().fromGraphNode(this.colliders);
    /** Meshes bullets can hit (dummies append their hitboxes). */
    this.raycastTargets = [...this.colliders.children];
  }

  /** Box resting on y = base, centred on x/z. Returns the mesh. */
  block(x, base, z, w, h, d, color, { rotY = 0, collide = true, label } = {}) {
    const geo = new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(geo, mat(color));
    mesh.position.set(x, base + h / 2, z);
    mesh.rotation.y = rotY;
    mesh.castShadow = mesh.receiveShadow = true;
    (collide ? this.colliders : this.group).add(mesh);
    if (label) this.label(mesh, label, d / 2 + 0.01, Math.min(w * 0.8, 2.4));
    return mesh;
  }

  /** Inclined slab whose top surface goes from y = 0 at zLow to y = rise at zHigh. */
  ramp(x, zLow, zHigh, width, rise, color) {
    const run = Math.abs(zHigh - zLow);
    const len = Math.hypot(run, rise);
    const t = 0.6;
    const angle = Math.atan2(rise, run);
    const geo = new THREE.BoxGeometry(width, t, len);
    const mesh = new THREE.Mesh(geo, mat(color));
    mesh.rotation.x = zHigh < zLow ? angle : -angle;
    mesh.position.set(x, rise / 2 - (t / 2) * Math.cos(angle), (zLow + zHigh) / 2);
    mesh.castShadow = mesh.receiveShadow = true;
    this.colliders.add(mesh);
    return mesh;
  }

  label(parent, text, offsetZ, width = 2) {
    const tex = textTexture([{ text, font: '700 150px "JetBrains Mono", monospace' }], { width: 512, height: 256, align: 'center', bg: '#141413', fg: '#faf9f5' });
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(width, width / 2), new THREE.MeshBasicMaterial({ map: tex }));
    plate.position.set(0, 0, offsetZ);
    parent.add(plate);
    return plate;
  }

  /** Neo-brutalist zone sign on two posts, facing +Z. */
  sign(x, z, index, title, subtitle, rotY = 0) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rotY;
    const tex = textTexture(
      [
        { text: index, font: '600 64px "JetBrains Mono", monospace', color: '#d97757' },
        { text: title, font: 'italic 600 128px "Source Serif 4", serif' },
        { text: subtitle, font: '500 48px "JetBrains Mono", monospace', color: '#87867f' },
      ],
      { width: 1024, height: 420, accent: '#d97757' },
    );
    const board = new THREE.Mesh(new THREE.BoxGeometry(5, 2.05, 0.2), [
      mat(P.ink, false), mat(P.ink, false), mat(P.ink, false), mat(P.ink, false),
      new THREE.MeshBasicMaterial({ map: tex }), mat(P.ink, false),
    ]);
    board.position.y = 4.2;
    board.castShadow = true;
    g.add(board);
    for (const px of [-1.8, 1.8]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 3.2, 0.18), mat(P.slate, false));
      post.position.set(px, 1.6, -0.05);
      post.castShadow = true;
      g.add(post);
    }
    this.group.add(g);
  }

  #atmosphere() {
    const s = this.scene;
    applySky(s);
    s.fog = new THREE.Fog(P.pampas, 70, 230);
    s.add(new THREE.HemisphereLight(0xfffaf0, P.kraft, 1.25));
    const sun = new THREE.DirectionalLight(0xfff4e6, 2.4);
    sun.position.set(-45, 90, 35);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.userData.shadowFollow = 40; // the renderer keeps the shadow box on the player (±40 m)
    const c = sun.shadow.camera;
    c.near = 10;
    c.far = 260;
    sun.shadow.bias = -0.0004;
    s.add(sun, sun.target);
  }

  #ground() {
    const size = 240;
    const geo = new THREE.PlaneGeometry(size, size);
    geo.rotateX(-Math.PI / 2);
    geo.attributes.uv.array.forEach((v, i, a) => (a[i] = v * (size / 4)));
    const ground = new THREE.Mesh(geo, mat(P.oat));
    ground.receiveShadow = true;
    this.colliders.add(ground);

    // spawn pad + lane paint (visual only). Markings never overlap each other, and a depth
    // offset keeps them from z-fighting the ground at distance.
    const decalMat = (color) => toon(color, { rim: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const paint = (x, z, w, d, color, geo = new THREE.PlaneGeometry(w, d)) => {
      const m = new THREE.Mesh(geo, decalMat(color));
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.01, z);
      m.receiveShadow = true;
      this.group.add(m);
    };
    const frame = new THREE.Shape([[-3, -3], [3, -3], [3, 3], [-3, 3]].map(([a, b]) => new THREE.Vector2(a, b)));
    frame.holes.push(new THREE.Path([[-2.3, -2.3], [-2.3, 2.3], [2.3, 2.3], [2.3, -2.3]].map(([a, b]) => new THREE.Vector2(a, b))));
    paint(0, 40, 0, 0, P.clay, new THREE.ShapeGeometry(frame));
    paint(0, 40, 4.6, 4.6, P.ivory);
    paint(0, 36, 24, 0.25, P.ink); // firing line
    for (const z of [26, 16, 1, -19]) paint(0, z, 24, 0.12, P.cloud);
  }

  #perimeter() {
    const H = 8, T = 1.2;
    this.block(0, 0, -62, 150, H, T, P.slate);
    this.block(0, 0, 62, 150, H, T, P.slate);
    this.block(-75, 0, 0, T, H, 125, P.slate);
    this.block(75, 0, 0, T, H, 125, P.slate);
  }

  #shootingLane() {
    this.sign(-8.5, 34.5, '01 / RANGE', 'Shooting lane', '10 · 20 · 35 · 55 M');
    // benches either side of the walkway
    this.block(-8, 0, 36.6, 7, 1.0, 0.7, P.slate);
    this.block(8, 0, 36.6, 7, 1.0, 0.7, P.slate);
    // lane dividers
    this.block(-13, 0, 0, 0.5, 1.2, 70, P.ivory);
    this.block(13, 0, 0, 0.5, 1.2, 70, P.ivory);
    // distance markers
    [[26, '10M'], [16, '20M'], [1, '35M'], [-19, '55M']].forEach(([z, t]) => {
      const post = this.block(-11.5, 0, z, 1.4, 1.6, 0.3, P.ink, { collide: false });
      this.label(post, t, 0.16, 1.3);
    });
    // cover pieces to practise mantling / peeking
    this.block(-5, 0, 21, 3, 1.1, 0.8, P.kraft);
    this.block(5.5, 0, 11, 2.4, 1.6, 2.4, P.kraft);
    this.block(-4, 0, 5, 1.6, 2.2, 1.6, P.kraft);
    // elevated perch for vertical targets
    this.block(6, 0, -19, 5, 3, 4, P.ivory);
    this.block(0, 0, -40, 26, 9, 1.5, P.ink); // backstop

    this.dummySpots = [
      { type: 'static', pos: [-4, 0, 26] },
      { type: 'static', pos: [0, 0, 26] },
      { type: 'static', pos: [4, 0, 26] },
      { type: 'strafe', pos: [0, 0, 16], range: 6, speed: 4.2 },
      { type: 'static', pos: [-6, 0, 1] },
      { type: 'strafe', pos: [2, 0, 1], range: 5, speed: 5.5, jitter: true },
      { type: 'orbit', pos: [-3, 0, -19], radius: 3.5, speed: 0.8 },
      { type: 'static', pos: [6, 3, -19] },
    ];
  }

  #vaultCourse() {
    this.sign(29, 34, '02 / MOVE', 'Vault', 'SPRINT · JUMP AT IT');
    // a lane of low, thin obstacles, rising in height (thicker ones you climb onto instead)
    [0.6, 0.9, 1.1, 1.3].forEach((h, i) => this.block(29, 0, 18 - i * 14, 8, h, 0.5, P.clay, { label: `${h.toFixed(1)} M` }));
    this.block(29, 0, -44, 12, 3, 6, P.ivory);
    this.block(29, 3, -46.5, 12, 0.3, 1, P.ink);
  }

  #mantleCourse() {
    this.sign(-30, 34, '03 / MOVE', 'Mantle', 'JUMP INTO A LEDGE');
    [1.0, 1.5, 2.0, 2.5, 3.0].forEach((h, i) => {
      this.block(-30, 0, 24 - i * 9, 4, h, 4, P.sage, { label: `${h.toFixed(1)} M` });
    });
    // step tower: each tier needs a mantle
    [1.2, 2.4, 3.6, 4.8].forEach((h, i) => this.block(-36, 0, -24 - i * 4, 5, h, 4, P.sage));
  }

  #slideRamp() {
    this.sign(44, 34, '04 / MOVE', 'Slide', 'SPRINT · C TO SLIDE');
    this.block(53, 0, 14, 14, 5, 10, P.ivory); // deck, top at 5 m
    this.ramp(53, -15, 9, 14, 5, P.sky); // long downhill run
    this.ramp(53, 35, 19, 6, 5, P.oat); // access ramp
    this.ramp(53, -24, -30, 8, 1.6, P.sky); // kicker
  }

  #pillars() {
    this.sign(-55, 34, '05 / FLOW', 'Pillars', 'PEEK · STRAFE · COVER');
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 2; j++) {
        this.block(-60 + j * 9, 0, 18 - i * 11 + j * 5.5, 2.2, 9, 2.2, P.sky);
      }
    }
    this.block(-55.5, 0, -32, 12, 3.5, 8, P.ivory);
  }

  #backdrop() {
    // far monoliths for depth and horizon rhythm (no collision, fogged)
    const rng = mulberry(7);
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2;
      const r = 150 + rng() * 40;
      const h = 20 + rng() * 45;
      const w = 10 + rng() * 18;
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), toon(i % 3 ? P.oat : P.kraft, { rim: 0 }));
      m.position.set(Math.cos(a) * r, h / 2, Math.sin(a) * r);
      m.rotation.y = rng() * Math.PI;
      this.group.add(m);
    }
  }
}

function mulberry(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
