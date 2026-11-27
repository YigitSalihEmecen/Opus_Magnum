import { buildPanther } from './models/panther.js';
import { buildSnake } from './models/snake.js';
import { buildGrizzly } from './models/grizzly.js';
import { buildLynx } from './models/lynx.js';
import { buildKestrel } from './models/kestrel.js';
import { buildShotgunClips, buildBoltClips } from './animations.js';

/*
  Weapon definitions. Everything that differs between guns lives here:
    stats     — gunplay tuning (angles in degrees); optional modes, burst, pellets, magSize (no mag slot)
    pattern   — recoil per shot index → [pitch up, yaw right]
    poses     — hand poses in gun space [x, y, z, rx, ry, rz, curl]; clips are built from these.
                Optional: triggerCurl, thumbAim (gun-space targets), lhPort/shellAt (shell loading),
                rackTravel, rackPush, lhHip
    gripPoses — which hand pose each grip attachment uses (only guns with a grip slot)
    clips     — clip builder if the default (box-mag) reloads don't fit, e.g. the pump shotgun
    vm        — viewmodel placement and mechanics. Optional: sprintPos/sprintRot, oneHand, twoHandHip,
                ironAds, pump, pivot
    slots / attachments / defaults — which attachments fit (ids from attachments.js)
*/

/** Damage by body part: the head uses each gun's headMultiplier, the chest is the base, legs take less. */
export const ZONE = { body: 1, legs: 0.72 };

/*
  Damage falloff (stats.falloff): full damage to `start` m, easing down to `min` × at `end` m and beyond.
  Steep for the SMG and shotgun, gentle for the rifle, almost none for the sniper.
*/

const ALL_OPTICS = ['iron', 'holo', 'reddot', 'prism2', 'scope3'];
const MUZZLES = ['comp', 'flash', 'suppressor'];
const STOCKS = ['skeleton', 'precision'];

export const WEAPONS = [
  {
    id: 'panther',
    name: 'Panther',
    kind: 'Carbine',
    build: buildPanther,
    sound: 'fire',
    stats: {
      rpm: 660,
      damage: 16,
      headMultiplier: 1.75,
      range: 400,
      falloff: { start: 22, end: 65, min: 0.72 }, // rifle: holds up at mid range
      adsTime: 0.19,
      reloadRate: 1,
      spread: { hip: 1.4, ads: 0.05, move: 1.2, moveAds: 0.12, air: 2.4, airAds: 0.35, slide: 0.4 },
      bloom: { perShot: 0.2, max: 1.4, recovery: 4.5 },
      recoil: { adsScale: 0.82, resetTime: 0.28, jitter: 0.08, punch: 0.45 },
    },
    // climbs hard, then drifts right → left → right
    pattern: (i) => [0.95 - 0.38 * Math.min(1, i / 11), i < 5 ? 0.1 : i < 12 ? 0.24 : i < 19 ? -0.3 : i < 30 ? 0.2 : i < 40 ? -0.22 : 0.18],
    poses: {
      // web of the hand high in the backstrap, wrist behind the grip, index on the trigger (model is ×1.1)
      rightHand: [0.002, -0.068, 0.114, -14, -25, -90, 1.4],
      triggerCurl: 0.85,
      thumbAim: [[-0.043, -0.03, 0.06], [-0.043, -0.022, -0.01]], // thumb along the left of the receiver
      lhRest: [-0.04, -0.062, -0.374, 18, -78, 172, 1.15],
      lhMag: [-0.044, -0.176, -0.105, 12, 0, 90, 1.15],
      lhHandle: [-0.079, 0.037, -0.154, -6, -8, 95, 1.35],
      lhOff: [-0.2, -0.42, 0.08, 40, 10, 60, 1.2],
      lhVertical: [-0.037, -0.097, -0.396, -6, 0, 90, 1.3],
      lhAngled: [-0.044, -0.064, -0.341, 14, -70, 165, 1.1],
      rackTravel: 0.097,
    },
    gripPoses: { none: 'lhRest', vertical: 'lhVertical', angled: 'lhAngled' },
    vm: { hipPos: [0.175, -0.19, -0.4], hipRot: [0.5, 6, 3], inspectPos: [0.07, 0.005, -0.92], boltTravel: 0.042, chTravel: 0.086, kick: 1 },
    slots: ['muzzle', 'scope', 'mag', 'grip', 'stock'],
    attachments: { muzzle: MUZZLES, scope: ALL_OPTICS, mag: ['small', 'big', 'drum'], grip: ['none', 'vertical', 'angled'], stock: STOCKS },
    defaults: { muzzle: 'comp', scope: 'holo', mag: 'big', grip: 'none', stock: 'skeleton' },
  },
  {
    id: 'snake',
    name: 'Snake',
    kind: 'SMG',
    build: buildSnake,
    sound: 'smgFire',
    stats: {
      rpm: 920,
      damage: 11,
      headMultiplier: 1.5,
      range: 250,
      falloff: { start: 8, end: 30, min: 0.5 }, // SMG: strong up close, half damage past 30 m
      adsTime: 0.15,
      reloadRate: 1.15,
      spread: { hip: 1.0, ads: 0.1, move: 0.7, moveAds: 0.14, air: 1.7, airAds: 0.4, slide: 0.15 },
      bloom: { perShot: 0.11, max: 1.0, recovery: 6 },
      recoil: { adsScale: 0.86, resetTime: 0.2, jitter: 0.11, punch: 0.32 },
    },
    // lighter, flatter climb with a fast left/right shimmy
    pattern: (i) => [0.56 - 0.2 * Math.min(1, i / 9), (i % 6 < 3 ? 0.14 : -0.12) + (i > 20 ? 0.05 : 0)],
    poses: {
      // same grip as the pistol and rifle, fitted to the smaller frame (model is ×0.8)
      rightHand: [0.002, -0.052, 0.1, -14, -25, -90, 1.4],
      triggerCurl: 0.85,
      thumbAim: [[-0.033, -0.022, 0.05], [-0.033, -0.018, -0.01]],
      lhRest: [-0.027, -0.064, -0.086, -12, 0, 90, 1.3],
      lhMag: [-0.027, -0.122, -0.104, -10, 0, 90, 1.2],
      lhHandle: [-0.06, 0.026, -0.08, -6, -8, 95, 1.35],
      rackTravel: 0.07,
      lhOff: [-0.2, -0.42, 0.08, 40, 10, 60, 1.2],
    },
    // held tight and canted inward; sprints at high-ready (muzzle up) instead of the rifle's low carry
    vm: {
      hipPos: [0.11, -0.115, -0.315], hipRot: [1.6, 2.5, 7], inspectPos: [0.0, 0.01, -0.5], boltTravel: 0.026, chTravel: 0.06, kick: 0.7,
      sprintPos: [0.05, 0.035, 0.04], sprintRot: [40, -14, -10], oneHand: true, twoHandHip: true,
      // two hands at the hip; sprinting frees the support hand and lifts the gun to high-ready, out to the right
    },
    slots: ['muzzle', 'scope', 'mag', 'stock'],
    attachments: { muzzle: ['comp', 'flash', 'smgcan'], scope: ALL_OPTICS, mag: ['smg25', 'smg35', 'smg50'], stock: STOCKS },
    defaults: { muzzle: 'flash', scope: 'reddot', mag: 'smg35', stock: 'skeleton' },
  },
  {
    id: 'grizzly',
    name: 'Grizzly',
    kind: 'Shotgun',
    build: buildGrizzly,
    clips: buildShotgunClips,
    sound: 'shotgunFire',
    stats: {
      rpm: 80,
      magSize: 7, // tube-fed, loaded shell by shell
      damage: 13.2, // per pellet
      pellets: 9,
      closeBonus: { mult: 1.5, full: 4, end: 10 }, // ×1.5 inside 4 m, easing back to ×1 by 10 m
      pelletSpread: 3.4, // ring radius in degrees; centre pellet + 8 around it
      pelletAds: 0.7, // aimed, the ring is 30% tighter
      headMultiplier: 1.5,
      range: 70,
      falloff: { start: 6, end: 20, min: 0.4 }, // per pellet, on top of the close bonus
      adsTime: 0.22,
      reloadRate: 1,
      spread: { hip: 0.5, ads: 0.1, move: 0.5, moveAds: 0.1, air: 1.2, airAds: 0.3, slide: 0.1 },
      bloom: { perShot: 0, max: 0, recovery: 1 },
      recoil: { adsScale: 0.88, resetTime: 0.7, jitter: 0.5, punch: 0.85 },
    },
    pattern: () => [4.4, 0.5],
    // right hand wraps the stock wrist (no pistol grip); left hand rides the pump
    poses: {
      rightHand: [0.032, 0.022, 0.095, -45, 6, -90, 1.35],
      lhRest: [-0.036, -0.055, -0.32, 18, -78, 172, 1.2],
      // palm up just under the loading port, fingers nearly straight so they cradle the shell instead of
      // curling up into the receiver; the thumb sits behind the shell's brass head and pushes it in
      lhPort: [0, -0.07, -0.07, 4, 0, 180, 0.2],
      shellAt: [0, -0.03, 0.15], // shell lying on the fingers, nose at the port
      lhOff: [-0.2, -0.42, 0.08, 40, 10, 60, 1.2],
      rackTravel: 0.06,
    },
    // pump: fore-end/bolt follow the rack track; pivot = bore axis for the reload toss
    vm: {
      hipPos: [0.18, -0.18, -0.38], hipRot: [-0.3, 6.5, 4], inspectPos: [0.08, 0.0, -0.92], boltTravel: 0.04, chTravel: 0.06, kick: 2.6,
      pump: true, pivot: [0, 0.03, 0],
    },
    slots: ['scope'],
    attachments: { scope: ALL_OPTICS },
    defaults: { scope: 'iron' },
  },
  {
    id: 'lynx',
    name: 'Lynx',
    kind: 'Pistol',
    build: buildLynx,
    sound: 'pistolFire',
    stats: {
      modes: ['semi', 'burst'],
      rpm: 420,
      burst: 3,
      burstRpm: 1000,
      burstDelay: 0.26,
      damage: 17,
      headMultiplier: 2,
      range: 200,
      falloff: { start: 10, end: 35, min: 0.6 },
      adsTime: 0.13,
      reloadRate: 1.3,
      spread: { hip: 0.8, ads: 0.08, move: 0.55, moveAds: 0.12, air: 1.4, airAds: 0.35, slide: 0.2 },
      bloom: { perShot: 0.22, max: 1.1, recovery: 6 },
      recoil: { adsScale: 0.85, resetTime: 0.25, jitter: 0.12, punch: 0.55 },
    },
    // snappy flip, burst walks up and slightly right
    pattern: (i) => [1.1 - 0.25 * Math.min(1, (i % 3) / 2), i % 3 === 2 ? 0.2 : -0.06],
    poses: {
      // web of the hand high in the backstrap, wrist straight behind the grip, fingers wrap the front
      rightHand: [0.002, -0.05, 0.104, -10, -25, -90, 1.4],
      triggerCurl: 0.85, // index finger rests on the trigger instead of wrapping the grip
      // thumb wraps behind the backstrap, then lies forward along the left side of the frame (gun space)
      thumbAim: [[-0.031, -0.02, 0.05], [-0.031, -0.015, -0.02]],
      lhRest: [-0.036, -0.08, 0.058, -12, -6, 90, 1.35], // support hand cups the grip at ADS
      lhMag: [-0.028, -0.124, 0.032, 10, 0, 90, 1.15],
      lhHandle: [-0.044, 0.017, 0.06, 45, -90, 0, 1.4], // overhand on the slide serrations, arm from below-left
      lhOff: [-0.2, -0.42, 0.08, 40, 10, 60, 1.2],
      rackTravel: 0.039,
      rackPush: [0.04, -0.01, -0.13, -4, -10, 10],
    },
    vm: {
      hipPos: [0.05, -0.088, -0.36], hipRot: [3, 1, 2], inspectPos: [0.02, 0.0, -0.46], boltTravel: 0.006, chTravel: 0.05, kick: 0.9,
      sprintPos: [0.11, 0.04, 0.04], sprintRot: [45, -14, -10], oneHand: true, twoHandHip: true, ironAds: 0.36,
      // two-handed and centred at the hip; sprinting frees the support hand and lifts the gun up and out to the right
    },
    slots: ['muzzle', 'scope', 'mag', 'stock'],
    attachments: { muzzle: ['pthread', 'pcan'], scope: ['piron', 'holo', 'reddot'], mag: ['p15', 'p24'], stock: ['pnone', 'pbrace'] },
    defaults: { muzzle: 'pthread', scope: 'piron', mag: 'p15', stock: 'pnone' },
  },
  {
    id: 'kestrel',
    name: 'Kestrel',
    kind: 'Sniper',
    build: buildKestrel,
    clips: buildBoltClips,
    sound: 'shotgunFire',
    stats: {
      rpm: 60, // the bolt cycle is the real limit
      damage: 155, // one body shot drops a full-health (100) target
      headMultiplier: 1.5,
      range: 600,
      falloff: { start: 60, end: 200, min: 0.92 }, // sniper: barely drops
      adsTime: 0.3,
      reloadRate: 1,
      // wild from the hip and on the move; dead on when scoped and still
      spread: { hip: 5, ads: 0, move: 3, moveAds: 1.6, air: 6, airAds: 4, slide: 2 },
      bloom: { perShot: 0, max: 0, recovery: 1 },
      recoil: { adsScale: 0.9, resetTime: 0.9, jitter: 0.1, punch: 2.4 },
    },
    // small lasting kick; the big jolt is the visual punch, which springs back onto the target
    pattern: () => [1.1, 0.12],
    poses: {
      rightHand: [0.002, -0.06, 0.106, -14, -25, -90, 1.4],
      triggerCurl: 0.85,
      thumbAim: [[-0.038, -0.026, 0.055], [-0.038, -0.02, -0.01]],
      // bolt work: hand pinches the knob from behind, rises with it as it lifts; the gun rolls to show it
      rhBolt: [0.066, 0.022, 0.078, -35, -25, -90, 1.35],
      rhBoltLift: [-0.034, 0.058, 0, 0, 0, 30],
      boltTilt: [-0.02, 0.04, 0, 2, 4, 14],
      boltPull: 0.075,
      lhRest: [-0.04, -0.06, -0.46, 18, -78, 172, 1.15],
      lhMag: [-0.044, -0.13, -0.115, 12, 0, 90, 1.15],
      lhHandle: [-0.06, 0.03, 0.0, -6, -8, 95, 1.35],
      lhOff: [-0.2, -0.42, 0.08, 40, 10, 60, 1.2],
    },
    vm: { hipPos: [0.16, -0.215, -0.5], hipRot: [0.4, 4, 3], inspectPos: [0.15, 0.0, -1.15], boltTravel: 0.075, chTravel: 0, kick: 2.2, bolt: true },
    slots: ['muzzle', 'scope', 'mag'],
    attachments: { muzzle: ['sbrake', 'suppressor'], scope: ['scope6', 'scope3', 'holo', 'iron'], mag: ['s5', 's10'] },
    defaults: { muzzle: 'sbrake', scope: 'scope6', mag: 's5' },
  },
];
