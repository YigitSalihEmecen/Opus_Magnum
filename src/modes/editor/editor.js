import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PALETTE as P, toon } from '../../core/toon.js';
import { ASSETS, CATEGORIES, assetById, buildPiece, buildJoints, makeContext } from './assets.js';
import { listMaps, getMap, saveMap, deleteMap, hasSpawns } from './storage.js';
import { MAP_SIZE } from './mapWorld.js';
import { terrainMesh, setHeights, heightsOf, packHeights, heightAt, brush } from './terrain.js';
import { applySky } from '../../world/sky.js';
import './editor.css';

/*
  Map editor. Orbit camera over a 1 m grid; pick a piece on the left, click to place (it stays armed
  for repeated placement), click a piece to select it, drag to move, edit it on the right. The Terrain
  tab sculpts the ground with brushes. Connectors (wall pillars, fence posts) and adaptive tiles (roads,
  sidewalks) are rebuilt after every change, so assemblies stay seamless.
  Maps save to localStorage (storage.js) and show up on the title screen's map list.

  Level interface for main.js: { frame(dt) } — the editor owns the frame (no player, no HUD).
*/

const HEX = (c) => `#${c.toString(16).padStart(6, '0')}`;
const _ndc = new THREE.Vector2();
const _ray = new THREE.Raycaster();
const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _v = new THREE.Vector3();
const BRUSHES = [
  { id: 'raise', name: 'Raise', note: 'build hills' },
  { id: 'lower', name: 'Lower', note: 'dig dips' },
  { id: 'smooth', name: 'Smooth', note: 'soften' },
  { id: 'flatten', name: 'Flatten', note: 'level a pad' },
];

export function createEditor(ctx) { return new Editor(ctx); }

class Editor {
  constructor({ renderer, scene, canvas, onExit }) {
    Object.assign(this, { renderer, scene, canvas, onExit });
    this.camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 600);
    this.camera.position.set(16, 20, 26);
    this.vmScene = new THREE.Scene();
    this.vmCamera = new THREE.PerspectiveCamera();

    this.controls = new OrbitControls(this.camera, canvas);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.12, minDistance: 5, maxDistance: 150, maxPolarAngle: 1.48, screenSpacePanning: false, zoomSpeed: 1.2 });
    this.controls.mouseButtons = { LEFT: -1, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };

    this.size = MAP_SIZE;
    this.h = heightsOf({}, this.size);
    this.#world();
    this.pieces = new THREE.Group();
    this.joints = new THREE.Group();
    scene.add(this.pieces, this.joints);
    this.objects = new Map(); // record → Object3D

    this.map = { id: null, name: 'Untitled map', size: MAP_SIZE, pieces: [] };
    this.snap = 1;
    this.tool = null; // { asset, rot, color }
    this.brush = null; // { mode, radius, strength }
    this.ghost = null;
    this.selected = null;
    this.drag = null;
    this.paint = null;
    this.keys = new Set();
    this.history = [];
    this.future = [];
    this.dirty = false;
    this.groundAt = (x, z) => heightAt(this.h, this.size, x, z);

    this.ui = new EditorUI(this);
    this.#bind();
    this.#commit(false);
  }

  // ── scene ──

  #world() {
    const s = this.scene;
    applySky(s);
    s.fog = new THREE.Fog(P.pampas, 140, 380);
    s.add(new THREE.HemisphereLight(0xfffaf0, P.kraft, 1.3));
    const sun = new THREE.DirectionalLight(0xfff4e6, 2.3);
    sun.position.set(-45, 90, 35);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -110, bottom: -110, right: 110, top: 110, near: 10, far: 300 });
    sun.shadow.mapSize.set(4096, 4096);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    s.add(sun, sun.target);

    this.bounds = new THREE.Group();
    s.add(this.bounds);
    this.#sizeTo(this.size);

    this.selBox = new THREE.BoxHelper(undefined, P.clay);
    this.selBox.visible = false;
    s.add(this.selBox);
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.96, 1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: P.clay, depthTest: false, transparent: true }));
    this.ring.renderOrder = 5;
    this.ring.visible = false;
    s.add(this.ring);
  }

  get half() { return this.size / 2; }

  /** Ground, apron and boundary line for a size × size map. */
  #sizeTo(size) {
    this.size = size;
    this.bounds.clear();
    this.ground = terrainMesh(size);
    setHeights(this.ground, this.h);
    this.bounds.add(this.ground);
    const half = size / 2;
    const outside = new THREE.Mesh(new THREE.RingGeometry(half * 1.42, 600, 4, 1).rotateX(-Math.PI / 2).rotateY(Math.PI / 4), toon(P.manilla, { rim: 0 }));
    outside.position.y = -0.06;
    const edge = new THREE.Mesh(new THREE.RingGeometry(half * Math.SQRT2 - 0.01, half * Math.SQRT2 + 0.35, 4, 1).rotateX(-Math.PI / 2).rotateY(Math.PI / 4), new THREE.MeshBasicMaterial({ color: P.clay }));
    edge.position.y = -0.04;
    this.bounds.add(outside, edge);
    this.controls.maxDistance = size * 1.6;
  }

  // ── map state ──

  #ctx() { return (this._ctx ??= makeContext(this.map.pieces, this.groundAt)); }

  #add(rec) {
    const obj = buildPiece(rec, this.#ctx()(rec), { compact: true });
    obj.userData.rec = rec;
    this.pieces.add(obj);
    this.objects.set(rec, obj);
    return obj;
  }

  #rebuild(rec) {
    this.objects.get(rec)?.removeFromParent();
    this.objects.delete(rec);
    this.#add(rec);
    if (this.selected === rec) this.selBox.setFromObject(this.objects.get(rec));
  }

  /** Recompute everything that depends on neighbours: adaptive tiles, floors and walls, and connectors. */
  #refresh() {
    this._ctx = null;
    // adaptive tiles, plus floors and walls (slab edges and wall feet adapt to each other)
    for (const r of this.map.pieces) { const as = assetById(r.type); if (as?.tile || r.type === 'floor' || as?.link?.kind === 'wall') this.#rebuild(r); }
    this.joints.clear();
    const j = buildJoints(this.map.pieces, this.groundAt);
    if (j.children.length) this.joints.add(...j.children);
  }

  #snapshot() { return JSON.stringify({ pieces: this.map.pieces, terrain: packHeights(this.h) }); }

  /** Push an undo snapshot after any finished change. */
  #commit(dirty = true) {
    this.history.push(this.#snapshot());
    if (this.history.length > 80) this.history.shift();
    this.future.length = 0;
    if (dirty) this.dirty = true;
    this.ui.status();
  }

  #restore(json) {
    const snap = JSON.parse(json);
    for (const o of this.objects.values()) o.removeFromParent();
    this.objects.clear();
    this.map.pieces = snap.pieces;
    this.h = heightsOf({ terrain: snap.terrain }, this.size);
    if (this.ground.geometry.attributes.position.count !== this.h.length) this.#sizeTo(this.size);
    setHeights(this.ground, this.h);
    this._ctx = null;
    for (const r of this.map.pieces) this.#add(r);
    this.#refresh();
    this.#select(null);
    this.ui.status();
  }

  undo() {
    if (this.history.length < 2) return;
    this.future.push(this.history.pop());
    this.#restore(this.history.at(-1));
    this.dirty = true;
    this.ui.status();
  }

  redo() {
    const s = this.future.pop();
    if (!s) return;
    this.history.push(s);
    this.#restore(s);
    this.dirty = true;
    this.ui.status();
  }

  load(map) {
    this.map = { size: MAP_SIZE, ...structuredClone(map) };
    if (this.map.size !== this.size) { this.h = heightsOf(this.map, this.map.size); this.#sizeTo(this.map.size); }
    if (map.builtin) { this.map.id = null; this.map.name = `${map.name} copy`; delete this.map.builtin; }
    this.#restore(JSON.stringify({ pieces: this.map.pieces, terrain: map.terrain }));
    this.history = [this.#snapshot()];
    this.future = [];
    this.dirty = !!map.builtin;
    this.ui.mapLoaded();
  }

  newMap() { this.load({ id: null, name: 'Untitled map', size: MAP_SIZE, pieces: [] }); }

  save() {
    if (!this.map.name.trim()) this.map.name = 'Untitled map';
    const saved = saveMap({ id: this.map.id, name: this.map.name.trim(), size: this.map.size, pieces: this.map.pieces, terrain: packHeights(this.h) });
    if (!saved) { this.ui.flash('Could not save — browser storage is full or unavailable'); return; }
    this.map.id = saved.id;
    this.dirty = false;
    this.ui.status();
    this.ui.flash(`Saved “${saved.name}”`);
  }

  exit() {
    if (this.dirty && !confirm('Leave the editor? Unsaved changes will be lost.')) return;
    this.onExit();
  }

  // ── tools ──

  arm(asset) {
    if (this.tool?.asset === asset) { this.disarm(); return; }
    this.#select(null);
    this.brush = null;
    this.ring.visible = false;
    this.ui.brushed(null);
    this.tool = { asset, rot: this.tool?.rot ?? 0, color: asset.colors[0] };
    this.ghost?.removeFromParent();
    this.ghost = buildPiece({ type: asset.id, x: 0, y: 0, z: 0, rot: this.tool.rot, color: this.tool.color });
    const gm = new THREE.MeshBasicMaterial({ color: P.clay, transparent: true, opacity: 0.42, depthWrite: false });
    this.ghost.traverse((o) => { if (o.isMesh) { o.material = gm; o.castShadow = false; if (o.userData.collider) o.visible = false; } });
    this.ghost.visible = false;
    this.scene.add(this.ghost);
    this.ui.armed(asset);
  }

  disarm() {
    this.tool = null;
    this.ghost?.removeFromParent();
    this.ghost = null;
    this.ui.armed(null);
  }

  setBrush(mode) {
    this.disarm();
    this.#select(null);
    this.brush = mode ? { mode, radius: this.brush?.radius ?? 6, strength: this.brush?.strength ?? 2.5 } : null;
    this.ring.visible = false;
    this.ui.brushed(this.brush);
  }

  #select(rec) {
    this.selected = rec;
    const obj = rec && this.objects.get(rec);
    this.selBox.visible = !!obj;
    if (obj) this.selBox.setFromObject(obj);
    this.ui.inspect(rec);
  }

  /** Change the selected piece. patch: any of x, y, z, rot, color. */
  edit(patch, commit = true) {
    const rec = this.selected;
    if (!rec) return;
    Object.assign(rec, patch);
    rec.rot = ((Math.round(rec.rot) % 360) + 360) % 360;
    this._ctx = null;
    this.#rebuild(rec);
    this.#refresh();
    this.ui.inspect(rec);
    if (commit) this.#commit();
  }

  rotate(deg) {
    if (this.tool) { this.tool.rot = (((this.tool.rot + deg) % 360) + 360) % 360; this.ghost.rotation.y = this.tool.asset.tile ? 0 : (this.tool.rot * Math.PI) / 180; }
    else if (this.selected) this.edit({ rot: this.selected.rot + deg });
  }

  remove() {
    const rec = this.selected;
    if (!rec) return;
    this.objects.get(rec)?.removeFromParent();
    this.objects.delete(rec);
    this.map.pieces.splice(this.map.pieces.indexOf(rec), 1);
    this.#select(null);
    this.#refresh();
    this.#commit();
  }

  duplicate() {
    const rec = this.selected;
    if (!rec) return;
    const step = assetById(rec.type).tile ?? Math.max(1, this.snap) * 2;
    const copy = { ...rec, x: this.#clampXZ(rec.x + step), z: rec.z };
    this.map.pieces.push(copy);
    this._ctx = null;
    this.#add(copy);
    this.#refresh();
    this.#select(copy);
    this.#commit();
  }

  dropToGround() { if (this.selected) this.edit({ y: Math.round(this.groundAt(this.selected.x, this.selected.z) * 20) / 20 }); }

  setColor(color) {
    if (this.selected) this.edit({ color });
    else if (this.tool) this.tool.color = color;
  }

  // ── input ──

  #pointer(e) {
    _ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    _ray.setFromCamera(_ndc, this.camera);
  }

  #snapFor(asset) { return asset?.tile ?? (asset?.snap && this.snap ? Math.max(asset.snap, this.snap) : this.snap); }
  #snapV(v, step = this.snap) { return step ? Math.round(v / step) * step : Math.round(v * 100) / 100; }
  #clampXZ(v) { return THREE.MathUtils.clamp(v, -this.half, this.half); }
  #groundHit() { return _ray.intersectObject(this.ground, false)[0]?.point ?? null; }

  /** Where a new piece would land: on a roof/floor under the cursor, else on the terrain. */
  #placement(asset) {
    const hits = _ray.intersectObjects(this.pieces.children, true);
    const top = hits.find((h) => h.face && h.face.normal.clone().transformDirection(h.object.matrixWorld).y > 0.7);
    const point = top?.point ?? this.#groundHit();
    if (!point) return null;
    const step = this.#snapFor(asset);
    const x = this.#clampXZ(this.#snapV(point.x, step)), z = this.#clampXZ(this.#snapV(point.z, step));
    const y = top ? top.point.y : this.groundAt(x, z);
    return { x, y: Math.round(y * 20) / 20, z };
  }

  #pick() {
    for (const h of _ray.intersectObjects(this.pieces.children, true)) {
      for (let o = h.object; o; o = o.parent) if (o.userData.rec) return o.userData.rec;
    }
    return null;
  }

  #bind() {
    const c = this.canvas;
    const on = (t, ev, fn) => t.addEventListener(ev, fn);

    on(c, 'pointerdown', (e) => {
      this.#pointer(e);
      this.down = { x: e.clientX, y: e.clientY, button: e.button };
      if (e.button !== 0 || this.tool) return;
      if (this.brush) {
        const p = this.#groundHit();
        if (p) this.paint = { target: this.groundAt(p.x, p.z), x: p.x, z: p.z, changed: false };
        return;
      }
      const rec = this.#pick();
      this.#select(rec);
      if (rec) {
        const p = _ray.ray.intersectPlane(_plane.set(_plane.normal, -rec.y), _v);
        const onGround = Math.abs(rec.y - this.groundAt(rec.x, rec.z)) < 0.35;
        this.drag = p ? { rec, dx: rec.x - p.x, dz: rec.z - p.z, moved: false, onGround } : null;
      }
    });

    on(c, 'pointermove', (e) => {
      this.#pointer(e);
      if (this.drag) {
        const { rec } = this.drag;
        const p = _ray.ray.intersectPlane(_plane.set(_plane.normal, -rec.y), _v);
        if (p) {
          const step = this.#snapFor(assetById(rec.type));
          const x = this.#clampXZ(this.#snapV(p.x + this.drag.dx, step)), z = this.#clampXZ(this.#snapV(p.z + this.drag.dz, step));
          if (x !== rec.x || z !== rec.z) {
            const y = this.drag.onGround ? Math.round(this.groundAt(x, z) * 20) / 20 : rec.y;
            this.edit({ x, y, z }, false);
            this.drag.moved = true;
          }
        }
        return;
      }
      if (this.brush) {
        const p = this.#groundHit();
        this.ring.visible = !!p;
        if (p) { this.ring.position.set(p.x, p.y + 0.05, p.z); this.ring.scale.setScalar(this.brush.radius); }
        if (this.paint && p) { this.paint.x = p.x; this.paint.z = p.z; }
        this.ui.cursor(p && { x: p.x, y: p.y, z: p.z });
        return;
      }
      if (this.ghost) {
        const at = this.#placement(this.tool.asset);
        this.ghost.visible = !!at;
        if (at) this.ghost.position.set(at.x, at.y, at.z);
        this.ui.cursor(at);
      } else {
        const p = this.#groundHit();
        this.ui.cursor(p && { x: this.#snapV(p.x), y: p.y, z: this.#snapV(p.z) });
        c.style.cursor = this.#pick() ? 'pointer' : '';
      }
    });

    on(c, 'pointerup', (e) => {
      const d = this.down;
      this.down = null;
      if (this.paint) { if (this.paint.changed) this.#commit(); this.paint = null; return; }
      const click = d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5;
      if (this.drag) { if (this.drag.moved) this.#commit(); this.drag = null; return; }
      if (!click) return;
      if (d.button === 2 && (this.tool || this.brush)) { this.disarm(); this.setBrush(null); return; }
      if (d.button === 0 && this.tool) {
        this.#pointer(e);
        const at = this.#placement(this.tool.asset);
        if (!at) return;
        const rec = { type: this.tool.asset.id, x: at.x, y: at.y, z: at.z, rot: this.tool.rot, color: this.tool.color };
        this.map.pieces.push(rec);
        this._ctx = null;
        this.#add(rec);
        this.#refresh();
        this.#commit();
      }
    });

    on(window, 'keydown', (e) => {
      if (e.target.closest?.('input, textarea, select')) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.code;
      if (mod && k === 'KeyZ') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
      if (mod && k === 'KeyY') { e.preventDefault(); this.redo(); return; }
      if (mod && k === 'KeyS') { e.preventDefault(); this.save(); return; }
      if (mod && k === 'KeyD') { e.preventDefault(); this.duplicate(); return; }
      if (mod) return;
      if (k === 'Escape') { if (this.tool) this.disarm(); else if (this.brush) this.setBrush(null); else this.#select(null); return; }
      if (k === 'KeyR') { this.rotate(e.shiftKey ? -90 : 90); return; }
      if (k === 'KeyQ') { this.rotate(-15); return; }
      if (k === 'KeyE') { this.rotate(15); return; }
      if (k === 'KeyG') { this.dropToGround(); return; }
      if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); this.remove(); return; }
      if (this.brush && (k === 'BracketLeft' || k === 'BracketRight')) { this.brush.radius = THREE.MathUtils.clamp(this.brush.radius + (k === 'BracketRight' ? 1 : -1), 1, 20); this.ui.brushed(this.brush); return; }
      if (this.selected && k === 'PageUp') { this.edit({ y: Math.round((this.selected.y + 0.5) * 20) / 20 }); return; }
      if (this.selected && k === 'PageDown') { this.edit({ y: Math.round((this.selected.y - 0.5) * 20) / 20 }); return; }
      if (this.selected && k.startsWith('Arrow')) {
        e.preventDefault();
        const s = this.#snapFor(assetById(this.selected.type)) || 0.25;
        const [dx, dz] = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] }[k];
        this.edit({ x: this.#clampXZ(this.selected.x + dx), z: this.#clampXZ(this.selected.z + dz) });
        return;
      }
      this.keys.add(k);
    });
    on(window, 'keyup', (e) => this.keys.delete(e.code));
    on(window, 'blur', () => this.keys.clear());
  }

  // ── frame ──

  frame(dt) {
    const k = this.keys;
    const ax = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0), az = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    if (ax || az) {
      const fwd = this.camera.getWorldDirection(_v).setY(0).normalize();
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const speed = this.camera.position.distanceTo(this.controls.target) * 0.9 * dt * (k.has('ShiftLeft') ? 2.2 : 1);
      const move = fwd.multiplyScalar(az * speed).addScaledVector(right, ax * speed);
      this.controls.target.add(move);
      this.camera.position.add(move);
    }
    this.controls.target.x = THREE.MathUtils.clamp(this.controls.target.x, -this.half - 10, this.half + 10);
    this.controls.target.z = THREE.MathUtils.clamp(this.controls.target.z, -this.half - 10, this.half + 10);
    this.controls.update();

    if (this.paint && this.brush) {
      const b = this.brush;
      if (brush(this.h, this.size, { mode: b.mode, x: this.paint.x, z: this.paint.z, radius: b.radius, strength: b.strength, target: this.paint.target }, dt)) {
        setHeights(this.ground, this.h);
        this.paint.changed = true;
        this.paintDirty = true;
      }
    } else if (this.paintDirty) {
      // pieces standing on terrain grow or drop their foundations with the new ground
      this.paintDirty = false;
      this._ctx = null;
      for (const r of this.map.pieces) this.#rebuild(r);
      this.#refresh();
    }

    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (Math.abs(this.camera.aspect - w / h) > 1e-3) { this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
    this.camera.updateMatrixWorld();
    this.renderer.render(this.scene, this.camera, this.vmScene, this.vmCamera, {});
  }
}

// ───────────────────────────── UI ─────────────────────────────

class EditorUI {
  constructor(ed) {
    this.ed = ed;
    const root = (this.root = document.createElement('div'));
    root.className = 'ed';
    root.innerHTML = `
      <header class="ed-top card">
        <div class="ed-brand"><span class="label">Map editor</span><input class="ed-name" maxlength="40" spellcheck="false" aria-label="Map name" /></div>
        <div class="ed-status label"></div>
        <label class="ed-snap"><span class="label">Snap</span>
          <select aria-label="Grid snap"><option value="1">1 m</option><option value="0.5">0.5 m</option><option value="2">2 m</option><option value="4">4 m</option><option value="0">Off</option></select>
        </label>
        <div class="ed-actions">
          <button class="ed-btn" data-a="undo" title="Undo (⌘Z)">↶</button>
          <button class="ed-btn" data-a="redo" title="Redo (⇧⌘Z)">↷</button>
          <button class="ed-btn" data-a="new">New</button>
          <button class="ed-btn" data-a="open">Open</button>
          <button class="ed-btn primary" data-a="save">Save</button>
          <button class="ed-btn" data-a="exit">Exit</button>
        </div>
      </header>
      <aside class="ed-lib card">
        <div class="ed-tabs">${CATEGORIES.map((c, i) => `<button class="${i ? '' : 'on'}" data-cat="${c}">${c}</button>`).join('')}</div>
        <div class="ed-assets"></div>
        <div class="ed-tool label">Pick a piece, then click the grid</div>
      </aside>
      <aside class="ed-insp card" hidden>
        <div class="label ed-insp-kind"></div>
        <h3 class="ed-insp-name"></h3>
        <div class="ed-fields">
          <label><span class="label">X</span><input type="number" data-f="x" step="1" /></label>
          <label><span class="label">Z</span><input type="number" data-f="z" step="1" /></label>
          <label><span class="label">Height</span><input type="number" data-f="y" step="0.5" /></label>
        </div>
        <div class="ed-rot">
          <span class="label">Rotation <b class="ed-rot-val">0°</b></span>
          <div class="ed-rot-row"><button class="ed-btn" data-r="-90">⟲ 90</button><input type="range" min="0" max="345" step="15" /><button class="ed-btn" data-r="90">90 ⟳</button></div>
        </div>
        <div class="ed-colors-wrap"><span class="label">Colour</span><div class="ed-colors"></div></div>
        <div class="ed-insp-actions"><button class="ed-btn" data-a="ground" title="G">To ground</button><button class="ed-btn" data-a="dup">Copy</button><button class="ed-btn danger" data-a="del">Delete</button></div>
      </aside>
      <footer class="ed-help">
        <span><kbd>LMB</kbd> place · select · drag</span><span><kbd>RMB</kbd> orbit</span><span><kbd>⇧ RMB</kbd>/<kbd>MMB</kbd> pan</span>
        <span><kbd>WASD</kbd> move</span><span><kbd>R</kbd> 90°</span><span><kbd>Q</kbd><kbd>E</kbd> 15°</span><span><kbd>G</kbd> to ground</span><span><kbd>Del</kbd> remove</span>
        <span><kbd>⌘D</kbd> duplicate</span><span><kbd>Esc</kbd> drop tool</span><span class="ed-xy"></span>
      </footer>
      <div class="ed-toast card"></div>
      <div class="ed-modal" hidden><section class="card"><div class="ed-modal-head"><h3>Maps</h3><button class="ed-btn" data-a="close">Close</button></div><div class="ed-maplist"></div></section></div>`;
    document.body.appendChild(root);
    const $ = (s) => root.querySelector(s);
    this.$ = $;

    this.name = $('.ed-name');
    this.name.addEventListener('input', () => { ed.map.name = this.name.value; ed.dirty = true; this.status(); });
    $('.ed-snap select').addEventListener('change', (e) => { ed.snap = Number(e.target.value); });
    root.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => this.#action(b.dataset.a)));
    root.querySelectorAll('.ed-tabs button').forEach((b) => b.addEventListener('click', () => this.tab(b.dataset.cat)));
    root.querySelectorAll('.ed-fields input').forEach((inp) => inp.addEventListener('change', () => {
      const v = Number(inp.value);
      if (Number.isFinite(v)) ed.edit({ [inp.dataset.f]: inp.dataset.f === 'y' ? v : THREE.MathUtils.clamp(v, -ed.half, ed.half) });
    }));
    const rot = $('.ed-rot input');
    rot.addEventListener('input', () => ed.edit({ rot: Number(rot.value) }, false));
    rot.addEventListener('change', () => ed.edit({ rot: Number(rot.value) }));
    root.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () => ed.rotate(Number(b.dataset.r))));
    for (const el of root.querySelectorAll('.card, .ed-modal')) el.addEventListener('pointerdown', (e) => e.stopPropagation());

    this.tab(CATEGORIES[0]);
    this.mapLoaded();
    this.#thumbnails();
  }

  #action(a) {
    const ed = this.ed;
    switch (a) {
      case 'undo': ed.undo(); break;
      case 'redo': ed.redo(); break;
      case 'save': ed.save(); break;
      case 'exit': ed.exit(); break;
      case 'new': if (!ed.dirty || confirm('Start a new map? Unsaved changes will be lost.')) ed.newMap(); break;
      case 'open': this.openList(); break;
      case 'close': this.$('.ed-modal').hidden = true; break;
      case 'dup': ed.duplicate(); break;
      case 'del': ed.remove(); break;
      case 'ground': ed.dropToGround(); break;
    }
  }

  tab(cat) {
    this.cat = cat;
    this.root.querySelectorAll('.ed-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.cat === cat));
    const box = this.$('.ed-assets');
    if (cat === 'Terrain') {
      const b = this.ed.brush;
      box.innerHTML = `${BRUSHES.map((t) => `
        <button class="ed-asset ed-brush ${b?.mode === t.id ? 'on' : ''}" data-brush="${t.id}">
          <span class="ed-brush-icon" data-i="${t.id}"></span><b>${t.name}</b><span class="label">${t.note}</span>
        </button>`).join('')}
        <label class="ed-slider"><span class="label">Radius <b class="r-val">${b?.radius ?? 6} m</b></span><input type="range" min="1" max="20" step="1" data-s="radius" value="${b?.radius ?? 6}" /></label>
        <label class="ed-slider"><span class="label">Strength <b class="s-val">${(b?.strength ?? 2.5).toFixed(1)}</b></span><input type="range" min="0.5" max="8" step="0.5" data-s="strength" value="${b?.strength ?? 2.5}" /></label>`;
      box.querySelectorAll('[data-brush]').forEach((el) => el.addEventListener('click', () => this.ed.setBrush(this.ed.brush?.mode === el.dataset.brush ? null : el.dataset.brush)));
      box.querySelectorAll('[data-s]').forEach((el) => el.addEventListener('input', () => {
        if (!this.ed.brush) this.ed.setBrush('raise');
        this.ed.brush[el.dataset.s] = Number(el.value);
        this.brushed(this.ed.brush);
      }));
      return;
    }
    const list = ASSETS.filter((a) => a.cat === cat);
    box.innerHTML = list.map((a) => `
      <button class="ed-asset ${this.ed.tool?.asset === a ? 'on' : ''}" data-id="${a.id}" title="${a.name}">
        <span class="ed-thumb" style="${this.thumbs?.[a.id] ? `background-image:url(${this.thumbs[a.id]})` : ''}"></span>
        <b>${a.name}</b><span class="label">${a.note}</span>
      </button>`).join('');
    box.querySelectorAll('.ed-asset').forEach((b) => b.addEventListener('click', () => this.ed.arm(assetById(b.dataset.id))));
  }

  armed(asset) {
    this.root.querySelectorAll('.ed-asset[data-id]').forEach((b) => b.classList.toggle('on', b.dataset.id === asset?.id));
    this.$('.ed-tool').innerHTML = asset
      ? `Placing <b>${asset.name}</b> · <kbd>R</kbd> rotate · <kbd>Esc</kbd> done`
      : 'Pick a piece, then click the grid';
    this.ed.canvas.style.cursor = asset ? 'crosshair' : '';
  }

  brushed(b) {
    this.root.querySelectorAll('[data-brush]').forEach((el) => el.classList.toggle('on', el.dataset.brush === b?.mode));
    const r = this.$('.r-val'), s = this.$('.s-val');
    if (b && r) { r.textContent = `${b.radius} m`; this.$('[data-s=radius]').value = b.radius; }
    if (b && s) s.textContent = b.strength.toFixed(1);
    if (!this.ed.tool) {
      this.$('.ed-tool').innerHTML = b
        ? `<b>${BRUSHES.find((x) => x.id === b.mode).name}</b> · drag on the ground · <kbd>[</kbd><kbd>]</kbd> size · <kbd>Esc</kbd> done`
        : 'Pick a piece, then click the grid';
      this.ed.canvas.style.cursor = b ? 'crosshair' : '';
    }
  }

  inspect(rec) {
    const box = this.$('.ed-insp');
    box.hidden = !rec;
    if (!rec) return;
    const a = assetById(rec.type);
    this.$('.ed-insp-kind').textContent = `${a.cat} · ${a.note}`;
    this.$('.ed-insp-name').textContent = a.name;
    for (const inp of box.querySelectorAll('.ed-fields input')) {
      if (document.activeElement !== inp) inp.value = rec[inp.dataset.f];
      if (inp.dataset.f !== 'y') inp.step = a.tile ?? (this.ed.snap || 0.25);
    }
    this.$('.ed-rot').hidden = !!a.tile;
    this.$('.ed-rot input').value = rec.rot;
    this.$('.ed-rot-val').textContent = `${rec.rot}°`;
    const colors = this.$('.ed-colors');
    colors.parentElement.hidden = a.fixed;
    colors.innerHTML = a.colors.map((c) => `<button class="ed-sw ${c === rec.color ? 'on' : ''}" style="--c:${HEX(c)}" data-c="${c}" aria-label="Colour ${HEX(c)}"></button>`).join('');
    colors.querySelectorAll('.ed-sw').forEach((b) => b.addEventListener('click', () => this.ed.setColor(Number(b.dataset.c))));
  }

  cursor(at) { this.$('.ed-xy').textContent = at ? `x ${at.x.toFixed(1)} · z ${at.z.toFixed(1)} · h ${at.y.toFixed(2)}` : ''; }

  mapLoaded() {
    this.name.value = this.ed.map.name;
    this.status();
  }

  status() {
    const m = this.ed.map;
    const n = m.pieces.length;
    const tdm = hasSpawns(m) ? 'TDM ready' : 'Add both spawns for TDM';
    this.$('.ed-status').innerHTML = `${n} piece${n === 1 ? '' : 's'} · ${tdm} · <span class="${this.ed.dirty ? 'unsaved' : ''}">${this.ed.dirty ? 'unsaved' : m.id ? 'saved' : 'new'}</span>`;
  }

  flash(text) {
    const t = this.$('.ed-toast');
    t.textContent = text;
    t.classList.remove('show');
    void t.offsetWidth;
    t.classList.add('show');
  }

  openList() {
    const list = this.$('.ed-maplist');
    const maps = listMaps();
    list.innerHTML = maps.length ? maps.map((m) => `
      <div class="ed-maprow" data-id="${m.id}">
        <div><b>${esc(m.name)}</b><span class="label">${m.builtin ? 'Built in · opens as a copy' : `${m.pieces.length} pieces · ${new Date(m.updated).toLocaleString()}`}</span></div>
        <button class="ed-btn primary" data-open>Open</button>${m.builtin ? '<span></span>' : '<button class="ed-btn danger" data-del>Delete</button>'}
      </div>`).join('') : '<p class="ed-empty">No saved maps yet. Build something and press Save.</p>';
    list.querySelectorAll('.ed-maprow').forEach((row) => {
      const id = row.dataset.id;
      row.querySelector('[data-open]').addEventListener('click', () => {
        if (this.ed.dirty && !confirm('Open another map? Unsaved changes will be lost.')) return;
        this.ed.load(getMap(id));
        this.$('.ed-modal').hidden = true;
      });
      row.querySelector('[data-del]')?.addEventListener('click', () => {
        if (!confirm(`Delete “${getMap(id)?.name}”? This can't be undone.`)) return;
        deleteMap(id);
        if (this.ed.map.id === id) { this.ed.map.id = null; this.ed.dirty = true; this.status(); }
        this.openList();
      });
    });
    this.$('.ed-modal').hidden = false;
  }

  /** Small rendered previews for the library, drawn once with a throwaway renderer. */
  #thumbnails() {
    const W = 200, H = 150;
    let r;
    try { r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); } catch { return; }
    r.setSize(W, H);
    r.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xfffaf0, P.kraft, 1.5));
    const sun = new THREE.DirectionalLight(0xfff4e6, 2.2);
    sun.position.set(-3, 6, 4);
    scene.add(sun);
    const cam = new THREE.PerspectiveCamera(30, W / H, 0.05, 200);
    this.thumbs = {};
    const box = new THREE.Box3(), size = new THREE.Vector3(), center = new THREE.Vector3();
    for (const a of ASSETS) {
      const obj = buildPiece({ type: a.id, x: 0, y: 0, z: 0, rot: 0 });
      const hidden = [];
      obj.traverse((o) => { if (o.userData.collider) hidden.push(o); });
      hidden.forEach((o) => o.removeFromParent());
      scene.add(obj);
      box.setFromObject(obj);
      box.getSize(size);
      box.getCenter(center);
      const d = Math.max(size.x, size.y * 1.3, size.z) * 1.9 + 0.6;
      cam.position.set(center.x + d * 0.62, center.y + d * 0.48, center.z + d * 0.62);
      cam.lookAt(center);
      r.render(scene, cam);
      this.thumbs[a.id] = r.domElement.toDataURL();
      scene.remove(obj);
    }
    r.dispose();
    r.forceContextLoss();
    this.tab(this.cat);
  }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
