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

## Play vs Computer

**Play vs Computer** starts a solo game on your device: choose your color, 1–3 computer opponents and Easy or Normal
difficulty. Computers prefer captures, finishing pawns, leaving base and safe squares; **Easy** ones often pick any legal
move, and **Hard** ones also estimate the chance each move gets captured next turn (forward, backward and from-base
threats, ignoring safe squares and their own blockades) and steer their pawns out of danger. It reuses the online host
logic locally (no network), so the rules and camera behave exactly as in online rooms.

Solo games are saved after every move (including a rolled-but-unmoved choice), so reloading resumes where you left
off. **Leave Game** or finishing the game clears the save.

## Online multiplayer

Tap **Play Online** → **Create Room** and share the 5-letter code (or the invite link). Friends open the link, enter a
name and take an open seat; the host can set any seat to **Computer** or **Closed** and presses **Start Game**.

- Peer-to-peer over WebRTC (PeerJS). There is no game server: the host's browser is the authority (it rolls the dice
  and validates every move) and all players run the same deterministic engine, with periodic state snapshots to
  self-heal any drift.
- Each player's camera is rotated so their own yard is nearest them.
- If a player disconnects mid-game, a computer player covers for them; reopening the invite link in the same tab
  returns them to their seat.
- **Reactions:** the **React** button opens a tray of emoji and quick phrases. Messages are sent as indexes into fixed
  lists (no free text), rate-limited by the host, and pop up above the sender's yard for everyone.
- Matchmaking uses PeerJS's free public broker. By default only STUN is configured, so a few strict networks (some
  corporate or carrier NATs) cannot connect directly — see below.

### Relay (TURN) for strict networks

Free public TURN relays no longer exist, so a relay needs credentials only you can create. This repo is wired for
**Cloudflare Realtime TURN**: `functions/api/turn.js` is a Cloudflare Pages Function (`GET /api/turn`) that mints
short-lived credentials, and `src/config.js` points `TURN_CREDENTIALS_URL` at it. The API token lives only in
Cloudflare, never in the repo or the browser. Until it's configured (or on hosts without the function, such as
GitHub Pages) the endpoint returns an empty list and the game simply uses direct connections.

## Deploy to Cloudflare Pages (recommended)

1. **Create the TURN key:** Cloudflare dashboard → *Realtime* → *TURN Server* → create a key. Note the **Key ID** and
   **API token**.
2. **Create the Pages project:** *Workers & Pages* → *Create* → *Pages* → *Connect to Git* → pick this repo.
   Framework preset **None**, build command **empty**, build output directory **`/`**. Deploy.
3. **Add the secrets:** the Pages project → *Settings* → *Variables and Secrets* (Production): add `TURN_KEY_ID` and
   `TURN_KEY_API_TOKEN` (encrypt the token as a *Secret*), then redeploy so the function sees them.
4. **Custom domain:** the Pages project → *Custom domains* → *Set up a domain*. If the domain's DNS is on Cloudflare
   the DNS record and HTTPS certificate are created for you.
5. **Verify the relay:** open `https://YOUR-SITE/api/turn`. Directly in the address bar it should return JSON with
   `turn:` URLs (the response header `X-Relay` reads `ok`). If it returns `[]`, check `X-Relay`: `not-configured`
   means a variable is missing, `upstream-401/403` means a wrong Key ID or token.

Every push to `main` then redeploys automatically. HTTPS is required for sound, the copy-invite button and WebRTC.
The function only answers requests from the site itself (it rejects cross-site fetches) and credentials expire after
4 hours.

Local testing: `npx wrangler pages dev .` serves the site and function together (put test values in a git-ignored
`.dev.vars` file). Plain `python3 -m http.server` also works but has no `/api/turn`, which is fine: the game just
skips the relay.
