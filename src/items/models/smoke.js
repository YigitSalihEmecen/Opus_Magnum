import * as THREE from 'three';
import { ITEM_MATS as M, rbox, cyl, add, glow } from './kit.js';

/*
  Smoke grenade — a straight steel-grey canister with ink rims, a pale band printed round the middle and a row
  of vent holes under the top; the same fuse head, spoon and pull ring as the frag. 11 cm tall. Origin at the
  bottom; parts.pin / parts.spoon come off when it's thrown.
*/

const R = 0.028, TOP = 0.092;

export function buildSmoke() {
  const g = new THREE.Group();
  g.name = 'smoke';
  add(g, cyl(R, 0.004, TOP - 0.004, 24), M.steel);
  for (const y of [0, TOP - 0.006]) add(g, cyl(R + 0.0015, y, y + 0.006, 24), M.ink);
  add(g, cyl(R + 0.001, 0.034, 0.058, 24), glow(0xdcd8cf));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    add(g, new THREE.SphereGeometry(0.0042, 8, 6), M.ink, Math.cos(a) * R, TOP - 0.016, Math.sin(a) * R).scale.set(1, 1, 0.5);
  }
  add(g, cyl(0.012, TOP, TOP + 0.012, 16), M.alloy);

  const spoon = new THREE.Group();
  g.add(spoon);
  add(spoon, rbox(0.014, 0.006, 0.026, 0.003), M.alloy, 0, TOP + 0.014, -0.008);
  const strip = add(spoon, rbox(0.012, 0.07, 0.004, 0.002), M.alloy, 0, TOP - 0.025, -(R + 0.004));
  strip.rotation.x = 0.06;

  const pin = new THREE.Group();
  pin.position.set(0.015, TOP + 0.006, 0);
  g.add(pin);
  const ring = add(pin, new THREE.TorusGeometry(0.011, 0.0025, 8, 20), M.brass, 0.012, 0, 0);
  ring.rotation.y = Math.PI / 2;
  g.userData.parts = { pin, spoon };
  return g;
}
