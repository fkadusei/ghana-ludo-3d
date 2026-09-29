# Ghana Ludo 3D

A 3D rebuild of [ghana-ludo](https://github.com/fkadusei/ghana-ludo) using three.js. Same 2–4 player rules, now on a
tabletop board with a kente-style border, lathe-turned pawns, a tumbling physical dice, shadows and capture/finish effects.

**Play it live: https://fkadusei.github.io/ghana-ludo-3d/**

## Run

ES modules need an HTTP origin (not `file://`), and three.js loads from the jsDelivr CDN, so you need internet access:

```bash
python3 -m http.server 8765
# open http://localhost:8765
```

## Structure

- `src/engine.js` – pure rules engine (track, blockades, captures, backward capture, turn order, save/restore). No DOM.
- `src/scene.js` – three.js view: board texture, pawns, dice, camera, tweens, particles, picking.
- `src/main.js` – HUD/controller: setup, starter draw, roll → select → animate → resolve turn flow, persistence.
- `src/audio.js` – WebAudio synthesized sound effects (from the 2D game).

## Controls

Drag to orbit, scroll/pinch to zoom, **Reset View** to recentre. Click the dice, the Roll button or press Space to roll;
click a glowing pawn to move it. Game state is saved to `localStorage` after each move.
