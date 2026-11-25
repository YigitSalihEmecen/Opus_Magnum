# Opus Magnum — Test Range

Movement-first FPS prototype in Three.js: wallrun, slide, auto-mantle and four hand-animated weapons
(carbine, SMG, pump shotgun, pistol) with an in-world gunsmith, rendered cel-shaded with an ink
outline pass. The style direction lives in [Design.md](Design.md).

```bash
npm install
npm run dev        # http://localhost:5173  (append ?dev to skip the title/pointer lock for scripted testing, ?dev&mode=tdm for TDM, &map=<id> for a saved map, ?dev&mode=editor)
npm run build      # production bundle in dist/
```

## Controls
WASD move · Mouse look · Space jump / wall-jump · Shift sprint (toggle) · C or Ctrl crouch/slide ·
LMB fire · RMB aim · R reload · 1–4 or wheel switch weapon · B fire mode · F gunsmith · Esc or P pause/settings

## Layout
```
src/
  main.js                 wiring + frame loop, weapon switching, dev handle (window.OM)
  core/                   engine-level pieces, no game knowledge
    renderer.js           world + viewmodel passes, outline composite (FX_LAYER skips outlines)
    toon.js               palette, cel materials (stepped rim), grid/text textures
    input.js              keyboard/mouse with per-frame edges, pointer lock
    audio.js              sample bank + synthesized layers (sub thump, brass, hit ticks, wind)
  world/
    testRange.js          the range: lane, wallrun, mantle, slide ramp, pillars (+ collision octree)
    dummies.js            static / strafing / orbiting targets with hit zones
  modes/tdm/              Team Deathmatch, loaded only when picked (see below)
    tdm.js                match rules, player health/respawn, score, TDM HUD overlay
    arena.js              "Kiln" 5v5 map, point-symmetric (+ collision octree, nav grid)
    nav.js                layered walkable grid (floors, stairs, roofs) from the octree, A* + smoothing
    bot.js                bot body/animation + AI (perception, reaction, aim error, cover)
  modes/editor/           map editor, loaded only when picked
    editor.js             grid, orbit camera, place/select/drag, inspector, undo, open/save UI
    assets.js             ★ placeable pieces + prefab buildings; connectors (pillars/posts) and adaptive
                          road/sidewalk tiles, rounded bends; world-aligned grid UVs
    terrain.js            heightfield ground + sculpt brushes (raise/lower/smooth/flatten)
    mapWorld.js           saved map → playable world: batched draw calls, slim collision proxy, outer hills
    maps/settlement.js    "Saltgrass", the built-in 192 m city (generated from the kit)
    storage.js            maps in localStorage (om.maps)
  player/
    movement.js           ★ character controller — all tuning in MOVE
    cameraRig.js          look, recoil drain, FOV, bob, roll, landing/mantle feedback
  weapons/
    weapons.js            ★ weapon definitions: stats, recoil, hand poses, slots (start here)
    gunplay.js            ★ firing, fire modes, pellets, ADS, reload flow, recoil, damage
    attachments.js        ★ muzzles / optics / mags / grips / stocks: models + stats
    animations.js         ★ reload/equip/pump clips, built from each weapon's hand poses
    anim.js               Hermite-spline keyframe tracks + clip player
    viewmodel.js          pose layering (hip/ADS/sprint/sway/recoil), hands, inspect, attachment swaps
    arms.js               gloved hands + forearms
    effects.js            tracers, decals, sparks, dust
    models/
      parts.js            shared materials + gun kit (fire controls, grip, rail, irons, mounts)
      panther.js          Panther carbine
      snake.js            Snake SMG
      grizzly.js          Grizzly pump shotgun (shell-by-shell loading, toss on empty)
      lynx.js             Lynx pistol (semi / 3-round burst)
  ui/
    hud.js, hud.css       HUD + gunsmith styles (neo-brutalist)
    gunsmith.js           in-world attachment editor
    title.js              title screen: pick a mode
    menu.js               pause menu and settings
public/audio/             CC0 sounds — see public/audio/CREDITS.md
tools/audio/              scripts used to slice the source recordings
```

Dependencies only point downward: `core` knows nothing about the game, `world`/`player`/`weapons`
build on `core`, `ui` reads game state, and `main.js` wires everything. Movement and gunplay never
import each other.

**Modes:** `MODES` in `main.js` lists what the title screen offers. Each builds a level
`{ octree, spawn, targets, update(), playerAlive?, ended? }` on demand. To remove Team Deathmatch,
delete `src/modes/tdm/` and its `MODES` entry; nothing else imports it. To remove the editor, delete
`src/modes/editor/`, its `MODES` entry, `customWorld` and the storage import in `main.js`.

**Adding an editor piece:** write a `build(color)` in `modes/editor/assets.js` (origin on the floor,
forward −Z) and list it in `ASSETS`; it gets a library thumbnail and collision automatically.

**Adding a weapon:** write a model in `weapons/models/` (scale it with an inner body group if
needed), add a definition to `weapons.js`, and give it a fire sound in `core/audio.js`.

**Dev handle:** with `?dev`, `window.OM` exposes the live game (`OM.gun`, `OM.vm`, `OM.mv`, …).
`OM.step(n)` advances the sim n frames; set `OM.frozen = true` so only `OM.step` advances it
(frame-exact checks and screenshots).
