import * as THREE from 'three';
import { Octree } from 'three/examples/jsm/math/Octree.js';
import { PALETTE as P, toon, gridTexture, worldScaleBoxUVs, textTexture } from '../../core/toon.js';
import { NavGrid } from './nav.js';

/*
  "Kiln" — a compact 5v5 arena, point-symmetric about the origin so both teams get the same map.
  Allies (sky) spawn west, enemies (clay) east. Every feature in #half() is built once as written
  and once rotated 180° onto the other side.

        z = -31 ┌──────────────────────────────────────────────────────────────┐
                │ SPAWN W   crates     ║ GALLERY (wallrun wall) ║    BUILDING E│
                │                      pillars         pillars      ramp  ▲    │
     allies ──► │ shield  low wall       ┌── PLINTH ──┐          low wall      │ ◄── enemies
                │                      pillars    monolith  pillars            │
                │ ▼ ramp  BUILDING W   ║ GALLERY (wallrun wall) ║   crates     │
        z = +31 └──────────────────────────────────────────────────────────────┘
               x = -45                                                  x = +45

  Movement first: the gallery walls are wallrun lanes, the buildings are mantle/ramp high ground,
  the plinth is the contested centre, and pillars chain wallruns across mid. No spawn-to-spawn
  sightline: the plinth and monolith break the long axis.
*/

const W = 45, D = 31;
const GRID = gridTexture();
const mats = new Map();
const mat = (color, grid = true) => {
  const key = `${color}-${grid}`;
  if (!mats.has(key)) mats.set(key, toon(color, { map: grid ? GRID : null, rim: 0.12 }));
  return mats.get(key);
};
const TEAM = { ally: P.sky, enemy: P.clay };

export class Arena {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.colliders = new THREE.Group();
    this.group.add(this.colliders);
    scene.add(this.group);

    this.#atmosphere();
    this.#ground();
    this.#perimeter();
    this.#centre();
    for (const side of [1, -1]) this.#half(side);
    this.#backdrop();

    this.colliders.updateMatrixWorld(true);
    this.octree = new Octree().fromGraphNode(this.colliders);
    this.raycastTargets = [...this.colliders.children];
    this.nav = new NavGrid(this.octree, { minX: -W, maxX: W, minZ: -D, maxZ: D, cell: 1 });

    // spawn points face into the map; side 1 = allies (west), -1 = enemies (east)
    const spawns = (s) => [-8, -4, 0, 4, 8].flatMap((z) => [
      { position: new THREE.Vector3(-40 * s, 0, z * s), yaw: s > 0 ? -Math.PI / 2 : Math.PI / 2 },
      { position: new THREE.Vector3(-37 * s, 0, z * s + 2 * s), yaw: s > 0 ? -Math.PI / 2 : Math.PI / 2 },
    ]);
    this.spawns = { ally: spawns(1), enemy: spawns(-1) };

    // named areas bots use as roam objectives
    this.hotspots = [
      [0, 0], [0, -10], [0, 10], [-12, -24], [12, 24], [-18, 18], [18, -18],
      [-12, 0], [12, 0], [-26, -16], [26, 16], [-24, 8], [24, -8],
    ].map(([x, z]) => new THREE.Vector3(x, 0, z));
  }

  dispose() { this.scene.remove(this.group); }

  // ── builders (side flips x and z for the mirrored copy) ──

  block(x, base, z, w, h, d, color, { grid = true, collide = true, side = 1 } = {}) {
    const geo = worldScaleBoxUVs(new THREE.BoxGeometry(w, h, d), w, h, d);
    const mesh = new THREE.Mesh(geo, mat(color, grid));
    mesh.position.set(x * side, base + h / 2, z * side);
    mesh.castShadow = mesh.receiveShadow = true;
    (collide ? this.colliders : this.group).add(mesh);
    return mesh;
  }

  /** Slab along z whose top rises from 0 at zLow to `rise` at zHigh (plus a base height). */
  ramp(x, zLow, zHigh, width, rise, color, { side = 1, base = 0 } = {}) {
    const run = Math.abs(zHigh - zLow), len = Math.hypot(run, rise), t = 0.6;
    const angle = Math.atan2(rise, run);
    const geo = worldScaleBoxUVs(new THREE.BoxGeometry(width, t, len), width, t, len);
    const mesh = new THREE.Mesh(geo, mat(color));
    const up = (zHigh < zLow) === (side > 0);
    mesh.rotation.x = up ? angle : -angle;
    mesh.position.set(x * side, base + rise / 2 - (t / 2) * Math.cos(angle), ((zLow + zHigh) / 2) * side);
    mesh.castShadow = mesh.receiveShadow = true;
    this.colliders.add(mesh);
    return mesh;
  }

  /** Ramp running along x (rises from xLow to xHigh). */
  rampX(z, xLow, xHigh, width, rise, color, { side = 1, base = 0 } = {}) {
    const run = Math.abs(xHigh - xLow), len = Math.hypot(run, rise), t = 0.6;
    const angle = Math.atan2(rise, run);
    const geo = worldScaleBoxUVs(new THREE.BoxGeometry(len, t, width), len, t, width);
    const mesh = new THREE.Mesh(geo, mat(color));
    const up = (xHigh > xLow) === (side > 0);
    mesh.rotation.z = up ? angle : -angle;
    mesh.position.set(((xLow + xHigh) / 2) * side, base + rise / 2 - (t / 2) * Math.cos(angle), z * side);
    mesh.castShadow = mesh.receiveShadow = true;
    this.colliders.add(mesh);
    return mesh;
  }

  paint(x, z, w, d, color, side = 1, geo = new THREE.PlaneGeometry(w, d)) {
    const m = new THREE.Mesh(geo, toon(color, { rim: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(x * side, 0.01, z * side);
    m.receiveShadow = true;
    this.group.add(m);
    return m;
  }

  sign(x, z, rotY, index, title, color) {
    const tex = textTexture(
      [{ text: index, font: '600 64px "JetBrains Mono", monospace', color: '#d97757' }, { text: title, font: 'italic 600 128px "Source Serif 4", serif' }],
      { width: 1024, height: 320, accent: color },
    );
    const board = new THREE.Mesh(new THREE.PlaneGeometry(4, 1.25), new THREE.MeshBasicMaterial({ map: tex }));
    board.position.set(x, 1.45, z);
    board.rotation.y = rotY;
    this.group.add(board);
  }

  // ── layout ──

  #atmosphere() {
    const s = this.scene;
    s.background = new THREE.Color(P.pampas);
    s.fog = new THREE.Fog(P.pampas, 60, 200);
    s.add(new THREE.HemisphereLight(0xfffaf0, P.kraft, 1.25));
    const sun = new THREE.DirectionalLight(0xfff4e6, 2.4);
    sun.position.set(-40, 90, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera;
    c.left = c.bottom = -60;
    c.right = c.top = 60;
    c.near = 10;
    c.far = 220;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    s.add(sun, sun.target);
  }

  #ground() {
    const size = 200;
    const geo = new THREE.PlaneGeometry(size, size);
    geo.rotateX(-Math.PI / 2);
    geo.attributes.uv.array.forEach((v, i, a) => (a[i] = v * (size / 4)));
    const ground = new THREE.Mesh(geo, mat(P.oat));
    ground.receiveShadow = true;
    this.colliders.add(ground);

    // centre circle and lane lines (paint only)
    const ring = new THREE.RingGeometry(9.2, 9.6, 64);
    this.paint(0, 0, 0, 0, P.ink, 1, ring);
    for (const s of [1, -1]) {
      this.paint(-30, 0, 0.3, 26, s > 0 ? TEAM.ally : TEAM.enemy, s); // spawn line
      this.paint(-40, 0, 7, 22, P.ivory, s);
      this.paint(-40, 0, 0.25, 22, s > 0 ? TEAM.ally : TEAM.enemy, s);
    }
  }

  #perimeter() {
    const H = 7, T = 1.2;
    this.block(0, 0, -D - T / 2, 2 * W + 2 * T, H, T, P.slate);
    this.block(0, 0, D + T / 2, 2 * W + 2 * T, H, T, P.slate);
    this.block(-W - T / 2, 0, 0, T, H, 2 * D, P.slate);
    this.block(W + T / 2, 0, 0, T, H, 2 * D, P.slate);
    // cap trim
    this.block(0, H, -D - T / 2, 2 * W + 2 * T, 0.25, T + 0.2, P.ink, { grid: false });
    this.block(0, H, D + T / 2, 2 * W + 2 * T, 0.25, T + 0.2, P.ink, { grid: false });
  }

  #centre() {
    // the plinth: 2.4 m high, ramps north and south (point-symmetric), parapets east/west
    const PH = 2.4;
    this.block(0, 0, 0, 14, PH, 12, P.ivory);
    this.ramp(-4, -15, -6, 4.5, PH, P.manilla);
    this.ramp(-4, -15, -6, 4.5, PH, P.manilla, { side: -1 });
    // parapets with a gap in the middle so you can peek and drop
    for (const s of [1, -1]) {
      this.block(-6.6, PH, -3.6, 0.6, 1.1, 4.4, P.kraft, { side: s });
      this.block(-6.6, PH, 3.8, 0.6, 1.1, 4, P.kraft, { side: s });
    }
    // monolith breaks the long axis and anchors the centre
    this.block(1.5, PH, 0, 2.2, 6, 2.2, P.clay);
    this.block(1.5, PH + 6, 0, 2.5, 0.3, 2.5, P.ink, { grid: false });
  }

  /** One team's half; side = 1 builds the west half, -1 the rotated east copy. */
  #half(side) {
    const o = { side };
    const team = side > 0 ? TEAM.ally : TEAM.enemy;

    // spawn: back room shielded by a broken wall with three exits
    this.block(-31, 0, -9.5, 1, 2.6, 7, P.ivory, o);
    this.block(-31, 0, 9.5, 1, 2.6, 7, P.ivory, o);
    this.block(-31, 0, 0, 1, 2.6, 4, P.ivory, o);
    this.block(-31, 2.6, 0, 1.2, 0.2, 26, team, { ...o, grid: false });
    this.block(-43, 0, -16, 4, 4, 3, P.slate, o);
    this.block(-43, 0, 16, 4, 4, 3, P.slate, o);

    // north gallery: long wallrun wall separating the outer lane from mid
    this.block(-15, 0, -17, 16, 5.5, 0.8, P.bookcloth, o);
    this.block(-15, 5.5, -17, 16.2, 0.2, 1, P.ink, { ...o, grid: false });
    this.block(-20, 0, -24.5, 2.4, 1.2, 2.4, P.kraft, o);
    this.block(-9, 0, -26, 3.2, 1.1, 1.4, P.kraft, o);
    this.block(-3, 0, -22.5, 1.6, 2.2, 1.6, P.kraft, o);
    this.block(-27, 0, -24, 3, 2.2, 3, P.sage, o); // crate stack you mantle onto
    this.block(-27, 0, -20.5, 2, 1.1, 2, P.sage, o);

    // south building: 3.2 m roof, ramp up the back, mantle steps at the front
    this.block(-19, 0, 21, 10, 3.2, 8, P.manilla, o);
    this.block(-19, 3.2, 24.8, 10, 1.1, 0.4, P.kraft, o); // roof lip, cover toward the back wall
    this.rampX(23, -33, -24, 3, 3.2, P.sky, o);
    this.block(-16, 0, 15.6, 2.6, 1.5, 2.6, P.sage, o);
    this.block(-10, 0, 21, 2, 1.1, 3, P.kraft, o);

    // mid flanks: pillars to chain wallruns, low walls to crouch behind
    for (const [x, z] of [[-9, -10], [-9, 10], [-17, -6]]) {
      this.block(x, 0, z, 1.8, 6, 1.8, P.sky, o);
      this.block(x, 6, z, 2, 0.2, 2, P.ink, { ...o, grid: false });
    }
    this.block(-14, 0, 1, 0.8, 1.15, 6, P.ivory, o);
    this.block(-23, 0, -9, 4, 1.15, 0.8, P.ivory, o);
    this.block(-23, 0, 9, 3, 1.6, 3, P.kraft, o);

    this.sign(-31.52 * side, 0, side > 0 ? -Math.PI / 2 : Math.PI / 2, side > 0 ? 'ALLIES' : 'ENEMY', side > 0 ? 'West gate' : 'East gate', side > 0 ? '#9fb4c7' : '#d97757');
  }

  #backdrop() {
    let seed = 11;
    const rng = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2, r = 120 + rng() * 40, h = 18 + rng() * 40, w = 10 + rng() * 16;
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), toon(i % 3 ? P.oat : P.kraft, { rim: 0 }));
      m.position.set(Math.cos(a) * r, h / 2, Math.sin(a) * r);
      m.rotation.y = rng() * Math.PI;
      this.group.add(m);
    }
  }
}
