import * as THREE from 'three';
import { doorLeaf, doorLeaves, doorTint } from './assets.js';

/*
  Working doors. mapWorld finds every ground-level doorway (walls report theirs, a placed 'door' piece is
  one too) and hands the list here; each gets its leaf, or a pair for a double gate, hinged at the frame.
    · E opens or closes the door you're facing; it swings away from you (OPEN rad, eased over ~0.35 s)
    · they're solid: attach(octree) adds each leaf's box to the octree's triangle queries, so movement,
      bullets and grenades all meet doors, open or shut, wherever they are mid-swing
    · bots in TDM push the doors they walk into open
    · online, onToggle(id, open, dir) goes to the server and set() plays other players' doors
  Door ids ('o<n>') follow the map's piece order, so every client names a door the same.
*/

const OPEN = 1.62;
const REACH = 2.3; // how far you can reach a door from (eye to its middle)
const _v = new THREE.Vector3(), _d = new THREE.Vector3(), _box = new THREE.Box3(), _m = new THREE.Matrix4();

class Door {
  constructor(id, { x, y, z, yaw, way }, parent) {
    Object.assign(this, { id, open: false, dir: 1, angle: 0, target: 0 });
    this.root = new THREE.Group();
    this.root.position.set(x, y, z);
    this.root.rotation.y = yaw;
    parent.add(this.root);
    const tint = doorTint(x, z);
    this.leaves = doorLeaves(way).map((l) => {
      const pivot = new THREE.Group();
      pivot.position.x = l.x;
      pivot.add(doorLeaf(l.w, l.h, tint, l.flip));
      this.root.add(pivot);
      // collision: a box a little thicker than the leaf, in the pivot's frame
      const solid = new THREE.BoxGeometry(l.w - 0.04, l.h, 0.16).translate((l.flip ? -1 : 1) * l.w / 2, l.h / 2, 0).toNonIndexed();
      return { ...l, pivot, solid, tris: [], box: new THREE.Box3() };
    });
    this.root.updateWorldMatrix(true, false);
    this.centre = new THREE.Vector3((way.x0 + way.x1) / 2, 1.1, 0).applyMatrix4(this.root.matrixWorld);
    this.#pose();
  }

  /** Open (or shut) away from `dir` (+1: the side the wall's +Z faces is pushed from). */
  set(open, dir = this.dir, instant = false) {
    this.open = open;
    this.dir = dir;
    this.target = open ? dir * OPEN : 0;
    if (instant) { this.angle = this.target; this.#pose(); }
  }

  update(dt) {
    if (this.angle === this.target) return false;
    const k = 1 - Math.exp(-11 * dt);
    this.angle += (this.target - this.angle) * k;
    if (Math.abs(this.target - this.angle) < 0.002) this.angle = this.target;
    this.#pose();
    return true;
  }

  #pose() {
    for (const l of this.leaves) {
      // a flipped leaf hangs on the other jamb, so it turns the other way to swing to the same side
      l.pivot.rotation.y = l.flip ? -this.angle : this.angle;
      l.pivot.updateMatrixWorld(true);
      const pos = l.solid.attributes.position;
      l.tris.length = 0;
      for (let i = 0; i < pos.count; i += 3) {
        l.tris.push(new THREE.Triangle(
          new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(l.pivot.matrixWorld),
          new THREE.Vector3().fromBufferAttribute(pos, i + 1).applyMatrix4(l.pivot.matrixWorld),
          new THREE.Vector3().fromBufferAttribute(pos, i + 2).applyMatrix4(l.pivot.matrixWorld),
        ));
      }
      l.box.setFromPoints(l.tris.flatMap((t) => [t.a, t.b, t.c]));
    }
  }

  /** Which way a push from world point `p` swings it: away from p. */
  dirFrom(p) {
    _m.copy(this.root.matrixWorld).invert();
    return _v.copy(p).applyMatrix4(_m).z >= 0 ? 1 : -1;
  }
}

export class Doors {
  /** spots: [{ x, y, z, yaw, way: { x0, x1, h } }] in world space. */
  constructor(parent, spots) {
    this.group = new THREE.Group();
    parent.add(this.group);
    this.list = spots.map((s, i) => new Door(`o${i}`, s, this.group));
    this.byId = new Map(this.list.map((d) => [d.id, d]));
    this.onToggle = null;
    this.audio = null;
    this.camera = null;
  }

  /** Make the doors solid for everything that asks this octree for triangles. */
  attach(octree) {
    if (!this.list.length || octree.doors === this) return;
    octree.doors = this;
    const leaves = this.list.flatMap((d) => d.leaves);
    for (const [name, hits] of [
      ['getCapsuleTriangles', (c, b) => b.intersectsBox(_box.makeEmpty().expandByPoint(c.start).expandByPoint(c.end).expandByScalar(c.radius))],
      ['getSphereTriangles', (s, b) => b.intersectsSphere(s)],
      ['getRayTriangles', (r, b) => r.intersectsBox(b)],
    ]) {
      const base = octree[name].bind(octree);
      octree[name] = (shape, triangles) => {
        base(shape, triangles);
        for (const l of leaves) if (hits(shape, l.box)) triangles.push(...l.tris);
        return triangles;
      };
    }
  }

  /** The door you'd open from `eye` looking along `dir`: in reach and roughly in front. */
  facing(eye, dir) {
    let best = null, bestScore = -Infinity;
    for (const d of this.list) {
      _d.subVectors(d.centre, eye);
      const dist = _d.length();
      if (dist > REACH) continue;
      const score = _d.normalize().dot(dir) - dist * 0.1;
      if (score > 0.55 && score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  }

  /** Our own push: swing it away from `from`, and tell the server. */
  toggle(door, from) {
    const open = !door.open, dir = open ? door.dirFrom(from) : door.dir;
    door.set(open, dir);
    this.#sound(door, open);
    this.onToggle?.(door.id, open, dir);
  }

  /** Someone else's door (online), or the state at join (instant). */
  set(id, open, dir, instant = false) {
    const door = this.byId.get(id);
    if (!door || (door.open === open && door.dir === dir)) return;
    door.set(open, dir, instant);
    if (!instant) this.#sound(door, open);
  }

  /** All shut (a new round). */
  reset() { for (const d of this.list) d.set(false, d.dir, true); }

  /** actors: things that walk through doors on their own (bots), { pos, alive }. */
  update(dt, actors = []) {
    for (const d of this.list) {
      d.update(dt);
      if (d.open) continue;
      for (const a of actors) {
        // pushed from ~2.3 m out: a door takes ~0.35 s to swing, a running bot shouldn't reach it still closed
        if (!a.alive || a.pos.distanceToSquared(_v.copy(d.centre).setY(a.pos.y)) > 5.3) continue;
        d.set(true, d.dirFrom(a.pos));
        this.#sound(d, true);
        break;
      }
    }
  }

  dispose() { this.group.removeFromParent(); }

  #sound(door, open) {
    if (!this.audio || !this.camera) return;
    const dist = door.centre.distanceTo(this.camera.position);
    const vol = Math.max(0, 1 - dist / 30) ** 1.5;
    if (vol < 0.02) return;
    this.audio.play('cloth', { volume: 0.5 * vol, rate: open ? 0.55 : 0.7 });
    this.audio.play(open ? 'boltBack' : 'magSeat', { volume: 0.35 * vol, rate: open ? 0.45 : 0.6 });
  }
}
