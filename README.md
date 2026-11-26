# Opus Magnum

Movement-first FPS in Three.js: wallrun, slide, auto-mantle and vault, five hand-animated weapons
(carbine, SMG, pump shotgun, pistol, bolt sniper) with an in-world gunsmith, items (heals, armour,
grenades, ammo), Team Deathmatch against bots, online 1v1 and a map editor, rendered cel-shaded with an
ink outline pass. The style direction lives in [Design.md](Design.md).

```bash
npm install
npm run dev        # http://localhost:5173  (append ?dev to skip the title/pointer lock for scripted testing, ?dev&mode=tdm for TDM, &map=<id> for a saved map, ?dev&mode=editor)
npm run build      # production bundle in dist/
node server/index.js   # match server for online play (ws://localhost:8787); node server/test.js tests it
```

## Controls
WASD move · Mouse look · Space jump / wall-jump · Shift sprint (toggle) · C or Ctrl crouch/slide ·
LMB fire · RMB aim · R reload · 1–5 or wheel switch weapon · B fire mode · F gunsmith · Tab scoreboard ·
E pick up / swap · T drop weapon · G throw grenade · V knife · Q heal · X charge armour · Esc or P pause/settings

## Items
Health is 150; armour adds 25 / 50 / 75 on top by tier (light, guard, heavy) and soaks damage first.
Health regenerates slowly after 8 s out of combat, so heals matter.

| Item | Use |
|---|---|
| Bandage | Q · +40 health in 2.4 s (carry 4) |
| Medkit | Q · full health in 5 s (carry 2). Q picks the bandage when it covers the wound |
| Armour charger | X · refills your vest in 3 s (carry 3) |
| Frag grenade | G · bounces, 2.4 s fuse, up to 135 damage within 6.5 m; it hurts you too (carry 2) |
| Ammo box | walk over it · +2 mags for each gun you carry |
| Armour | walk over it with no vest, E to upgrade |
| Guns | E to pick up (two at most; a third swaps out the one in your hands), T to drop |

Heals are cancelled by firing, aiming or switching weapons. The range lays every item out in front of the
spawn; TDM scatters them over the map (25 s respawn) and starts you with a carbine, a pistol, a grenade and
two bandages; online rounds put mirrored loot on Duel and reset it each round.

## Layout
```
src/
  main.js                 wiring + frame loop, weapon switching, item/pickup flow, dev handle (window.OM)
  core/                   engine-level pieces, no game knowledge
    renderer.js           world + viewmodel passes, outline composite (FX_LAYER skips outlines), quality presets
    toon.js               palette, cel materials (stepped rim), editor grid / sign text textures
    input.js              keyboard/mouse with per-frame edges, pointer lock
    audio.js              sample bank + synthesized layers (sub thump, brass, hit sounds, explosions, wind)
  world/
    testRange.js          the range: lane, wallrun, mantle, slide ramp, pillars (+ collision octree)
    dummies.js            static / strafing / orbiting targets with hit zones
    sky.js                painted sky, clouds, sun
  player/
    movement.js           ★ character controller — all tuning in MOVE
    cameraRig.js          look, recoil drain, FOV, bob, roll, landing/mantle feedback
    vitals.js             health + armour (soak, heal, regen); the server owns them online
  character/
    characters.js         playable robots (Rivet, Kite): build, first-person arms
    robot.js, kite.js     robot bodies, skeleton, arm IK, baking, box hit volumes per body segment
    avatar.js             a body in the world holding a gun: poses, flash, marker, death fall
                          (bots and online players both drive one)
  weapons/
    weapons.js            ★ weapon definitions: stats, recoil, hand poses, slots (start here)
    gunplay.js            ★ firing, fire modes, pellets, ADS, reload flow, spare ammo, recoil, damage
    attachments.js        ★ muzzles / optics / mags / grips / stocks: models + stats
    animations.js         ★ reload/equip/pump clips, built from each weapon's hand poses
    anim.js               Hermite-spline keyframe tracks + clip player
    viewmodel.js          pose layering (hip/ADS/sprint/sway/recoil), hands, inspect, attachment swaps
    melee.js              V knife: three swings (Catmull-Rom posed), sweeping hit test at the strike
    effects.js            tracers, decals, sparks, dust
    models/               parts.js (shared gun kit) + one file per gun
  items/
    items.js              ★ item definitions: kind, heal/armour numbers, carry limits, display (start here)
    inventory.js          ★ what you carry: guns, consumables, spare mags; use / throw / pick-up rules
    pickups.js            items and guns in the world: hover + ring, respawn, drops, claims (local or server)
    grenades.js           throw physics (bounces, ray-cast vs the octree), fuse, blast reach + falloff
    explosion.js          pooled cel-style blast: one lumpy, noise-shaped fireball with mottled banded fire
                          that cools to smoke; dust ring, embers, scorch
    handheld.js           first-person item in hand: heal / charge / throw poses, the knife swing
    models/               kit.js (shared materials) + one file per item, knife.js
  maps/                   maps, shared by every mode that plays one
    assets.js             ★ placeable pieces + prefab buildings, waterfront (dock, sea wall, stilt), pool,
                          item/gun pickups; connectors and adaptive road/sidewalk/dock tiles, rounded bends
    terrain.js            heightfield ground + sculpt brushes (raise/lower/smooth/flatten)
    mapWorld.js           saved map → playable world: batched draw calls, slim collision proxy, pickups,
                          water (map.water: a sheet at that height, and falling in kills), doors
    doors.js              working doors in every ground-level doorway: E opens away from you, solid to
                          movement and bullets, bots push through, synced online
    storage.js            maps in localStorage (om.maps) + the built-in ones
    builtin/              settlement.js ("Saltgrass" city); online rotation: duel.js ("Duel"),
                          lido.js ("Lido", villa round a drained pool), sluice.js ("Sluice", the water kills)
  modes/tdm/              Team Deathmatch, loaded only when picked (see below)
    tdm.js                match rules, player death/respawn, loadout, item spots, score
    arena.js              "Kiln" 5v5 map, point-symmetric (+ collision octree, nav grid)
    nav.js                layered walkable grid (floors, stairs, roofs) from the octree, A* + smoothing
    bot.js                bot AI on an Avatar (perception, reaction, aim error, cover)
  modes/editor/           map editor UI, loaded only when picked
    editor.js             grid, orbit camera, place/select/drag, inspector, undo, open/save UI
  net/
    online.js             online mode: remote players, poses, server-owned vitals, pickups, map vote
  ui/
    hud.js, hud.css       HUD (crosshair, ammo, loadout bar, hit markers) + shared styles (neo-brutalist)
    matchHud.js, .css     team match overlay (TDM + online): score, kill feed, hurt arrows, end screen
    vitalsHud.js, vitals.css   health + armour card, item chips, pickup prompt, item-use ring
    itemIcons.js, silhouettes.js   item icons / gun silhouettes rendered for the HUD
    gunsmith.js           in-world attachment editor
    title.js, lobby.js    title screen and its 3D character lobby
    menu.js, scoreboard.js   pause menu + settings, hold-Tab scoreboard
server/
  index.js                match server: rooms, gun-game rounds, HP/armour, pickups, relays
  test.js                 end-to-end test against a live server
public/audio/             CC0 sounds — see public/audio/CREDITS.md
tools/audio/              scripts used to slice the source recordings
```

Dependencies only point downward: `core` knows nothing about the game, `world`/`player`/`weapons`
build on `core`, `ui` reads game state, and `main.js` wires everything. Movement and gunplay never
import each other.

**Modes:** `MODES` in `main.js` lists what the title screen offers. Each builds a level
`{ octree, spawn, targets, update(), pickups?, loadout?, playerAlive?, hurtSelf?, onThrow?, ended? }` on demand. Team Deathmatch
(`src/modes/tdm/`), online play (`src/net/`) and the editor (`src/modes/editor/`) don't import each
other: delete a folder and its `MODES` entry to remove it. Maps live in `src/maps/` because all of
them use maps.

**Measurements:** pieces share one set of sizes (top of `maps/assets.js`): 4 m bays, 3.5 m storeys, a
walkable piece's top at its record's y, 1.3 × 2.3 m doorways, 0.25 m step rise, 1.2 m crates (two make a
container). Build new pieces from these so they meet the rest without steps.

**Damage:** the head takes each gun's `headMultiplier`, the chest ×1, legs ×0.72 (`ZONE` in `weapons.js`);
`stats.falloff` eases damage down with distance (steep for the SMG, almost none for the sniper).

**Adding an editor piece:** write a `build(color)` in `maps/assets.js` (origin on the floor, forward −Z,
flat colours from `mat()`) and list it in `ASSETS`; it gets a library thumbnail and collision
automatically.

**Adding a weapon:** write a model in `weapons/models/` (scale it with an inner body group if
needed), add a definition to `weapons.js`, and give it a fire sound in `core/audio.js`. It shows up as an
editor pickup (`gun_<id>`) on its own.

**Adding an item:** write a model in `items/models/` (origin on the floor, front −Z) and add it to `ITEMS`
in `items/items.js` with a kind the inventory knows (heal, charge, throw, ammo, armour). It becomes a
pickup, an editor piece (`item_<id>`) and, for heal / charge / throw, needs a hand pose in `handheld.js`.
Heal amounts and armour tiers are mirrored in `server/index.js`.

**Dev handle:** with `?dev`, `window.OM` exposes the live game (`OM.gun`, `OM.vm`, `OM.mv`, …).
`OM.step(n)` advances the sim n frames; set `OM.frozen = true` so only `OM.step` advances it
(frame-exact checks and screenshots).
