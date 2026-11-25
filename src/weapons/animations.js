import { Track } from './anim.js';

/*
  Hand-authored weapon clips, shared by every gun and driven by that gun's hand poses
  (see weapons.js). Everything is in gun space (metres, degrees).
  Tracks:
    gun — [x, y, z, rx, ry, rz]       offset of the whole weapon around the grip pivot
    lh  — [x, y, z, rx, ry, rz, curl] left-hand wrist pose (Euler order YXZ)
    ch  — [pull]                       charging handle travel 0..1
  Events drive sound, mag parenting, ammo refill and procedural kicks.
*/


const add = (p, d) => p.map((v, i) => v + (d[i] ?? 0));
const GUN0 = [0, 0, 0, 0, 0, 0];

/** tactical: mag still has rounds */
function reload(P, lhRest) {
  const { lhMag, lhOff } = P;
  return {
    name: 'reload',
    duration: 2.05,
    readyAt: 1.75,
    tracks: {
      gun: new Track([
        [0, GUN0],
        [0.2, [-0.026, 0.036, 0.01, 12, 10, -20]],
        [0.38, [-0.03, 0.042, 0.01, 14, 11, -23]],
        [0.5, [-0.027, 0.032, 0.014, 10, 11, -25]],
        [0.9, [-0.022, 0.022, 0.018, 8, 13, -27]],
        [1.22, [-0.03, 0.044, 0.008, 15, 11, -24]],
        [1.36, [-0.03, 0.038, 0.01, 13, 11, -22], 'hold'],
        [1.56, [-0.026, 0.04, 0.008, 12, 9, -18]],
        [1.72, [-0.01, 0.014, 0.002, 4, 4, -7]],
        [2.05, GUN0],
      ]),
      lh: new Track([
        [0, lhRest],
        [0.12, add(lhRest, [0.01, -0.05, 0.08, 10, 30, -40])],
        [0.3, add(lhMag, [0, -0.02, 0.01, -6])],
        [0.4, lhMag, 'hold'],
        [0.6, add(lhMag, [-0.025, -0.09, 0.03, -18, 0, 12])],
        [0.85, lhOff],
        [1.0, add(lhOff, [0.02, -0.02, 0])],
        [1.2, add(lhMag, [-0.012, -0.06, 0.02, -20, 0, 10])],
        [1.36, lhMag, 'hold'],
        [1.47, add(lhMag, [0, -0.045, 0.005, 0, 0, 0, -0.5])],
        [1.55, add(lhMag, [0, 0.004, 0, 0, 0, 0, -0.6]), 'hold'],
        [1.7, add(lhRest, [0.01, -0.06, 0.1, 10, 40, -50])],
        [1.9, lhRest],
        [2.05, lhRest],
      ]),
    },
    events: [
      [0.1, 'cloth'],
      [0.38, 'magGrab'],
      [0.42, 'magOut'],
      [0.46, 'kick', { pos: [0, -0.004, 0], rot: [-1.2, 0, 1.5] }],
      [0.9, 'cloth'],
      [1.24, 'magIn'],
      [1.36, 'magSeat'],
      [1.36, 'kick', { pos: [0, 0.012, 0.004], rot: [3.5, 0, -2] }],
      [1.55, 'slap'],
      [1.55, 'kick', { pos: [0, 0.006, 0], rot: [2, 0, -1] }],
    ],
  };
}

/** empty: mag drops free, fresh mag, then rack the charging handle */
function reloadEmpty(P, lhRest) {
  const { lhMag, lhOff, lhHandle } = P;
  const back = add(lhHandle, [0.004, 0, P.rackTravel ?? 0.088, 0, 0, 0, 0.1]);
  const push = P.rackPush ?? []; // short guns sit close to the eye: push them out while racking
  return {
    name: 'reloadEmpty',
    duration: 2.6,
    readyAt: 2.3,
    tracks: {
      gun: new Track([
        [0, GUN0],
        [0.16, [-0.024, 0.036, 0.01, 13, 9, -22]],
        [0.32, [-0.028, 0.04, 0.01, 14, 9, -24]],
        [0.7, [-0.022, 0.02, 0.018, 8, 12, -26]],
        [0.98, [-0.03, 0.044, 0.008, 15, 11, -24]],
        [1.08, [-0.03, 0.038, 0.01, 13, 11, -22], 'hold'],
        [1.3, add([-0.034, 0.05, 0.0, 10, 22, -34], push)],
        [1.5, add([-0.036, 0.048, 0.008, 11, 24, -36], push)],
        [1.62, add([-0.034, 0.052, 0.0, 14, 22, -32], push), 'hold'],
        [1.95, [-0.01, 0.012, 0, 4, 6, -10]],
        [2.6, GUN0],
      ]),
      lh: new Track([
        [0, lhRest],
        [0.2, add(lhRest, [-0.02, -0.12, 0.12, 20, 30, -40])],
        [0.42, lhOff],
        [0.55, add(lhOff, [0.02, -0.02, 0])],
        [0.9, add(lhMag, [-0.012, -0.06, 0.02, -20, 0, 10])],
        [1.08, lhMag, 'hold'],
        [1.2, add(lhMag, [-0.03, 0.06, -0.02, 0, 0, 0, -0.3])],
        [1.36, add(lhHandle, [-0.01, 0.006, -0.01])],
        [1.42, lhHandle, 'hold'],
        [1.52, back, 'hold'],
        [1.62, add(back, [-0.02, 0.01, 0.02, 0, 0, 0, -0.5])],
        [1.95, add(lhRest, [0.01, -0.06, 0.1, 10, 40, -50])],
        [2.25, lhRest],
        [2.6, lhRest],
      ]),
      ch: new Track([
        [0, [0]],
        [1.42, [0], 'hold'],
        [1.52, [1], 'hold'],
        [1.555, [0], 'hold'],
        [2.6, [0]],
      ]),
    },
    events: [
      [0.08, 'magRelease'],
      [0.12, 'magDrop'],
      [0.3, 'cloth'],
      [0.42, 'magFromPouch'],
      [0.94, 'magIn'],
      [1.08, 'magSeat'],
      [1.08, 'kick', { pos: [0, 0.012, 0.004], rot: [3.5, 0, -2] }],
      [1.44, 'boltBack'],
      [1.44, 'kick', { pos: [0, 0, 0.006], rot: [-1, -1.5, 0] }],
      [1.555, 'boltForward'],
      [1.555, 'kick', { pos: [0, 0.01, -0.012], rot: [4, 1, -3] }],
    ],
  };
}

function equip(P, lhRest) {
  const { lhOff } = P;
  return {
    name: 'equip',
    duration: 0.62,
    readyAt: 0.42,
    tracks: {
      gun: new Track([
        [0, [0.04, -0.3, 0.06, -45, 14, 35]],
        [0.32, [0, 0.008, -0.004, 5, -2, -4]],
        [0.62, GUN0],
      ]),
      lh: new Track([
        [0, lhOff],
        [0.26, add(lhRest, [-0.02, -0.06, 0.04])],
        [0.45, lhRest],
        [0.62, lhRest],
      ]),
    },
    events: [[0.05, 'cloth'], [0.32, 'click']],
  };
}

/** P = the weapon's hand poses; clips start and end on lhRest (which depends on the grip). */
export function buildClips(P, lhRest = P.lhRest) {
  return { reload: reload(P, lhRest), reloadEmpty: reloadEmpty(P, lhRest), equip: equip(P, lhRest) };
}

/*
  Pump shotgun clips. Extra tracks:
    rh   — right-hand pose (it lets go of the stock during the toss)
    free — the gun relative to both hands [x, y, z, rx, ry, rz], rotated about vm.pivot (the bore)
  Reloading is a loop driven by gunplay: reloadStart cants the gun so the loading port faces the
  left hand, reloadShell (repeated) fetches one shell and thumbs it in, then reloadEnd rolls back —
  or, if the tube ran dry, reloadEndEmpty tosses the gun through a full roll, catches it and racks.
*/
const FREE0 = [0, 0, 0, 0, 0, 0];
/** Hand at the port right after a thumb push: a little forward and up. */
const loadedPort = (P) => add(P.lhPort, [0, 0.004, -0.02]);
// canted and tipped muzzle-up so the port underneath faces the camera; the left hand comes from below
const LOADING = [-0.05, -0.02, -0.04, 12, 18, -70];

function pumpRack(P, lhRest, t0, travel = P.rackTravel ?? 0.055) {
  const back = add(lhRest, [0, -0.003, travel, 0, 0, 0, 0.05]);
  return {
    lh: [[t0, lhRest, 'hold'], [t0 + 0.1, back, 'hold'], [t0 + 0.22, lhRest, 'hold']],
    ch: [[t0, [0], 'hold'], [t0 + 0.1, [1], 'hold'], [t0 + 0.22, [0], 'hold']],
    events: [
      [t0 + 0.04, 'pumpBack'],
      [t0 + 0.08, 'kick', { pos: [0, -0.002, 0.004], rot: [-0.6, 0.4, 1] }],
      [t0 + 0.2, 'pumpForward'],
      [t0 + 0.22, 'kick', { pos: [0, 0.004, -0.006], rot: [1.4, 0, -1.2] }],
    ],
  };
}

function shotgunPump(P, lhRest) {
  // the shot's kick plays out first (gun rocks back and up), then a hard rack
  const r = pumpRack(P, lhRest, 0.15);
  return {
    name: 'pump',
    duration: 0.6,
    readyAt: 0.44,
    tracks: {
      gun: new Track([
        [0, GUN0], [0.06, [0.002, 0.012, 0.02, 7, -1, 3]], [0.15, [0, 0.006, 0.012, 3, 1, -2]],
        [0.26, [-0.006, -0.008, 0.016, -3, 3, -8]], [0.38, [0, 0.004, -0.006, 1.5, 0, -2]], [0.6, GUN0],
      ]),
      lh: new Track([[0, lhRest], ...r.lh, [0.6, lhRest]]),
      ch: new Track([[0, [0]], ...r.ch, [0.6, [0]]]),
    },
    events: [...r.events, [0.21, 'eject']],
  };
}

function shotgunEquip(P, lhRest) {
  const r = pumpRack(P, lhRest, 0.44);
  return {
    name: 'equip',
    duration: 0.8,
    readyAt: 0.66,
    tracks: {
      gun: new Track([[0, [0.04, -0.3, 0.06, -45, 14, 35]], [0.32, [0, 0.008, -0.004, 5, -2, -4]], [0.5, [-0.004, -0.004, 0.008, -2, 2, -6]], [0.8, GUN0]]),
      lh: new Track([[0, P.lhOff], [0.26, add(lhRest, [-0.02, -0.06, 0.04])], ...r.lh, [0.8, lhRest]]),
      ch: new Track([[0, [0]], ...r.ch, [0.8, [0]]]),
    },
    events: [[0.05, 'cloth'], ...r.events],
  };
}

function shotgunReloadStart(P, lhRest) {
  return {
    name: 'reloadStart',
    duration: 0.36,
    tracks: {
      gun: new Track([[0, GUN0], [0.24, add(LOADING, [0, 0.006, 0, 2, 1, -8])], [0.36, LOADING]]),
      lh: new Track([[0, lhRest], [0.14, add(lhRest, [0.01, -0.05, 0.1, 10, 20, -30])], [0.36, loadedPort(P)]]),
      lthumb: new Track([[0, [1]], [0.36, [1]]]),
    },
    events: [[0.04, 'cloth'], [0.12, 'flip']],
  };
}

/**
 * One shell, thumbed in: drop away from the port, reach down out of frame to the belt, come back with
 * a shell held in the fingertips, set its nose in the port, then the thumb drives it home (lthumb 0→1).
 * Loops; starts and ends with the hand at the port and the thumb extended.
 */
function shotgunReloadShell(P) {
  const port = P.lhPort, pushed = loadedPort(P);
  const away = add(port, [0, -0.035, 0.015, -10, 0, 0, 0.1]);
  const belt = add(port, [-0.03, -0.2, 0.09, -35, 0, 25, 0.4]);
  const lineUp = add(port, [0, -0.028, 0.024, -6, 0, 0, 0.05]);
  return {
    name: 'reloadShell',
    duration: 0.46,
    tracks: {
      gun: new Track([[0, LOADING], [0.36, add(LOADING, [0, 0.003, 0.002, 1.2, 0, -1.5])], [0.41, add(LOADING, [0, -0.002, 0, -0.8, 0, 1])], [0.46, LOADING]]),
      lh: new Track([
        [0, pushed],
        [0.07, away],
        [0.17, belt],
        [0.27, lineUp],
        [0.32, port, 'hold'],
        [0.4, pushed, 'hold'],
        [0.46, pushed],
      ]),
      lthumb: new Track([[0, [1]], [0.08, [0]], [0.32, [0], 'hold'], [0.4, [1], 'hold'], [0.46, [1]]]),
    },
    events: [[0.1, 'cloth'], [0.17, 'shellGrab'], [0.4, 'shellIn'], [0.4, 'kick', { pos: [0, 0.003, 0], rot: [0.6, 0, -0.6] }]],
  };
}

function shotgunReloadEnd(P, lhRest) {
  return {
    name: 'reloadEnd',
    duration: 0.42,
    readyAt: 0.3,
    tracks: {
      gun: new Track([[0, LOADING], [0.22, [-0.006, 0.01, -0.01, 4, 2, 10]], [0.32, [0, -0.002, 0, -1, 0, -2]], [0.42, GUN0]]),
      lh: new Track([[0, loadedPort(P)], [0.16, add(lhRest, [0.01, -0.05, 0.08, 10, 20, -30])], [0.34, lhRest], [0.42, lhRest]]),
    },
    events: [[0.06, 'flip'], [0.24, 'kick', { pos: [0, 0.004, 0], rot: [1, 0, 2] }]],
  };
}

/** Ran dry: toss the gun through a full roll (it lands upright), catch, rack a shell into the chamber. */
function shotgunReloadEndEmpty(P, lhRest) {
  const { rightHand } = P;
  const rhOpen = add(rightHand, [0.012, -0.065, 0.035, 8, 0, 0, -0.95]);
  const rack = pumpRack(P, lhRest, 0.76);
  return {
    name: 'reloadEndEmpty',
    duration: 1.3,
    readyAt: 1.08,
    tracks: {
      gun: new Track([
        [0, LOADING],
        [0.08, add(LOADING, [0, -0.016, 0.01, -6, 0, 6])],
        [0.3, [-0.03, 0.02, -0.07, 16, 8, -32]],
        [0.5, [0, -0.004, 0, 1, 0, 0]],
        [0.58, [0, -0.026, 0.012, -5, 0, 3]],
        [0.76, [-0.004, -0.004, 0.006, -1, 2, -5]],
        [1.0, [0, 0.004, -0.004, 1, 0, -2]],
        [1.3, GUN0],
      ]),
      free: new Track([
        [0, FREE0],
        [0.06, FREE0, 'hold'],
        [0.29, [-0.03, 0.04, -0.2, 14, 28, -175]], // out and yawed so the long stock swings off-screen right
        [0.52, [0, 0, 0, 0, 0, -360], 'hold'],
        [1.3, [0, 0, 0, 0, 0, -360]],
      ]),
      rh: new Track([
        [0, rightHand, 'hold'],
        [0.1, rhOpen],
        [0.42, add(rhOpen, [0, 0.01, -0.005])],
        [0.52, rightHand, 'hold'],
        [1.3, rightHand],
      ]),
      lh: new Track([
        [0, loadedPort(P)],
        [0.16, add(lhRest, [-0.03, -0.14, 0.06, 0, 0, 0, -0.4])],
        [0.6, add(lhRest, [-0.01, -0.03, 0.02])],
        [0.76, lhRest, 'hold'],
        ...rack.lh.slice(1),
        [1.3, lhRest],
      ]),
      ch: new Track([[0, [0]], ...rack.ch, [1.3, [0]]]),
    },
    events: [
      [0.06, 'toss'],
      [0.52, 'catch'],
      [0.52, 'kick', { pos: [0, -0.01, 0.006], rot: [-3, 1, 2.5] }],
      ...rack.events,
    ],
  };
}

export function buildShotgunClips(P, lhRest = P.lhRest) {
  return {
    reloadStart: shotgunReloadStart(P, lhRest),
    reloadShell: shotgunReloadShell(P),
    reloadEnd: shotgunReloadEnd(P, lhRest),
    reloadEndEmpty: shotgunReloadEndEmpty(P, lhRest),
    equip: shotgunEquip(P, lhRest),
    pump: shotgunPump(P, lhRest),
  };
}

/*
  Bolt-action clips. The right hand leaves the grip to work the bolt; ch is [pull 0..1, lift 0..1].
  boltCycle runs after every shot that leaves a round in the mag; the empty reload ends with one.
*/
function boltWork(P, t0) {
  const grip = P.rightHand, knob = P.rhBolt;
  const tilt = P.boltTilt ?? [-0.04, 0.05, 0.02, 4, -12, 25];
  const lifted = add(knob, P.rhBoltLift ?? [0, 0.02, 0, 0, 0, 25]);
  const back = add(lifted, [0, 0, P.boltPull ?? 0.075]);
  const t = (d) => t0 + d;
  return {
    rh: [
      [t(0), grip, 'hold'], [t(0.12), add(knob, [0.01, -0.012, 0.02, 0, 0, 0, -0.3])], [t(0.17), knob, 'hold'],
      [t(0.23), lifted, 'hold'], [t(0.32), back, 'hold'], [t(0.42), lifted, 'hold'], [t(0.47), knob, 'hold'],
      [t(0.6), add(grip, [0.006, -0.01, 0.012, 0, 0, 0, -0.4])], [t(0.68), grip, 'hold'],
    ],
    ch: [[t(0), [0, 0]], [t(0.17), [0, 0], 'hold'], [t(0.23), [0, 1], 'hold'], [t(0.32), [1, 1], 'hold'], [t(0.42), [0, 1], 'hold'], [t(0.47), [0, 0], 'hold']],
    // the gun comes up and rolls its right side toward the eye so the bolt shows
    gun: [
      [t(0), GUN0], [t(0.14), add(tilt, [0, -0.004, 0, -1, 1, -2])], [t(0.32), add(tilt, [0, 0.004, 0.008, 1, 0, 2])],
      [t(0.47), add(tilt, [0, 0, -0.004])], [t(0.68), GUN0],
    ],
    events: [
      [t(0.2), 'click'],
      [t(0.26), 'boltBack'],
      [t(0.3), 'eject'],
      [t(0.3), 'kick', { pos: [0, 0, 0.004], rot: [-0.6, -0.8, 0] }],
      [t(0.44), 'boltForward'],
      [t(0.47), 'kick', { pos: [0, 0.004, -0.006], rot: [1.2, 0.6, -1] }],
    ],
  };
}

function boltCycle(P, lhRest) {
  const b = boltWork(P, 0.14);
  return {
    name: 'bolt',
    duration: 0.86,
    readyAt: 0.78,
    tracks: {
      gun: new Track([[0, GUN0], [0.07, [0.002, 0.014, 0.024, 6, -1, 2]], ...b.gun, [0.86, GUN0]]),
      rh: new Track([[0, P.rightHand], ...b.rh, [0.86, P.rightHand]]),
      lh: new Track([[0, lhRest], [0.86, lhRest]]),
      ch: new Track([...b.ch, [0.86, [0, 0]]]),
    },
    events: b.events,
  };
}

/** Empty: tactical mag swap, then work the bolt to chamber a round. */
function boltReloadEmpty(P, lhRest) {
  const r = reload(P, lhRest);
  const T = r.duration - 0.1;
  const b = boltWork(P, T);
  const end = T + 0.82;
  const gunKeys = r.tracks.gun.keys.filter(([t]) => t < T);
  return {
    name: 'reloadEmpty',
    duration: end,
    readyAt: end - 0.1,
    tracks: {
      gun: new Track([...gunKeys, ...b.gun, [end, GUN0]]),
      lh: new Track([...r.tracks.lh.keys.filter(([t]) => t < T), [T, lhRest, 'hold'], [end, lhRest]]),
      rh: new Track([[0, P.rightHand], ...b.rh, [end, P.rightHand]]),
      ch: new Track([[0, [0, 0]], ...b.ch, [end, [0, 0]]]),
    },
    events: [...r.events, ...b.events],
  };
}

export function buildBoltClips(P, lhRest = P.lhRest) {
  return { ...buildClips(P, lhRest), bolt: boltCycle(P, lhRest), reloadEmpty: boltReloadEmpty(P, lhRest) };
}
