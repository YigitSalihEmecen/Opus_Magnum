# Opus Magnum — Test Range

Movement-first FPS prototype in Three.js: wallrun, slide, auto-mantle and four hand-animated weapons
(carbine, SMG, pump shotgun, pistol) with an in-world gunsmith, rendered cel-shaded with an ink
outline pass. The style direction lives in [Design.md](Design.md).

```bash
npm install
npm run dev        # http://localhost:5173  (append ?dev to skip the menu/pointer lock for scripted testing)
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
    menu.js               start / pause menu and settings
public/audio/             CC0 sounds — see public/audio/CREDITS.md
tools/audio/              scripts used to slice the source recordings
```

Dependencies only point downward: `core` knows nothing about the game, `world`/`player`/`weapons`
build on `core`, `ui` reads game state, and `main.js` wires everything. Movement and gunplay never
import each other.

**Adding a weapon:** write a model in `weapons/models/` (scale it with an inner body group if
needed), add a definition to `weapons.js`, and give it a fire sound in `core/audio.js`.

**Dev handle:** with `?dev`, `window.OM` exposes the live game (`OM.gun`, `OM.vm`, `OM.mv`, …).
`OM.step(n)` advances the sim n frames; set `OM.frozen = true` so only `OM.step` advances it
(frame-exact checks and screenshots).
