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
- `src/net.js` – peer-to-peer transport (WebRTC via PeerJS) for online rooms.
- `src/audio.js` – WebAudio synthesized sound effects (from the 2D game).

## Controls

Drag to orbit, scroll/pinch to zoom, **Reset View** (or double-tap empty space on touch) to recentre. On phones: one finger orbits, two fingers pinch/twist, taps snap to the nearest movable pawn, the round Roll button sits under your thumb, and rolls/captures give haptic feedback. Click the dice, the Roll button or press Space to roll;
click a glowing pawn to move it. Game state is saved to `localStorage` after each move.

## Online multiplayer

Tap **Play Online** → **Create Room** and share the 5-letter code (or the invite link). Friends open the link, enter a
name and take an open seat; the host can set any seat to **Computer** or **Closed** and presses **Start Game**.

- Peer-to-peer over WebRTC (PeerJS). There is no game server: the host's browser is the authority (it rolls the dice
  and validates every move) and all players run the same deterministic engine, with periodic state snapshots to
  self-heal any drift.
- Each player's camera is rotated so their own yard is nearest them.
- If a player disconnects mid-game, a computer player covers for them; reopening the invite link in the same tab
  returns them to their seat.
- Limitation: only STUN is configured (no TURN relay), so a few strict networks (some corporate or carrier NATs)
  cannot connect directly. Matchmaking uses PeerJS's free public broker.
