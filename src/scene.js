/**
 * Three.js view layer. Owns the renderer, board, pawns and dice.
 * It never mutates game rules — it reads token state from the engine and animates to match.
 *
 * World mapping: board cell (row, col) has its center at x = col - 7, z = row - 7; the board top is y = 0.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { PATH, SIZE } from "./engine.js";

const COLORS = { blue: 0x2b5fd0, red: 0xe03a3a, yellow: 0xf2c230, green: 0x2f9e63 };
// Pawns use deeper shades than the board so they stand out against their own yard.
const PAWN_COLORS = { blue: 0x102f7a, red: 0x861219, yellow: 0x9c6f00, green: 0x0d5730 }
const RIM_COLORS = { blue: 0xbcd0ff, red: 0xffc4c4, yellow: 0xfff0b0, green: 0xbdf0d3 };
const CSS = { blue: "#2b5fd0", red: "#e03a3a", yellow: "#f2c230", green: "#2f9e63" };
const CSS_DARK = { blue: "#1a3a8a", red: "#9c1f1f", yellow: "#b98a0a", green: "#1c6b40" };

// Yard centers in world (x, z); yard slots sit at +-1 around them.
const YARD = { blue: [-4.5, -4.5], red: [4.5, -4.5], yellow: [-4.5, 4.5], green: [4.5, 4.5] };
const SLOT_OFFSETS = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
// Where finished pawns sit inside each color's center triangle (x, z).
const HOME_ANCHOR = { blue: [-0.75, 0], red: [0, -0.75], green: [0.75, 0], yellow: [0, 0.75] };

const DICE_HOME = new THREE.Vector3(0, 0.55 - 0.02, 10.2);
const DICE_SIZE = 1.15;
// Face normals (local space) for each pip value; opposite faces sum to 7.
const DICE_FACES = [
  { v: 3, n: [1, 0, 0] }, { v: 4, n: [-1, 0, 0] },
  { v: 1, n: [0, 1, 0] }, { v: 6, n: [0, -1, 0] },
  { v: 2, n: [0, 0, 1] }, { v: 5, n: [0, 0, -1] },
];

const TOTAL_BOARD = 16.6; // 15 cells + kente border
const cellWorld = (row, col) => new THREE.Vector3(col - 7, 0, row - 7);
const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);

// ---------------------------------------------------------------------------
// Procedural textures
// ---------------------------------------------------------------------------

function star(ctx, cx, cy, outer, inner, fill) {
  ctx.beginPath();
  for (let i = 0; i < 10; i += 1) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

/** Kente-inspired woven border, drawn as two staggered bands of colored blocks. */
function drawKenteBorder(ctx, N, U) {
  const palette = ["#f2c230", "#c8281e", "#1f7a3d", "#141010"];
  ctx.fillStyle = "#141010";
  ctx.fillRect(0, 0, N, N);
  const bands = [
    { from: 0.06, to: 0.36, shift: 0 },
    { from: 0.44, to: 0.74, shift: 2 },
  ];
  const block = 0.42 * U;
  bands.forEach(({ from, to, shift }) => {
    const a = from * U;
    const w = (to - from) * U;
    const count = Math.ceil(N / block);
    for (let k = 0; k < count; k += 1) {
      const col = palette[(k + shift) % palette.length];
      const p = k * block;
      ctx.fillStyle = col;
      ctx.fillRect(p, a, block, w); // top
      ctx.fillRect(p, N - a - w, block, w); // bottom
      ctx.fillRect(a, p, w, block); // left
      ctx.fillRect(N - a - w, p, w, block); // right
      // small woven accent
      ctx.fillStyle = palette[(k + shift + 2) % palette.length];
      const s = w * 0.28;
      const o = (w - s) / 2;
      ctx.fillRect(p + (block - s) / 2, a + o, s, s);
      ctx.fillRect(p + (block - s) / 2, N - a - w + o, s, s);
      ctx.fillRect(a + o, p + (block - s) / 2, s, s);
      ctx.fillRect(N - a - w + o, p + (block - s) / 2, s, s);
    }
  });
  // Clean corner squares with a black star (Ghana).
  const corner = 0.8 * U;
  [[0, 0], [N - corner, 0], [0, N - corner], [N - corner, N - corner]].forEach(([x, y]) => {
    ctx.fillStyle = "#141010";
    ctx.fillRect(x, y, corner, corner);
    ctx.strokeStyle = "#f2c230";
    ctx.lineWidth = U * 0.05;
    ctx.strokeRect(x + U * 0.08, y + U * 0.08, corner - U * 0.16, corner - U * 0.16);
    star(ctx, x + corner / 2, y + corner / 2, U * 0.27, U * 0.11, "#f2c230");
  });
  // Gold line where the border meets the board.
  ctx.strokeStyle = "#f2c230";
  ctx.lineWidth = U * 0.05;
  ctx.strokeRect(0.78 * U, 0.78 * U, N - 1.56 * U, N - 1.56 * U);
}

function makeBoardTexture(game, renderer) {
  const N = 4096;
  const U = N / TOTAL_BOARD;
  const M = ((TOTAL_BOARD - SIZE) / 2) * U;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = N;
  const ctx = canvas.getContext("2d");
  const g = (v) => M + v * U; // grid-line coordinate -> px

  drawKenteBorder(ctx, N, U);

  // Playing field
  ctx.fillStyle = "#f7f1e3";
  ctx.fillRect(g(0), g(0), SIZE * U, SIZE * U);

  // Yards
  const yardOrigin = { blue: [0, 0], red: [9, 0], yellow: [0, 9], green: [9, 9] };
  Object.entries(yardOrigin).forEach(([color, [x0, y0]]) => {
    ctx.fillStyle = CSS[color];
    ctx.fillRect(g(x0), g(y0), 6 * U, 6 * U);
    ctx.fillStyle = "#f7f1e3";
    ctx.beginPath();
    ctx.roundRect(g(x0 + 0.9), g(y0 + 0.9), 4.2 * U, 4.2 * U, 0.35 * U);
    ctx.fill();
    ctx.lineWidth = U * 0.06;
    ctx.strokeStyle = CSS_DARK[color];
    ctx.stroke();
    SLOT_OFFSETS.forEach(([dx, dz]) => {
      const cx = g(x0 + 3 + dx);
      const cy = g(y0 + 3 + dz);
      ctx.beginPath();
      ctx.arc(cx, cy, 0.5 * U, 0, Math.PI * 2);
      ctx.fillStyle = CSS_DARK[color];
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, 0.4 * U, 0, Math.PI * 2);
      ctx.fillStyle = CSS[color];
      ctx.fill();
    });
    ctx.lineWidth = U * 0.05;
    ctx.strokeStyle = "#222";
    ctx.strokeRect(g(x0), g(y0), 6 * U, 6 * U);
  });

  const cell = (r, c, fill) => {
    ctx.fillStyle = fill;
    ctx.fillRect(g(c), g(r), U, U);
    ctx.lineWidth = U * 0.03;
    ctx.strokeStyle = "#2a2622";
    ctx.strokeRect(g(c), g(r), U, U);
  };

  // Track
  PATH.forEach(([r, c]) => cell(r, c, "#fffdf7"));
  // Home lanes
  game.players.forEach((p) => {
    p.homeLane.slice(0, -1).forEach(([r, c]) => cell(r, c, CSS[p.color]));
  });
  // Start squares
  game.players.forEach((p) => {
    const [r, c] = p.startCoord;
    cell(r, c, CSS[p.color]);
    star(ctx, g(c) + U / 2, g(r) + U / 2, U * 0.36, U * 0.15, "rgba(255,255,255,0.9)");
  });
  // Other safe squares
  game.safeIndices.forEach((idx) => {
    if (game.players.some((p) => p.startIndex === idx)) return;
    const [r, c] = PATH[idx];
    star(ctx, g(c) + U / 2, g(r) + U / 2, U * 0.34, U * 0.14, "#8d8676");
  });

  // Entry arrows (direction into the home lane)
  const arrows = [
    { color: "blue", r: 7, c: 0, dx: 1, dz: 0 },
    { color: "red", r: 0, c: 7, dx: 0, dz: 1 },
    { color: "green", r: 7, c: 14, dx: -1, dz: 0 },
    { color: "yellow", r: 14, c: 7, dx: 0, dz: -1 },
  ];
  arrows.forEach(({ color, r, c, dx, dz }) => {
    const cx = g(c) + U / 2;
    const cy = g(r) + U / 2;
    cell(r, c, "#fffdf7");
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.atan2(dz, dx));
    ctx.fillStyle = CSS_DARK[color];
    ctx.beginPath();
    ctx.moveTo(U * 0.34, 0);
    ctx.lineTo(-U * 0.1, -U * 0.3);
    ctx.lineTo(-U * 0.1, -U * 0.11);
    ctx.lineTo(-U * 0.36, -U * 0.11);
    ctx.lineTo(-U * 0.36, U * 0.11);
    ctx.lineTo(-U * 0.1, U * 0.11);
    ctx.lineTo(-U * 0.1, U * 0.3);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  });

  // Center: four colored triangles meeting at (7.5, 7.5)
  const tri = (color, pts) => {
    ctx.beginPath();
    ctx.moveTo(g(pts[0][0]), g(pts[0][1]));
    ctx.lineTo(g(pts[1][0]), g(pts[1][1]));
    ctx.lineTo(g(7.5), g(7.5));
    ctx.closePath();
    ctx.fillStyle = CSS[color];
    ctx.fill();
    ctx.lineWidth = U * 0.04;
    ctx.strokeStyle = "#2a2622";
    ctx.stroke();
  };
  tri("blue", [[6, 6], [6, 9]]);
  tri("red", [[6, 6], [9, 6]]);
  tri("green", [[9, 6], [9, 9]]);
  tri("yellow", [[6, 9], [9, 9]]);
  ctx.lineWidth = U * 0.05;
  ctx.strokeStyle = "#222";
  ctx.strokeRect(g(6), g(6), 3 * U, 3 * U);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

function makeDiceFaceTexture(value) {
  const S = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d");
  const grad = ctx.createLinearGradient(0, 0, S, S);
  grad.addColorStop(0, "#fffdf7");
  grad.addColorStop(1, "#e9e2d2");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, S, S);
  const layouts = {
    1: [[1, 1]],
    2: [[0, 0], [2, 2]],
    3: [[0, 0], [1, 1], [2, 2]],
    4: [[0, 0], [2, 0], [0, 2], [2, 2]],
    5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]],
    6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]],
  };
  layouts[value].forEach(([cx, cy]) => {
    const x = S * (0.24 + cx * 0.26);
    const y = S * (0.24 + cy * 0.26);
    ctx.beginPath();
    ctx.arc(x, y, S * (value === 1 ? 0.13 : 0.085), 0, Math.PI * 2);
    ctx.fillStyle = value === 1 ? "#c8281e" : "#1b1b1b";
    ctx.fill();
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Procedural wood grain (seamless in x; good enough vertically). */
function makeWoodTexture(renderer, { base, repeat }) {
  const S = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 1100; i += 1) {
    const y = Math.random() * S;
    const phase = Math.random() * 6;
    const wave = 1 + Math.random() * 4;
    ctx.strokeStyle =
      Math.random() < 0.55
        ? `rgba(0,0,0,${0.03 + Math.random() * 0.09})`
        : `rgba(255,215,160,${0.02 + Math.random() * 0.06})`;
    ctx.lineWidth = 0.5 + Math.random() * 2.6;
    ctx.beginPath();
    for (let x = 0; x <= S; x += 32) {
      const yy = y + Math.sin((x / S) * Math.PI * 2 * 2 + phase) * wave;
      if (x === 0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

/** Soft radial blob used as a cheap contact shadow under pawns. */
function makeBlobTexture() {
  const S = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, "rgba(0,0,0,0.65)");
  g.addColorStop(0.55, "rgba(0,0,0,0.25)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(canvas);
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

export function createScene(container, game, { onTokenClick, onDiceClick }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.3;

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE };
  controls.rotateSpeed = 0.7;
  controls.minDistance = 9;
  controls.maxDistance = 90;
  controls.minPolarAngle = 0.15;
  controls.maxPolarAngle = 1.38;
  controls.target.set(0, 0, 2);

  // Lights
  scene.add(new THREE.HemisphereLight(0xfff4e0, 0x3a2a20, 0.55));
  const sun = new THREE.DirectionalLight(0xffefd6, 2.1);
  sun.position.set(-7, 16, 9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, { left: -13, right: 13, top: 13, bottom: -13, near: 1, far: 50 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);

  // Cool fill + warm rim so form reads on the dark side of pawns
  const fill = new THREE.DirectionalLight(0xaec6ff, 0.55);
  fill.position.set(9, 7, -8);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffd6a0, 0.7);
  rim.position.set(0, 5, -14);
  scene.add(rim);
  scene.fog = new THREE.Fog(0x1a110c, 130, 300);

  // Table (wood)
  const tableTex = makeWoodTexture(renderer, { base: "#3b281c", repeat: 7 });
  const table = new THREE.Mesh(
    new THREE.CircleGeometry(70, 64),
    new THREE.MeshStandardMaterial({ map: tableTex, bumpMap: tableTex, bumpScale: 0.6, roughness: 0.55, metalness: 0 })
  );
  table.rotation.x = -Math.PI / 2;
  table.position.y = -0.62;
  table.receiveShadow = true;
  scene.add(table);

  // Board: varnished top with relief, bevelled hardwood frame
  const boardTex = makeBoardTexture(game, renderer);
  const frameTex = makeWoodTexture(renderer, { base: "#6b4327", repeat: 1 });
  const wood = new THREE.MeshPhysicalMaterial({ map: frameTex, bumpMap: frameTex, bumpScale: 0.4, roughness: 0.4, clearcoat: 0.5, clearcoatRoughness: 0.3 });
  const top = new THREE.MeshPhysicalMaterial({
    map: boardTex,
    bumpMap: boardTex,
    bumpScale: 1.2,
    roughness: 0.42,
    metalness: 0,
    clearcoat: 0.2,
    clearcoatRoughness: 0.25,
  });
  const boardMesh = new THREE.Mesh(new RoundedBoxGeometry(TOTAL_BOARD, 0.6, TOTAL_BOARD, 4, 0.1), [wood, wood, top, wood, wood, wood]);
  boardMesh.position.y = -0.3;
  boardMesh.receiveShadow = true;
  boardMesh.castShadow = true;
  scene.add(boardMesh);

  // Gold trim where the border meets the playing field, and gold nest rings in each yard
  const gold = new THREE.MeshStandardMaterial({ color: 0xd4a52a, metalness: 0.95, roughness: 0.28 });
  const trimLen = SIZE + 0.16;
  [[0, -7.58, trimLen, 0.1], [0, 7.58, trimLen, 0.1], [-7.58, 0, 0.1, trimLen], [7.58, 0, 0.1, trimLen]].forEach(([x, z, w, d]) => {
    const trim = new THREE.Mesh(new THREE.BoxGeometry(w, 0.07, d), gold);
    trim.position.set(x, 0.03, z);
    trim.castShadow = true;
    scene.add(trim);
  });
  const nestGeo = new THREE.TorusGeometry(0.47, 0.035, 10, 40);
  Object.values(YARD).forEach(([yx, yz]) => {
    SLOT_OFFSETS.forEach(([dx, dz]) => {
      const nest = new THREE.Mesh(nestGeo, gold);
      nest.rotation.x = Math.PI / 2;
      nest.position.set(yx + dx, 0.03, yz + dz);
      scene.add(nest);
    });
  });

  // Felt dice tray
  const tray = new THREE.Group();
  const felt = new THREE.Mesh(
    new THREE.CylinderGeometry(2.3, 2.3, 0.1, 64),
    new THREE.MeshStandardMaterial({ color: 0x1d4a34, roughness: 1, metalness: 0 })
  );
  felt.receiveShadow = true;
  const trayRim = new THREE.Mesh(new THREE.TorusGeometry(2.3, 0.08, 12, 64), gold);
  trayRim.rotation.x = Math.PI / 2;
  trayRim.position.y = 0.05;
  tray.add(felt, trayRim);
  tray.position.set(DICE_HOME.x, -0.62 + 0.05, DICE_HOME.z);
  const diceRig = new THREE.Group(); // rotates with the camera so the tray stays in front of the viewer
  scene.add(diceRig);
  diceRig.add(tray);

  // Turn glow over each yard
  const glows = {};
  Object.entries(YARD).forEach(([color, [x, z]]) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(6, 6),
      new THREE.MeshBasicMaterial({
        color: COLORS[color],
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.02, z);
    scene.add(m);
    glows[color] = m;
  });

  // Dice ----------------------------------------------------------------
  const dice = new THREE.Mesh(
    new RoundedBoxGeometry(DICE_SIZE, DICE_SIZE, DICE_SIZE, 5, 0.15),
    // material order matches BoxGeometry: +x, -x, +y, -y, +z, -z
    DICE_FACES.map(({ v }) => new THREE.MeshPhysicalMaterial({
      map: makeDiceFaceTexture(v),
      roughness: 0.28,
      clearcoat: 0.6,
      clearcoatRoughness: 0.2,
    }))
  );
  dice.castShadow = true;
  dice.position.copy(DICE_HOME);
  diceRig.add(dice);
  const diceRing = new THREE.Mesh(
    new THREE.RingGeometry(0.95, 1.2, 48),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
  );
  diceRing.rotation.x = -Math.PI / 2;
  diceRing.position.set(DICE_HOME.x, -0.46, DICE_HOME.z);
  diceRig.add(diceRing);
  let diceEnabled = false;
  let dicePlayerColor = "blue";
  let diceRolling = false;
  const UP = new THREE.Vector3(0, 1, 0);

  function diceQuat(value, yaw) {
    const face = DICE_FACES.find((f) => f.v === value);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(...face.n), UP);
    return new THREE.Quaternion().setFromAxisAngle(UP, yaw).multiply(q);
  }
  dice.quaternion.copy(diceQuat(1, 0.4));

  // Pawns ---------------------------------------------------------------
  const pawnProfile = [
    [0, 0], [0.34, 0], [0.36, 0.04], [0.31, 0.1], [0.21, 0.19], [0.15, 0.3],
    [0.125, 0.44], [0.2, 0.49], [0.2, 0.54], [0.12, 0.58], [0, 0.58],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const pawnGeo = new THREE.LatheGeometry(pawnProfile, 40);
  const rimGeo = new THREE.TorusGeometry(0.33, 0.04, 12, 40);
  const collarGeo = new THREE.TorusGeometry(0.19, 0.03, 12, 32);
  const headGeo = new THREE.SphereGeometry(0.21, 32, 24);
  const ringGeo = new THREE.RingGeometry(0.44, 0.56, 40);
  const PAWN_SCALE = 0.9;
  const hitGeo = new THREE.CylinderGeometry(0.62, 0.62, 1.3, 12);
  const hitMat = new THREE.MeshBasicMaterial({ visible: false });
  const blobTex = makeBlobTexture();
  const blobGeo = new THREE.PlaneGeometry(1.5, 1.5);

  const meshes = new Map(); // token -> { root, body, ring, mat, target, busy }
  game.players.forEach((player) => {
    player.tokens.forEach((token) => {
      const mat = new THREE.MeshPhysicalMaterial({
        color: PAWN_COLORS[player.color],
        roughness: 0.32,
        metalness: 0.05,
        clearcoat: 0.7,
        clearcoatRoughness: 0.18,
        emissive: PAWN_COLORS[player.color],
        emissiveIntensity: 0,
      });
      const root = new THREE.Group();
      const body = new THREE.Group();
      const base = new THREE.Mesh(pawnGeo, mat);
      const head = new THREE.Mesh(headGeo, mat);
      head.position.y = 0.74;
      base.castShadow = head.castShadow = true;
      const rimMat = new THREE.MeshStandardMaterial({ color: RIM_COLORS[player.color], roughness: 0.3, metalness: 0.2 });
      const rim = new THREE.Mesh(rimGeo, rimMat);
      rim.rotation.x = Math.PI / 2;
      rim.position.y = 0.05;
      const collar = new THREE.Mesh(collarGeo, rimMat);
      collar.rotation.x = Math.PI / 2;
      collar.position.y = 0.52;
      body.add(base, head, rim, collar);
      body.scale.setScalar(PAWN_SCALE);
      const ring = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.03;
      ring.visible = false;
      const blob = new THREE.Mesh(
        blobGeo,
        new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, opacity: 0.55 })
      );
      blob.rotation.x = -Math.PI / 2;
      blob.position.y = 0.015;
      const hit = new THREE.Mesh(hitGeo, hitMat);
      hit.position.y = 0.55;
      root.add(blob, body, ring, hit);
      root.userData.token = token;
      scene.add(root);
      const entry = { root, body, ring, blob, mat, target: new THREE.Vector3(), busy: 0, scale: 1, scaleTarget: 1, squash: 0 };
      meshes.set(token, entry);
    });
  });

  // ---- layout -------------------------------------------------------------

  function slotPosition(token) {
    const [yx, yz] = YARD[token.player.color];
    const [dx, dz] = SLOT_OFFSETS[token.player.tokens.indexOf(token)];
    return new THREE.Vector3(yx + dx, 0, yz + dz);
  }

  function stackOffsets(n) {
    if (n === 1) return [[0, 0, 1]];
    if (n === 2) return [[-0.22, 0, 0.82], [0.22, 0, 0.82]];
    if (n === 3) return [[-0.24, -0.16, 0.74], [0.24, -0.16, 0.74], [0, 0.22, 0.74]];
    const cols = Math.ceil(Math.sqrt(n));
    const s = 0.62;
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const cx = (i % cols) - (cols - 1) / 2;
      const cz = Math.floor(i / cols) - (Math.ceil(n / cols) - 1) / 2;
      out.push([cx * 0.3, cz * 0.3, s]);
    }
    return out;
  }

  function layout() {
    const cells = new Map();
    game.players.forEach((player) => {
      player.tokens.forEach((token) => {
        const m = meshes.get(token);
        m.root.visible = player.enabled;
        if (!player.enabled) return;
        if (token.finished) {
          const idx = player.tokens.filter((t) => t.finished).indexOf(token);
          const [ax, az] = HOME_ANCHOR[player.color];
          const radial = new THREE.Vector2(ax, az).normalize();
          const tangent = new THREE.Vector2(-radial.y, radial.x);
          const t = (idx % 2 === 0 ? -1 : 1) * 0.3;
          const r = idx < 2 ? 0.28 : -0.12;
          m.target.set(ax + tangent.x * t + radial.x * r, 0, az + tangent.y * t + radial.y * r);
          m.scaleTarget = 0.55;
        } else if (token.steps === -1) {
          m.target.copy(slotPosition(token));
          m.scaleTarget = 1;
        } else {
          const [r, c] = game.coordFor(token);
          const key = `${r},${c}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(token);
        }
      });
    });
    cells.forEach((tokens, key) => {
      const [r, c] = key.split(",").map(Number);
      const center = cellWorld(r, c);
      const offs = stackOffsets(tokens.length);
      tokens.forEach((token, i) => {
        const m = meshes.get(token);
        m.target.set(center.x + offs[i][0], 0, center.z + offs[i][1]);
        m.scaleTarget = offs[i][2];
      });
    });
  }

  /** Jump every pawn straight to its target (used on load / restore). */
  function snap() {
    layout();
    meshes.forEach((m) => {
      m.root.position.copy(m.target);
      m.scale = m.scaleTarget;
    });
  }

  // ---- tweens / effects ------------------------------------------------------

  const tweens = new Set();
  function tween(duration, onUpdate) {
    return new Promise((resolve) => {
      tweens.add({ t: 0, duration, onUpdate, resolve });
    });
  }

  async function hopStep(token, duration = 0.2) {
    const m = meshes.get(token);
    m.busy += 1;
    const from = m.root.position.clone();
    const to = m.target.clone();
    await tween(duration, (k) => {
      const e = ease(k);
      m.root.position.lerpVectors(from, to, e);
      m.root.position.y = Math.sin(Math.PI * k) * 0.5;
    });
    m.root.position.copy(to);
    m.squash = 1;
    m.busy -= 1;
  }

  async function flyToBase(token) {
    const m = meshes.get(token);
    m.busy += 1;
    const from = m.root.position.clone();
    const to = slotPosition(token);
    m.target.copy(to);
    m.scaleTarget = 1;
    await tween(0.85, (k) => {
      const e = ease(k);
      m.root.position.lerpVectors(from, to, e);
      m.root.position.y = Math.sin(Math.PI * k) * 3.2;
      m.body.rotation.y = k * Math.PI * 4;
    });
    m.body.rotation.y = 0;
    m.root.position.copy(to);
    m.squash = 1.4;
    m.busy -= 1;
  }

  const bursts = [];
  function burst(position, colors, { count = 46, speed = 4.2, life = 1.2, size = 0.16 } = {}) {
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const vel = [];
    const c = new THREE.Color();
    for (let i = 0; i < count; i += 1) {
      pos.set([position.x, position.y + 0.4, position.z], i * 3);
      c.set(colors[i % colors.length]);
      col.set([c.r, c.g, c.b], i * 3);
      const a = Math.random() * Math.PI * 2;
      const up = 0.5 + Math.random();
      const s = speed * (0.35 + Math.random() * 0.65);
      vel.push(new THREE.Vector3(Math.cos(a) * s, up * speed * 0.9, Math.sin(a) * s));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({ size, vertexColors: true, transparent: true, depthWrite: false });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    scene.add(points);
    bursts.push({ points, geo, mat, vel, age: 0, life });
  }

  const shocks = [];
  function shockwave(position, color) {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.35, 0.5, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(position.x, 0.05, position.z);
    scene.add(mesh);
    shocks.push({ mesh, age: 0 });
  }

  function captureBurst(token) {
    const m = meshes.get(token);
    shockwave(m.root.position, 0xffffff);
    burst(m.root.position, [COLORS[token.player.color], 0xffffff, 0xffd166], { count: 40, speed: 3.6, life: 0.9 });
  }

  function celebrate(token) {
    const m = meshes.get(token);
    burst(m.root.position, [0xf2c230, 0xc8281e, 0x1f7a3d, 0xffffff, COLORS[token.player.color]], { count: 90, speed: 5.5, life: 1.6, size: 0.18 });
  }

  // ---- dice ----------------------------------------------------------------

  function setDiceFace(value) {
    if (!value) return;
    dice.quaternion.copy(diceQuat(value, 0.4));
    dice.position.copy(DICE_HOME);
  }

  function rollDice(value) {
    if (diceRolling) return Promise.resolve();
    diceRolling = true;
    const startQ = dice.quaternion.clone();
    const finalQ = diceQuat(value, Math.random() * Math.PI * 2);
    const axis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    const spin = Math.PI * (7 + Math.random() * 3);
    const from = dice.position.clone();
    from.y = DICE_HOME.y;
    const landing = DICE_HOME.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2.4, 0, (Math.random() - 0.5) * 1.2));
    const tmp = new THREE.Quaternion();
    const D = 1.35;
    return tween(D, (k) => {
      // ballistic toss, then two shrinking bounces
      let h;
      if (k < 0.62) h = 3.4 * 4 * (k / 0.62) * (1 - k / 0.62);
      else if (k < 0.82) h = 0.7 * 4 * ((k - 0.62) / 0.2) * (1 - (k - 0.62) / 0.2);
      else h = 0.18 * 4 * ((k - 0.82) / 0.18) * (1 - (k - 0.82) / 0.18);
      const travel = ease(Math.min(1, k / 0.82));
      dice.position.set(
        THREE.MathUtils.lerp(from.x, landing.x, travel),
        DICE_HOME.y + h,
        THREE.MathUtils.lerp(from.z, landing.z, travel)
      );
      const remaining = Math.pow(1 - k, 1.6);
      tmp.setFromAxisAngle(axis, spin * remaining);
      dice.quaternion.copy(tmp).multiply(k < 0.1 ? startQ.clone().slerp(finalQ, k / 0.1) : finalQ);
    }).then(() => {
      dice.quaternion.copy(finalQ);
      dice.position.copy(landing);
      diceRolling = false;
    });
  }

  // ---- state hooks from the UI controller ---------------------------------

  let selectable = new Set();
  function setSelectable(tokens) {
    selectable = new Set(tokens || []);
    meshes.forEach((m, token) => {
      m.ring.visible = selectable.has(token);
      m.ring.material.color.set(0xffffff);
    });
    updateCursor();
  }

  let activeColor = null;
  function setActivePlayer(player) {
    activeColor = player ? player.color : null;
    if (player) {
      dicePlayerColor = player.color;
      diceRing.material.color.set(COLORS[player.color]);
    }
  }

  function setDiceEnabled(on) {
    diceEnabled = !!on;
    updateCursor();
  }

  // ---- input --------------------------------------------------------------

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let hovered = null;
  let hoveringDice = false;

  function pick(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const roots = [...meshes.values()].filter((m) => m.root.visible).map((m) => m.root);
    const hits = raycaster.intersectObjects([...roots, dice], true);
    for (const hit of hits) {
      if (hit.object === dice) return { dice: true };
      let o = hit.object;
      while (o && !o.userData.token) o = o.parent;
      if (o) return { token: o.userData.token };
    }
    if (event.pointerType === "touch" && selectable.size) {
      // Fingers are imprecise: snap to the nearest movable pawn within ~1.1 cells of the touch point.
      const ground = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), ground)) {
        let best = null;
        let bestD = 1.1;
        selectable.forEach((token) => {
          const d = meshes.get(token).root.position.distanceTo(ground);
          if (d < bestD) {
            bestD = d;
            best = token;
          }
        });
        if (best) return { token: best };
      }
    }
    return {};
  }

  function updateCursor() {
    const interactive = (hovered && selectable.has(hovered)) || (hoveringDice && diceEnabled);
    renderer.domElement.style.cursor = interactive ? "pointer" : "grab";
  }

  renderer.domElement.addEventListener("pointermove", (event) => {
    if (event.buttons) return;
    const hit = pick(event);
    hovered = hit.token || null;
    hoveringDice = !!hit.dice;
    updateCursor();
  });

  let downAt = null;
  let lastTap = 0;
  renderer.domElement.addEventListener("pointerdown", (event) => {
    downAt = { x: event.clientX, y: event.clientY };
  });
  renderer.domElement.addEventListener("pointerup", (event) => {
    if (!downAt) return;
    const moved = Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y);
    downAt = null;
    if (moved > 5) return; // it was an orbit drag
    const hit = pick(event);
    if (hit.token && selectable.has(hit.token)) onTokenClick(hit.token);
    else if (hit.dice && diceEnabled) onDiceClick();
    else if (!hit.token && !hit.dice) {
      // double-tap on empty space recentres the camera
      const now = performance.now();
      if (now - lastTap < 320) resetView();
      lastTap = now;
    }
  });

  // ---- camera ---------------------------------------------------------------

  // Camera azimuth per seat: puts each player's own yard at the near-left of the screen.
  const SEAT_AZIMUTH = { yellow: 0, blue: -Math.PI / 2, red: Math.PI, green: Math.PI / 2 };
  let viewAzimuth = 0;

  function viewTarget() {
    return new THREE.Vector3(0, 0, 2).applyAxisAngle(UP, viewAzimuth);
  }

  function defaultCameraPosition() {
    const aspect = container.clientWidth / Math.max(1, container.clientHeight);
    const dist = Math.max(19.5, 10.2 / (Math.tan(THREE.MathUtils.degToRad(20)) * aspect));
    const polar = aspect < 0.8 ? 0.5 : 0.78; // steeper, more top-down view on tall phone screens
    const offset = new THREE.Vector3(0, Math.cos(polar) * dist, Math.sin(polar) * dist).applyAxisAngle(UP, viewAzimuth);
    return viewTarget().add(offset);
  }

  /** Orient the view (and dice tray) so the given seat sits nearest the viewer. */
  function setViewSeat(color) {
    const from = viewAzimuth;
    let to = SEAT_AZIMUTH[color] ?? 0;
    // take the short way round
    while (to - from > Math.PI) to -= Math.PI * 2;
    while (to - from < -Math.PI) to += Math.PI * 2;
    viewAzimuth = to;
    userMoved = false;
    const camFrom = camera.position.clone();
    const tgtFrom = controls.target.clone();
    const camTo = defaultCameraPosition();
    const tgtTo = viewTarget();
    return tween(0.9, (k) => {
      const e = ease(k);
      diceRig.rotation.y = THREE.MathUtils.lerp(from, to, e);
      camera.position.lerpVectors(camFrom, camTo, e);
      controls.target.lerpVectors(tgtFrom, tgtTo, e);
    });
  }

  function resetView() {
    const from = camera.position.clone();
    const fromT = controls.target.clone();
    const to = defaultCameraPosition();
    const toT = viewTarget();
    return tween(0.7, (k) => {
      const e = ease(k);
      camera.position.lerpVectors(from, to, e);
      controls.target.lerpVectors(fromT, toT, e);
    }).then(() => {
      userMoved = false;
    });
  }

  let userMoved = false;
  let introRunning = false;
  controls.addEventListener("start", () => {
    userMoved = true;
  });

  function resize() {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // keep the whole board framed after rotation / window resize unless the player took the camera
    if (!userMoved && !introRunning) camera.position.copy(defaultCameraPosition());
  }
  new ResizeObserver(resize).observe(container);
  resize();
  camera.position.copy(defaultCameraPosition());
  controls.update();

  /** Cinematic entrance: swoop down from a high, slightly rotated viewpoint. */
  function intro() {
    introRunning = true;
    const offset = new THREE.Vector3(-14, 16, 8);
    controls.enabled = false;
    return tween(2.4, (k) => {
      const e = 1 - Math.pow(1 - k, 3);
      const end = defaultCameraPosition(); // re-read each frame so a resize mid-swoop still lands framed
      camera.position.copy(end).addScaledVector(offset, 1 - e);
    }).then(() => {
      introRunning = false;
      controls.enabled = true;
    });
  }

  // ---- frame loop -------------------------------------------------------------

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const rawDt = clock.getDelta();
    const dt = Math.min(rawDt, 0.05);
    const tdt = Math.min(rawDt, 0.25); // tweens follow real time so slow frames don't stretch animations
    const time = clock.elapsedTime;

    tweens.forEach((tw) => {
      tw.t += tdt;
      const k = Math.min(1, tw.t / tw.duration);
      tw.onUpdate(k);
      if (k >= 1) {
        tweens.delete(tw);
        tw.resolve();
      }
    });

    const follow = 1 - Math.exp(-14 * dt);
    meshes.forEach((m, token) => {
      if (!m.busy) m.root.position.lerp(m.target, follow);
      m.scale += (m.scaleTarget - m.scale) * follow;
      const isSel = selectable.has(token);
      const isHover = isSel && hovered === token;
      const bob = isSel ? Math.abs(Math.sin(time * 5)) * 0.18 : 0;
      m.body.position.y = bob;
      m.squash *= Math.exp(-11 * dt);
      const k = PAWN_SCALE * m.scale * (isHover ? 1.14 : 1);
      m.body.scale.set(k * (1 + 0.14 * m.squash), k * (1 - 0.2 * m.squash), k * (1 + 0.14 * m.squash));
      // contact shadow stays on the board and fades / widens as the pawn lifts
      const lift = m.root.position.y;
      m.blob.position.y = 0.015 - lift;
      m.blob.scale.setScalar(m.scale * (1 + lift * 0.35));
      m.blob.material.opacity = 0.55 / (1 + lift * 1.4);
      m.mat.emissiveIntensity = isSel ? 0.25 + 0.2 * Math.sin(time * 6) : 0;
      if (m.ring.visible) {
        const s = m.scale * (1 + 0.12 * Math.sin(time * 6));
        m.ring.scale.setScalar(s);
        m.ring.material.opacity = 0.65 + 0.3 * Math.sin(time * 6);
      }
    });

    Object.entries(glows).forEach(([color, mesh]) => {
      const on = color === activeColor;
      const goal = on ? 0.16 + 0.12 * Math.sin(time * 3.2) : 0;
      mesh.material.opacity += (goal - mesh.material.opacity) * follow;
    });

    diceRing.material.opacity += ((diceEnabled ? 0.55 + 0.3 * Math.sin(time * 4) : 0) - diceRing.material.opacity) * follow;
    if (!diceRolling) {
      diceRing.position.x = dice.position.x;
      diceRing.position.z = dice.position.z;
    }
    if (diceEnabled && !diceRolling) {
      dice.position.y = DICE_HOME.y + 0.07 * Math.sin(time * 3);
    }

    for (let i = bursts.length - 1; i >= 0; i -= 1) {
      const b = bursts[i];
      b.age += dt;
      const arr = b.geo.attributes.position.array;
      b.vel.forEach((v, j) => {
        v.y -= 9.8 * dt;
        arr[j * 3] += v.x * dt;
        arr[j * 3 + 1] += v.y * dt;
        arr[j * 3 + 2] += v.z * dt;
      });
      b.geo.attributes.position.needsUpdate = true;
      b.mat.opacity = Math.max(0, 1 - b.age / b.life);
      if (b.age >= b.life) {
        scene.remove(b.points);
        b.geo.dispose();
        b.mat.dispose();
        bursts.splice(i, 1);
      }
    }

    for (let i = shocks.length - 1; i >= 0; i -= 1) {
      const sh = shocks[i];
      sh.age += dt;
      const k = sh.age / 0.7;
      sh.mesh.scale.setScalar(1 + k * 5);
      sh.mesh.material.opacity = Math.max(0, 0.9 * (1 - k));
      if (k >= 1) {
        scene.remove(sh.mesh);
        sh.mesh.geometry.dispose();
        sh.mesh.material.dispose();
        shocks.splice(i, 1);
      }
    }

    controls.update();
    renderer.render(scene, camera);
  });

  return {
    layout, snap, hopStep, flyToBase, captureBurst, celebrate,
    rollDice, setDiceFace, setSelectable, setActivePlayer, setDiceEnabled, resetView, setViewSeat, intro,
    celebrateAll() {
      [[-4, 0], [4, 0], [0, -4], [0, 4], [0, 0]].forEach(([x, z], i) =>
        setTimeout(() => burst(new THREE.Vector3(x, 0, z), [0xf2c230, 0xc8281e, 0x1f7a3d, 0xffffff, 0x2b5fd0], { count: 120, speed: 7, life: 2, size: 0.2 }), i * 260));
    },
    get diceRolling() { return diceRolling; },
    // exposed for debugging / tests
    _debug: { camera, controls, meshes, dice },
  };
}
