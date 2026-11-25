import * as THREE from 'three';
import { PALETTE as P } from '../core/toon.js';

/**
 * Flat ink side-view silhouettes of gun models (attachments included) as PNG data URLs, barrel to the right.
 * Uses a throwaway renderer so the game's own context and render targets are untouched.
 */
export function silhouettes(models, w = 360, h = 120) {
  let r;
  try { r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); } catch { return models.map(() => ''); }
  r.setSize(w, h, false);
  const scene = new THREE.Scene();
  scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: P.ink });
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
  const box = new THREE.Box3(), part = new THREE.Box3(), size = new THREE.Vector3(), c = new THREE.Vector3();

  const out = models.map((model) => {
    const obj = model.clone(true);
    obj.position.set(0, 0, 0);
    obj.quaternion.identity();
    scene.add(obj);
    obj.updateMatrixWorld(true);
    // fit to what's actually drawn (the muzzle flash, eyepiece portal and glass are hidden or on the FX layer)
    box.makeEmpty();
    obj.traverseVisible((m) => {
      if (!m.isMesh || !m.layers.test(cam.layers)) return;
      m.geometry.computeBoundingBox();
      box.union(part.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld));
    });
    box.getSize(size);
    box.getCenter(c);
    // camera on +X looking back: -Z (the barrel) lands on screen right
    const pad = 1.08, aspect = w / h;
    const halfW = Math.max(size.z / 2, (size.y / 2) * aspect) * pad;
    Object.assign(cam, { left: -halfW, right: halfW, top: halfW / aspect, bottom: -halfW / aspect });
    cam.position.set(c.x + 2, c.y, c.z);
    cam.lookAt(c);
    cam.updateProjectionMatrix();
    r.render(scene, cam);
    scene.remove(obj);
    return r.domElement.toDataURL();
  });
  r.dispose();
  r.forceContextLoss();
  return out;
}
