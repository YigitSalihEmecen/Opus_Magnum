import * as THREE from 'three';
import { PALETTE as P } from '../core/toon.js';

let r = null, scene, cam, rt = null, queue = Promise.resolve();
const box = new THREE.Box3(), part = new THREE.Box3(), size = new THREE.Vector3(), c = new THREE.Vector3();

/**
 * Flat ink side-view silhouettes of gun models (attachments included), barrel to the right: resolves to PNG data
 * URLs. Drawn on a small renderer of its own (made once and kept: a new WebGL context beside the game's stalls a
 * frame for 100 ms+), into an offscreen target at twice the size, read back asynchronously (a plain read-back
 * waits for the GPU and freezes the game) and scaled down on a 2D canvas, which smooths the edges.
 * Calls run one after another.
 */
export function silhouettes(models, w = 360, h = 120) {
  const job = queue.then(() => draw(models, w, h));
  queue = job.catch(() => {});
  return job;
}

async function draw(models, w, h) {
  if (!r) {
    try { r = new THREE.WebGLRenderer({ alpha: true }); } catch { return models.map(() => ''); }
    scene = new THREE.Scene();
    scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: P.ink });
    cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
  }
  const W = w * 2, H = h * 2;
  if (!rt || rt.width !== W || rt.height !== H) {
    rt?.dispose();
    rt = new THREE.WebGLRenderTarget(W, H);
    rt.texture.colorSpace = THREE.SRGBColorSpace;
  }
  const big = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const out = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const bctx = big.getContext('2d'), octx = out.getContext('2d');
  const px = new Uint8Array(W * H * 4), img = new ImageData(W, H);
  const urls = [];
  for (const model of models) {
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
    r.setRenderTarget(rt);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.render(scene, cam);
    r.setRenderTarget(null);
    scene.remove(obj);
    await r.readRenderTargetPixelsAsync(rt, 0, 0, W, H, px);
    for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4); // GL rows run bottom-up
    bctx.putImageData(img, 0, 0);
    octx.clearRect(0, 0, w, h);
    octx.drawImage(big, 0, 0, w, h);
    urls.push(out.toDataURL());
  }
  return urls;
}
