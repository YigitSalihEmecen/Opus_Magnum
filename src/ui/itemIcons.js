import * as THREE from 'three';
import { ITEMS } from '../items/items.js';

/**
 * Small coloured three-quarter renders of items as PNG data URLs (HUD chips). The ink outline comes from
 * CSS. Uses a throwaway renderer so the game's context is untouched.
 */
export function itemIcons(ids, size = 96) {
  let r;
  try { r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); } catch { return ids.map(() => ''); }
  r.setSize(size, size, false);
  r.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xfff6ea, 0x6b5a4a, 2));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(1, 2, -1.5);
  scene.add(key);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 20);
  const box = new THREE.Box3(), size3 = new THREE.Vector3(), c = new THREE.Vector3();

  const out = ids.map((id) => {
    const obj = new THREE.Group();
    const m = ITEMS[id].build();
    m.rotation.y = 0.6;
    obj.add(m);
    scene.add(obj);
    obj.updateMatrixWorld(true);
    box.setFromObject(obj);
    box.getCenter(c);
    box.getSize(size3);
    const half = Math.max(size3.x, size3.y, size3.z) * 0.62;
    Object.assign(cam, { left: -half, right: half, top: half, bottom: -half });
    cam.position.copy(c).add(new THREE.Vector3(0.35, 0.45, -1).normalize().multiplyScalar(5));
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
