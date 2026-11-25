import * as THREE from 'three';
import { PALETTE as P, toon } from '../core/toon.js';
import { FX_LAYER } from '../core/renderer.js';

const MAX_HEALTH = 150;
const REGEN_DELAY = 3;
const RESPAWN_TIME = 2.4;

const G = {
  base: new THREE.CylinderGeometry(0.42, 0.48, 0.08, 24),
  post: new THREE.CylinderGeometry(0.05, 0.06, 0.78, 10),
  pelvis: new THREE.CapsuleGeometry(0.17, 0.12, 4, 12),
  torso: new THREE.CapsuleGeometry(0.25, 0.42, 6, 16),
  arm: new THREE.CapsuleGeometry(0.075, 0.5, 4, 10),
  head: new THREE.SphereGeometry(0.17, 20, 14),
  visor: new THREE.BoxGeometry(0.26, 0.07, 0.12),
  ring: new THREE.RingGeometry(0.1, 0.15, 32),
  dot: new THREE.CircleGeometry(0.045, 20),
  bar: new THREE.PlaneGeometry(1, 1),
};

/** Stylized range target. Faces +Z. Hit zones: 'head' | 'body'. */
class Dummy {
  constructor(spot) {
    this.spot = spot;
    this.health = MAX_HEALTH;
    this.lastHit = -99;
    this.dead = false;
    this.deadTimer = 0;
    this.fall = 0;
    this.time = Math.random() * 10;
    this.flash = 0;
    this.wobble = new THREE.Vector2();
    this.wobbleVel = new THREE.Vector2();
    this.strafeTarget = 0;
    this.strafeX = 0;
    this.strafeVel = 0;
    this.repick = 0;

    const mats = (this.mats = {
      shell: toon(P.ivory, { rim: 0.25 }),
      dark: toon(P.slate, { rim: 0.15 }),
      accent: toon(P.clay, { rim: 0.2 }),
    });

    this.root = new THREE.Group();
    this.root.position.fromArray(spot.pos);
    this.origin = this.root.position.clone();

    const base = new THREE.Mesh(G.base, mats.dark);
    base.position.y = 0.04;
    this.root.add(base);

    // hinge at the base so knockdowns pivot like a range target
    this.hinge = new THREE.Group();
    this.hinge.position.y = 0.08;
    this.root.add(this.hinge);

    const add = (geo, mat, x, y, z, zone, rot) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      if (rot) m.rotation.set(...rot);
      m.castShadow = true;
      m.userData = { dummy: this, zone };
      this.hinge.add(m);
      return m;
    };
    add(G.post, mats.dark, 0, 0.39, 0, 'body');
    add(G.pelvis, mats.dark, 0, 0.88, 0, 'body', [0, 0, Math.PI / 2]).scale.set(1, 1.2, 0.8);
    add(G.torso, mats.shell, 0, 1.28, 0, 'body').scale.set(1.05, 1, 0.72);
    add(G.arm, mats.shell, -0.36, 1.2, 0, 'body', [0, 0, -0.18]);
    add(G.arm, mats.shell, 0.36, 1.2, 0, 'body', [0, 0, 0.18]);
    add(G.head, mats.shell, 0, 1.75, 0, 'head');
    add(G.visor, mats.accent, 0, 1.77, 0.11, 'head');
    const ring = add(G.ring, mats.accent, 0, 1.34, 0.185, 'body');
    ring.castShadow = false;
    const dot = add(G.dot, mats.dark, 0, 1.34, 0.186, 'body');
    dot.castShadow = false;
    this.hitboxes = this.hinge.children.filter((c) => c.userData.zone);

    // health bar (billboarded, no outline)
    this.bar = new THREE.Group();
    this.bar.position.y = 2.25;
    const bg = new THREE.Mesh(G.bar, new THREE.MeshBasicMaterial({ color: P.ink, fog: false }));
    bg.scale.set(0.9, 0.11, 1);
    this.fill = new THREE.Mesh(G.bar, new THREE.MeshBasicMaterial({ color: P.ivory, fog: false }));
    this.fill.position.z = 0.002;
    this.ghost = new THREE.Mesh(G.bar, new THREE.MeshBasicMaterial({ color: P.clay, fog: false }));
    this.ghost.position.z = 0.001;
    this.ghostFrac = 1;
    this.bar.add(bg, this.ghost, this.fill);
    for (let i = 1; i < 6; i++) {
      const tick = new THREE.Mesh(G.bar, new THREE.MeshBasicMaterial({ color: P.ink, fog: false }));
      tick.scale.set(0.012, 0.075, 1);
      tick.position.set(-0.42 + (0.84 * i) / 6, 0, 0.003);
      this.bar.add(tick);
    }
    this.bar.traverse((o) => o.layers.set(FX_LAYER));
    this.root.add(this.bar);
  }

  damage(amount, zone, point, dir, now) {
    if (this.dead) return null;
    this.health = Math.max(0, this.health - amount);
    this.lastHit = now;
    this.flash = 0.07;
    // knock the hinge away from the shot
    const local = dir.clone().applyQuaternion(this.root.quaternion.clone().invert());
    this.wobbleVel.x += local.z * (zone === 'head' ? 3.2 : 2.0);
    this.wobbleVel.y -= local.x * 2.2;
    const killed = this.health <= 0;
    if (killed) { this.dead = true; this.deadTimer = 0; }
    return { killed };
  }

  update(dt, camera, now) {
    this.time += dt;
    const s = this.spot;

    if (!this.dead) {
      if (s.type === 'strafe') this.#strafe(dt);
      else if (s.type === 'orbit') {
        const a = this.time * s.speed;
        this.root.position.set(this.origin.x + Math.cos(a) * s.radius, this.origin.y, this.origin.z + Math.sin(a) * s.radius);
      }
      if (now - this.lastHit > REGEN_DELAY && this.health < MAX_HEALTH) this.health = Math.min(MAX_HEALTH, this.health + 90 * dt);
    }

    // knockdown / respawn
    if (this.dead) {
      this.deadTimer += dt;
      if (this.deadTimer > RESPAWN_TIME) {
        this.fall = Math.max(0, this.fall - dt * 2.2);
        if (this.fall === 0) { this.dead = false; this.health = MAX_HEALTH; this.ghostFrac = 1; }
      } else this.fall = Math.min(1, this.fall + dt * 3.2);
    }
    const fallEase = this.fall < 1 ? 1 - Math.pow(1 - this.fall, 3) : 1;

    // hit wobble (damped spring)
    const k = 160, c = 11;
    this.wobbleVel.x += (-k * this.wobble.x - c * this.wobbleVel.x) * dt;
    this.wobbleVel.y += (-k * this.wobble.y - c * this.wobbleVel.y) * dt;
    this.wobble.addScaledVector(this.wobbleVel, dt);
    this.hinge.rotation.set(this.wobble.x * 0.12 - fallEase * (Math.PI / 2 - 0.08), 0, this.wobble.y * 0.1);

    // flash on hit
    this.flash = Math.max(0, this.flash - dt);
    const e = this.flash > 0 ? 0.55 : 0;
    for (const m of Object.values(this.mats)) m.emissive.setScalar(e);

    // health bar
    const frac = this.health / MAX_HEALTH;
    this.ghostFrac = Math.max(frac, this.ghostFrac - dt * 0.6);
    const show = !this.dead && (now - this.lastHit < 4 || frac < 1);
    this.bar.visible = show;
    if (show) {
      this.fill.scale.set(0.84 * frac, 0.07, 1);
      this.fill.position.x = -0.42 + 0.42 * frac;
      this.ghost.scale.set(0.84 * this.ghostFrac, 0.07, 1);
      this.ghost.position.x = -0.42 + 0.42 * this.ghostFrac;
      this.bar.quaternion.copy(camera.quaternion);
    }
  }

  /** Apex-style ADAD: accelerate toward random targets, sometimes reversing early. */
  #strafe(dt) {
    const s = this.spot;
    this.repick -= dt;
    if (this.repick <= 0 || Math.abs(this.strafeTarget - this.strafeX) < 0.2) {
      this.strafeTarget = (Math.random() * 2 - 1) * s.range;
      this.repick = s.jitter ? 0.25 + Math.random() * 0.6 : 1.2 + Math.random() * 1.2;
    }
    const want = Math.sign(this.strafeTarget - this.strafeX) * s.speed;
    this.strafeVel += THREE.MathUtils.clamp(want - this.strafeVel, -30 * dt, 30 * dt);
    this.strafeX = THREE.MathUtils.clamp(this.strafeX + this.strafeVel * dt, -s.range, s.range);
    this.root.position.x = this.origin.x + this.strafeX;
  }
}

export class Dummies {
  constructor(scene, spots) {
    this.list = spots.map((s) => new Dummy(s));
    for (const d of this.list) scene.add(d.root);
  }

  get hitboxes() { return this.list.flatMap((d) => d.hitboxes); }

  update(dt, camera, now) { for (const d of this.list) d.update(dt, camera, now); }
}
