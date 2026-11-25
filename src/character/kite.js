import * as THREE from 'three';
import { PALETTE as P, toon } from '../core/toon.js';
import { bone, part, ext, slot, rb, cyl, ball, ram, buildHand, finishRobot } from './robot.js';

/*
  Kite — slender, quick scout. Same skeleton (bone names, hand frame) as Rivet, different build: long
  limbs, narrow waist on an exposed spine, orange plating bolted over dark mechanics, blade pauldrons,
  a visor-slit helmet with two swept-back fins (the left one longer) and a side lamp. Hands are bare
  dark metal. Square servo caps instead of Rivet's round axle caps.
*/

export const KITE_DIMS = { hips: 1.0, spine: 0.12, chest: 0.2, neck: 0.32, head: 0.08, shoulderX: 0.19, upper: 0.31, fore: 0.3, thigh: 0.46, shin: 0.45, hipX: 0.095 };

export const KITE_SCHEMES = {
  player: { shell: 0xe0782f, trim: P.ivory, patch: P.slate },
  ally: { shell: P.sky, trim: P.ivory, patch: P.slate },
  enemy: { shell: 0xe0782f, trim: P.ink, patch: P.slate },
};

export function kiteMaterials(scheme = KITE_SCHEMES.player) {
  return {
    shell: toon(scheme.shell, { rim: 0.25 }),
    trim: toon(scheme.trim, { rim: 0.2 }),
    patch: toon(scheme.patch, { rim: 0.2 }),
    dark: toon(0x2a2b2e, { rim: 0.3, rimColor: 0xfff3e8 }),
    metal: toon(0x6f6e69, { rim: 0.32 }),
    rubber: toon(P.ink, { rim: 0.12 }),
    lens: new THREE.MeshBasicMaterial({ color: 0x9ff0ff, toneMapped: false }),
  };
}

/** Slim arm: servo drum at the shoulder, square-capped elbow clevis, back ram, bare dark hand. */
export function buildKiteArm(m, side) {
  const D = KITE_DIMS;
  const s = side > 0 ? 'L' : 'R';
  const upper = bone(`upperArm_${s}`);
  part(upper, cyl(0.05, 0.07, 20, 'x'), m.dark); // shoulder servo drum
  part(upper, cyl(0.03, 0.074, 16, 'x'), m.metal);
  part(upper, ext([[-0.04, -0.035], [0.04, -0.035], [0.035, -0.235], [-0.035, -0.235]], 0.075, { axis: 'z', bevel: 0.01 }), m.shell);
  for (const x of [-1, 1]) {
    part(upper, rb(0.012, 0.095, 0.064, 0.005), m.dark, [x * 0.039, -0.265, 0]);
    part(upper, rb(0.016, 0.062, 0.062, 0.008), m.patch, [x * 0.039, -D.upper, 0]);
  }

  const fore = bone(`forearm_${s}`, upper, 0, -D.upper, 0);
  part(fore, cyl(0.026, 0.064, 14, 'x'), m.dark);
  part(fore, ext([[-0.028, -0.024], [0.028, -0.024], [0.044, -0.12], [0.038, -0.235], [-0.038, -0.235], [-0.044, -0.12]], 0.08, { axis: 'z', bevel: 0.012 }), m.shell);
  part(fore, ext([[-0.04, -0.19], [0.04, -0.19], [0.0395, -0.212], [-0.0395, -0.212]], 0.084, { axis: 'z', bevel: 0.004 }), m.trim);
  part(fore, cyl(0.03, 0.05, 16), m.dark, [0, -0.26, 0]);
  const links = [ram(m, upper, [0, -0.07, -0.052], fore, [0, -0.08, -0.054], { r: 0.01, len: 0.19, lug: [0.016, 0.016] })];

  const hand = buildHand(m, { left: side > 0, skin: m.metal });
  hand.position.y = -D.fore;
  hand.rotation.x = -Math.PI / 2;
  fore.add(hand);
  return { upper, fore, hand, links, dims: { upper: D.upper, fore: D.fore }, bones: [upper, fore, ...hand.userData.bones] };
}

export function buildKite({ scheme = KITE_SCHEMES.player } = {}) {
  const m = kiteMaterials(scheme);
  const D = KITE_DIMS;
  const root = bone('root');
  const hips = bone('hips', root, 0, D.hips, 0);
  const spine = bone('spine', hips, 0, D.spine, 0);
  const chest = bone('chest', spine, 0, D.chest, 0);
  const neck = bone('neck', chest, 0, D.neck, -0.01);
  const head = bone('head', neck, 0, D.head, 0);
  const links = [];

  // pelvis: narrow dark frame, winged belt plate in front, actuator boxes over the hip joints
  part(hips, ext([[-0.07, 0.02], [0.07, 0.02], [0.06, -0.085], [-0.06, -0.085]], 0.2, { bevel: 0.012 }), m.dark);
  part(hips, ext([[-0.125, 0.03], [0.125, 0.03], [0.105, -0.005], [0.05, -0.015], [0.04, -0.09], [-0.04, -0.09], [-0.05, -0.015], [-0.105, -0.005]], 0.03, { axis: 'z', bevel: 0.006 }), m.shell, [0, 0, 0.075]);
  for (const x of [-1, 1]) {
    part(hips, rb(0.09, 0.12, 0.13, 0.016), m.dark, [x * 0.13, -0.05, 0]);
    part(hips, ext([[-0.026, -0.022], [0.026, -0.022], [0, 0.024]], 0.006, { axis: 'z', bevel: 0.001 }), m.trim, [x * 0.13, -0.05, 0.066]);
  }

  // waist: exposed spine column, a small orange actuator housing with a side servo
  part(spine, cyl(0.034, 0.34, 14), m.metal, [0, 0.05, 0]);
  part(spine, rb(0.1, 0.1, 0.09, 0.02), m.shell, [0, 0.03, 0.022]);
  part(spine, cyl(0.04, 0.03, 16, 'x'), m.dark, [0.062, 0.03, 0.02]);

  // chest: dark core, orange front plate with a vent slot, slim back pack, shoulder sockets, collar
  part(chest, ext([[0.1, -0.02], [0.12, 0.1], [0.12, 0.3], [0.08, 0.33], [-0.1, 0.33], [-0.12, 0.28], [-0.12, 0.05], [-0.08, -0.02]], 0.3, { bevel: 0.02 }), m.dark);
  part(chest, ext([[-0.155, 0.02], [0.155, 0.02], [0.165, 0.24], [0.145, 0.29], [-0.145, 0.29], [-0.165, 0.24]], 0.05, {
    axis: 'z', bevel: 0.01, holes: [slot(-0.06, 0.06, 0.1, 0.018)],
  }), m.shell, [0, 0, 0.11]);
  part(chest, ext([[-0.06, 0.21], [0.06, 0.21], [0.06, 0.225], [-0.06, 0.225]], 0.052, { axis: 'z', bevel: 0.003 }), m.trim, [0, 0, 0.11]);
  part(chest, rb(0.2, 0.22, 0.08, 0.02), m.patch, [0, 0.16, -0.15]);
  part(chest, rb(0.204, 0.04, 0.084, 0.01), m.shell, [0, 0.27, -0.15]);
  for (const x of [-1, 1]) part(chest, cyl(0.055, 0.06, 20, 'x'), m.dark, [x * 0.165, 0.2, 0]);
  part(chest, cyl(0.05, 0.03, 18), m.dark, [0, 0.34, -0.01]);

  // head: neck column, visor helmet (glowing slit), chin, two swept fins, side lamp, whip antenna
  part(neck, cyl(0.03, 0.1, 14), m.metal, [0, 0.03, 0]);
  part(head, ext([[-0.08, 0], [0.06, 0], [0.11, 0.04], [0.11, 0.1], [0.07, 0.14], [-0.08, 0.14], [-0.1, 0.07]], 0.14, { bevel: 0.014 }), m.shell);
  part(head, rb(0.15, 0.036, 0.05, 0.01), m.dark, [0, 0.085, 0.09]);
  part(head, rb(0.11, 0.01, 0.008, 0.003), m.lens, [0, 0.085, 0.116]);
  part(head, rb(0.1, 0.04, 0.08, 0.012), m.dark, [0, 0.015, 0.055]);
  const fin = [[-0.05, 0], [0.025, 0], [-0.17, 0.085], [-0.215, 0.09], [-0.17, 0.05]]; // laid well back, like swept aerials
  for (const x of [-1, 1]) {
    const f = part(head, ext(fin, 0.018, { bevel: 0.004 }), m.shell, [x * 0.052, 0.125, 0.0], [0, 0, -x * 0.22]);
    if (x > 0) f.scale.set(1, 1.2, 1.12);
  }
  part(head, rb(0.04, 0.05, 0.05, 0.008), m.dark, [0.085, 0.07, 0.01]);
  part(head, rb(0.006, 0.034, 0.034, 0.002), m.lens, [0.106, 0.07, 0.01]);
  part(head, cyl(0.005, 0.16, 6), m.rubber, [-0.045, 0.2, -0.055]);

  // shoulders: blade pauldron swept out over the servo, then the arm
  const arms = {};
  const blade = (sd) => [[-0.05, -0.01], [0.15, -0.04], [0.17, -0.02], [0.03, 0.05], [-0.05, 0.045]].map(([x, y]) => [x * sd, y]);
  for (const side of [1, -1]) {
    const s = side > 0 ? 'L' : 'R';
    const sh = bone(`shoulder_${s}`, chest, side * D.shoulderX, 0.2, 0);
    part(sh, ext(side > 0 ? blade(1) : blade(-1).reverse(), 0.15, { axis: 'z', bevel: 0.01 }), m.shell, [0, 0.075, 0]);
    const arm = buildKiteArm(m, side);
    arm.upper.position.set(side * 0.04, 0, 0);
    sh.add(arm.upper);
    links.push(...arm.links);
    arms[s] = { ...arm, shoulder: sh };
  }

  // legs: long armoured thighs, square knee pads, slim shins with front guards, dark toe-jointed feet
  const legs = {};
  for (const side of [1, -1]) {
    const s = side > 0 ? 'L' : 'R';
    const thigh = bone(`thigh_${s}`, hips, side * D.hipX, -0.07, 0);
    part(thigh, ball(0.05), m.metal);
    part(thigh, rb(0.07, 0.32, 0.08, 0.016), m.dark, [0, -0.23, 0]);
    part(thigh, ext([[-0.06, -0.06], [0.07, -0.06], [0.075, -0.36], [0.05, -0.4], [-0.05, -0.4], [-0.06, -0.2]], 0.11, { bevel: 0.014 }), m.shell);
    if (side > 0) part(thigh, ext([[-0.062, -0.1], [0.072, -0.1], [0.073, -0.125], [-0.062, -0.125]], 0.114, { bevel: 0.004 }), m.trim);
    for (const x of [-1, 1]) {
      part(thigh, rb(0.012, 0.09, 0.07, 0.005), m.dark, [x * 0.047, -0.42, 0]);
      part(thigh, rb(0.016, 0.068, 0.068, 0.008), m.patch, [x * 0.047, -D.thigh, 0]);
    }

    const shin = bone(`shin_${s}`, thigh, 0, -D.thigh, 0);
    part(shin, cyl(0.032, 0.08, 16, 'x'), m.dark);
    part(shin, rb(0.08, 0.1, 0.035, 0.012), m.shell, [0, -0.035, 0.05]); // knee pad
    part(shin, rb(0.05, 0.36, 0.05, 0.012), m.dark, [0, -0.22, 0]);
    part(shin, ext([[0.0, -0.08], [0.055, -0.08], [0.05, -0.37], [0.0, -0.39]], 0.08, { bevel: 0.012 }), m.shell, [0, 0, 0.012]);
    part(shin, cyl(0.03, 0.04, 16), m.dark, [0, -0.41, 0]);
    links.push(ram(m, thigh, [0, -0.17, -0.07], shin, [0, -0.15, -0.04], { r: 0.013, len: 0.24, lug: [0.022, 0.018] }));

    const foot = bone(`foot_${s}`, shin, 0, -D.shin, 0);
    part(foot, ball(0.03), m.metal);
    part(foot, ext([[-0.07, -0.005], [0.07, -0.005], [0.075, 0.02], [0.02, 0.03], [-0.06, 0.028], [-0.08, 0.012]], 0.1, { bevel: 0.01 }), m.dark);
    part(foot, cyl(0.012, 0.104, 10, 'x'), m.metal, [0, 0.0, 0.075]);
    part(foot, ext([[0.075, -0.005], [0.15, -0.005], [0.155, 0.01], [0.08, 0.022]], 0.1, { bevel: 0.006 }), m.patch);
    part(foot, ext([[-0.085, -0.02], [0.158, -0.02], [0.16, -0.004], [-0.088, -0.004]], 0.108, { bevel: 0.004 }), m.rubber);
    legs[s] = { thigh, shin, foot };
  }

  return finishRobot({ root, arms, legs, links, mats: m, dims: D });
}
