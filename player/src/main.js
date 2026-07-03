import * as THREE from 'three';
import './style.css';

/* ============================ CONFIG ============================ */

const HEADINGS = [0, 45, 90, 135, 180, 225, 270, 315];

const SCENES = {
  // DFE stems (tools/apply_dfe.py): diffuse-field EQ'd and peak-normalized to
  // -4 dBFS per scene, so no per-scene makeup gain is needed here.
  foodcourt: {
    label: 'Food Court',
    stemDir: 'stems/foodcourt',
    stemFile: (h) => `Kemar_SceneRotation_FC1_R${h}.wav`,
    gain: 1,
    videoSrc: null, // no 360 video yet (Stage 2)
    captureOffset: 0, // video t=0 vs audio t=0; measured once video exists (Stage 3)
  },
  livingroom: {
    label: 'Living Room',
    stemDir: 'stems/livingroom',
    stemFile: (h) => `Kemar_SceneRotation_LR_R${h}.wav`,
    gain: 1,
    videoSrc: null,
    captureOffset: 0,
  },
};

// Flip if turning right makes the sound go left (set from Stage 1 listening test).
const MIRROR_YAW = false;

const DRAG_SENSITIVITY = 0.25; // deg of yaw per px dragged
const ARROW_SPEED = 120; // deg/s while an arrow key is held
const FOV = 75;
const RESYNC_THRESHOLD = 0.08; // s of A/V drift before hard re-cue (Stage 3)

/* ========================== YAW SOURCE ========================== */

// Listener yaw in degrees. 0 = facing the person at front. Increases turning right.
let yaw = 0;

const wrap360 = (a) => ((a % 360) + 360) % 360;

function setupYawControls(canvas) {
  let dragging = false;
  let lastX = 0;

  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    lastX = e.clientX;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    yaw += (e.clientX - lastX) * DRAG_SENSITIVITY;
    lastX = e.clientX;
  });
  canvas.addEventListener('pointerup', () => (dragging = false));
  canvas.addEventListener('pointercancel', () => (dragging = false));

  const held = { ArrowLeft: false, ArrowRight: false };
  addEventListener('keydown', (e) => {
    if (e.key in held) {
      held[e.key] = true;
      e.preventDefault();
    }
  });
  addEventListener('keyup', (e) => {
    if (e.key in held) held[e.key] = false;
  });

  return function stepKeys(dt) {
    if (held.ArrowLeft) yaw -= ARROW_SPEED * dt;
    if (held.ArrowRight) yaw += ARROW_SPEED * dt;
  };
}

/* ========================= AUDIO ENGINE ========================= */
// 8 pre-rendered stereo binaural stems, one per 45 deg listener heading.
// All 8 start with one shared start(when) -> sample-locked cluster, forever.
// NO decoding/rotation happens here; we only crossfade between headings.

const audio = {
  ctx: null,
  sources: [], // 8 AudioBufferSourceNodes, index-matched to HEADINGS
  gains: [], // per-stem GainNodes
  master: null,
  ready: false,
};

function stopAudio() {
  if (!audio.ready) return;
  audio.ready = false;
  for (const src of audio.sources) {
    try {
      src.stop();
    } catch {}
  }
  audio.master.disconnect();
  audio.sources = [];
  audio.gains = [];
  audio.master = null;
}

async function loadAndStartAudio(scene) {
  const ctx = audio.ctx ?? new AudioContext();
  audio.ctx = ctx;
  await ctx.resume();

  const buffers = await Promise.all(
    HEADINGS.map(async (h) => {
      const url = `${scene.stemDir}/${encodeURIComponent(scene.stemFile(h))}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch failed: ${url}`);
      return ctx.decodeAudioData(await res.arrayBuffer());
    })
  );

  audio.master = ctx.createGain();
  audio.master.gain.value = scene.gain;
  audio.master.connect(ctx.destination);

  const startAt = ctx.currentTime + 0.15;
  audio.sources = [];
  audio.gains = [];
  for (const buf of buffers) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(g).connect(audio.master);
    src.start(startAt); // identical start time for all 8 -> sample-locked
    audio.sources.push(src);
    audio.gains.push(g);
  }
  audio.ready = true;
}

// Equal-power crossfade between the two headings bracketing the current yaw.
// Returns {lo, hi, gLo, gHi} for the HUD.
function updateStemGains() {
  if (!audio.ready) return null;

  const a = wrap360(MIRROR_YAW ? -yaw : yaw);
  const iLo = Math.floor(a / 45) % 8;
  const iHi = (iLo + 1) % 8;
  const d = a - iLo * 45; // 0..45 deg past the lower heading
  const gLo = Math.cos((d / 45) * (Math.PI / 2));
  const gHi = Math.sin((d / 45) * (Math.PI / 2));

  const t = audio.ctx.currentTime;
  for (let i = 0; i < 8; i++) {
    const target = i === iLo ? gLo : i === iHi ? gHi : 0;
    // Short ramp avoids zipper noise on fast drags.
    audio.gains[i].gain.setTargetAtTime(target, t, 0.015);
  }
  return { lo: HEADINGS[iLo], hi: HEADINGS[iHi], gLo, gHi };
}

/* ========================= 3D SCENE ============================ */
// Placeholder visual until the 360 video exists: a stylized person standing
// at heading 0 (world-anchored), floor grid, and tick markers every 45 deg.

const EYE_HEIGHT = 1.6;

function headingToPosition(deg, radius, y = 0) {
  const r = THREE.MathUtils.degToRad(deg);
  return new THREE.Vector3(Math.sin(r) * radius, y, -Math.cos(r) * radius);
}

function buildPerson() {
  const person = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0xd9a066 });
  const shirt = new THREE.MeshStandardMaterial({ color: 0x2277cc });
  const pants = new THREE.MeshStandardMaterial({ color: 0x334455 });

  const legs = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.55, 4, 12), pants);
  legs.position.y = 0.45;
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.5, 4, 12), shirt);
  torso.position.y = 1.05;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 24, 16), skin);
  head.position.y = 1.52;

  const armGeo = new THREE.CapsuleGeometry(0.05, 0.45, 4, 8);
  const armL = new THREE.Mesh(armGeo, shirt);
  armL.position.set(-0.26, 1.05, 0);
  const armR = armL.clone();
  armR.position.x = 0.26;

  // Simple face marker so you can tell the figure faces you.
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 8), skin);
  nose.position.set(0, 1.52, 0.13);

  person.add(legs, torso, head, armL, armR, nose);
  return person;
}

function buildEnvironment(scene3d) {
  scene3d.background = new THREE.Color(0x0a0e14);
  scene3d.fog = new THREE.Fog(0x0a0e14, 8, 24);

  scene3d.add(new THREE.HemisphereLight(0x8899bb, 0x223344, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(3, 6, 2);
  scene3d.add(sun);

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(20, 64),
    new THREE.MeshStandardMaterial({ color: 0x141a22 })
  );
  floor.rotation.x = -Math.PI / 2;
  scene3d.add(floor);

  const grid = new THREE.GridHelper(40, 40, 0x224455, 0x152030);
  grid.position.y = 0.002;
  scene3d.add(grid);

  // Tick marker at each of the 8 stem headings, at the 1 m lab ring radius.
  for (const h of HEADINGS) {
    const isFront = h === 0;
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, 0.02, isFront ? 0.5 : 0.25, 8),
      new THREE.MeshStandardMaterial({ color: isFront ? 0x33ffaa : 0x2288aa })
    );
    const pos = headingToPosition(h, 1.0);
    post.position.set(pos.x, (isFront ? 0.5 : 0.25) / 2, pos.z);
    scene3d.add(post);
  }

  // The person: straight ahead at heading 0, just beyond the ring, facing the listener.
  const person = buildPerson();
  const p = headingToPosition(0, 1.4);
  person.position.copy(p);
  person.lookAt(0, 0, 0);
  scene3d.add(person);
}

/* ========================= MINIMAP ============================= */
// Top-down view, world-anchored: the scene (person, heading ticks) stays
// fixed and the listener's view cone rotates — same convention as the 3D view
// and the audio. 0 deg (the person) is at the top.

const minimap = document.getElementById('minimap');
const mmCtx = minimap.getContext('2d');

function drawMinimap() {
  const w = minimap.width;
  const c = w / 2;
  const ringR = w * 0.33;

  mmCtx.clearRect(0, 0, w, w);

  // Backdrop disc
  mmCtx.beginPath();
  mmCtx.arc(c, c, w * 0.47, 0, Math.PI * 2);
  mmCtx.fillStyle = 'rgba(6, 14, 22, 0.75)';
  mmCtx.fill();
  mmCtx.strokeStyle = '#1d3a52';
  mmCtx.lineWidth = 2;
  mmCtx.stroke();

  const headingXY = (deg, radius) => {
    const r = (deg * Math.PI) / 180;
    return [c + Math.sin(r) * radius, c - Math.cos(r) * radius];
  };

  // View cone (FOV wide, pointing at current yaw)
  const yawRad = (wrap360(yaw) * Math.PI) / 180;
  const half = (FOV / 2) * (Math.PI / 180);
  mmCtx.beginPath();
  mmCtx.moveTo(c, c);
  // canvas angle: 0 deg = up -> -PI/2 in canvas coords
  mmCtx.arc(c, c, w * 0.44, yawRad - half - Math.PI / 2, yawRad + half - Math.PI / 2);
  mmCtx.closePath();
  const cone = mmCtx.createRadialGradient(c, c, 0, c, c, w * 0.44);
  cone.addColorStop(0, 'rgba(80, 200, 255, 0.45)');
  cone.addColorStop(1, 'rgba(80, 200, 255, 0.05)');
  mmCtx.fillStyle = cone;
  mmCtx.fill();

  // Heading ticks on the stem ring
  for (const h of HEADINGS) {
    const [x, y] = headingXY(h, ringR);
    mmCtx.beginPath();
    mmCtx.arc(x, y, h === 0 ? 7 : 5, 0, Math.PI * 2);
    mmCtx.fillStyle = h === 0 ? '#33ffaa' : '#2288aa';
    mmCtx.fill();
    const [lx, ly] = headingXY(h, ringR + 26);
    mmCtx.fillStyle = '#48a';
    mmCtx.font = '15px ui-monospace, Menlo, monospace';
    mmCtx.textAlign = 'center';
    mmCtx.textBaseline = 'middle';
    mmCtx.fillText(String(h), lx, ly);
  }

  // The person, just beyond the ring at heading 0
  const [px, py] = headingXY(0, ringR * 1.4);
  mmCtx.beginPath();
  mmCtx.arc(px, py, 9, 0, Math.PI * 2);
  mmCtx.fillStyle = '#2277cc';
  mmCtx.fill();
  mmCtx.beginPath();
  mmCtx.arc(px, py - 3, 4, 0, Math.PI * 2);
  mmCtx.fillStyle = '#d9a066';
  mmCtx.fill();

  // Listener head + nose direction
  mmCtx.beginPath();
  mmCtx.arc(c, c, 10, 0, Math.PI * 2);
  mmCtx.fillStyle = '#9fe';
  mmCtx.fill();
  const [nx, ny] = headingXY(wrap360(yaw), 16);
  mmCtx.beginPath();
  mmCtx.arc(nx, ny, 4, 0, Math.PI * 2);
  mmCtx.fill();
}

/* ============================ APP ============================== */

const canvas = document.getElementById('stage');
const hud = document.getElementById('hud');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene3d = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(FOV, innerWidth / innerHeight, 0.05, 100);
camera.position.set(0, EYE_HEIGHT, 0);

buildEnvironment(scene3d);

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
addEventListener('resize', resize);
resize();

const stepKeys = setupYawControls(canvas);

let sceneKey = 'livingroom';
let lastT = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastT) / 1000, 0.1);
  lastT = now;

  stepKeys(dt);

  const r = THREE.MathUtils.degToRad(yaw);
  camera.lookAt(
    camera.position.x + Math.sin(r),
    EYE_HEIGHT,
    camera.position.z - Math.cos(r)
  );

  const xf = updateStemGains();
  drawMinimap();

  const lines = {
    scene: SCENES[sceneKey].label,
    yaw: wrap360(yaw).toFixed(1) + ' deg',
    audio: !audio.ready
      ? 'waiting for start'
      : paused
        ? 'paused'
        : 'playing (8 stems locked)',
  };
  if (xf) {
    lines.stems =
      `${String(xf.lo).padStart(3, '0')}:${xf.gLo.toFixed(2)}  ` +
      `${String(xf.hi).padStart(3, '0')}:${xf.gHi.toFixed(2)}`;
  }
  hud.textContent = Object.entries(lines)
    .map(([k, v]) => k.padEnd(6) + ': ' + v)
    .join('\n');

  renderer.render(scene3d, camera);
}
requestAnimationFrame(frame);

/* ---------------- play / pause ---------------- */
// Suspending the AudioContext freezes its clock, so all 8 stems pause and
// resume as one unit and stay sample-locked.

const controls = document.getElementById('controls');
const playPauseBtn = document.getElementById('playpause-btn');
const sceneSwitch = document.getElementById('scene-switch');
let paused = false;

async function togglePlayPause() {
  if (!audio.ready) return;
  if (paused) {
    await audio.ctx.resume();
    paused = false;
    playPauseBtn.innerHTML = '&#10074;&#10074;';
  } else {
    await audio.ctx.suspend();
    paused = true;
    playPauseBtn.innerHTML = '&#9654;';
  }
}

playPauseBtn.addEventListener('click', togglePlayPause);
addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat) {
    e.preventDefault();
    togglePlayPause();
  }
});

/* ---------------- live scene switching ---------------- */

async function switchScene(key) {
  playPauseBtn.disabled = true;
  sceneSwitch.disabled = true;
  stopAudio();
  sceneKey = key;
  try {
    await loadAndStartAudio(SCENES[key]); // resumes the ctx, so also un-pauses
    paused = false;
    playPauseBtn.innerHTML = '&#10074;&#10074;';
  } catch (err) {
    console.error(err);
  }
  playPauseBtn.disabled = false;
  sceneSwitch.disabled = false;
}

sceneSwitch.addEventListener('change', () => switchScene(sceneSwitch.value));

/* ---------------- gesture-gated start ---------------- */

const overlay = document.getElementById('start-overlay');
const startBtn = document.getElementById('start-btn');
const sceneSelect = document.getElementById('scene-select');

for (const [key, s] of Object.entries(SCENES)) {
  for (const sel of [sceneSelect, sceneSwitch]) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = s.label;
    sel.append(opt);
  }
}
sceneSelect.value = sceneKey;

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  startBtn.textContent = 'loading stems…';
  sceneKey = sceneSelect.value;
  try {
    await loadAndStartAudio(SCENES[sceneKey]);
    overlay.remove();
    controls.hidden = false;
    sceneSwitch.value = sceneKey;
    playPauseBtn.innerHTML = '&#10074;&#10074;';
  } catch (err) {
    console.error(err);
    startBtn.textContent = '\u25B6 Start';
    startBtn.disabled = false;
    let msg = document.querySelector('#start-card .error');
    if (!msg) {
      msg = document.createElement('small');
      msg.className = 'error';
      document.getElementById('start-card').append(msg);
    }
    msg.textContent = 'Load failed — check console / stem paths.';
  }
});
