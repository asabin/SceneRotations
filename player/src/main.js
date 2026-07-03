import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
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
    env: 'env/foodcourt.jpg', // 360 photo backdrop (Poly Haven, CC0)
    envYaw: 0, // deg; rotate the backdrop to choose what sits at front
    videoSrc: null, // no 360 video yet (Stage 2)
    captureOffset: 0, // video t=0 vs audio t=0; measured once video exists (Stage 3)
  },
  livingroom: {
    label: 'Living Room',
    stemDir: 'stems/livingroom',
    stemFile: (h) => `Kemar_SceneRotation_LR_R${h}.wav`,
    gain: 1,
    env: 'env/livingroom.jpg',
    envYaw: 0,
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
    const delta = (e.clientX - lastX) * DRAG_SENSITIVITY;
    yaw += delta;
    // While IMU control is active, dragging re-aims by shifting the offset,
    // so the tweak survives the next orientation event.
    if (motion.active) motion.offset += delta;
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

/* ------------------ device-motion (IMU) yaw ------------------- */
// Opt-in on mobile: the W3C deviceorientation angles are converted to a
// camera quaternion (same math as three.js DeviceOrientationControls) and
// the world-yaw of the look direction drives the shared `yaw` variable.
// An offset captured at enable time keeps the view from jumping.

const motion = {
  supported: typeof DeviceOrientationEvent !== 'undefined',
  active: false,
  offset: 0, // deg; yaw = deviceYaw + offset
  needsCalibration: false,
};

const _euler = new THREE.Euler();
const _q = new THREE.Quaternion();
const _qFlip = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2); // -90 deg about X
const _qScreen = new THREE.Quaternion();
const _zAxis = new THREE.Vector3(0, 0, 1);
const _look = new THREE.Vector3();

function onDeviceOrientation(e) {
  if (e.alpha == null || e.beta == null || e.gamma == null) return;
  const screenAngle = screen.orientation?.angle ?? window.orientation ?? 0;

  _euler.set(
    THREE.MathUtils.degToRad(e.beta),
    THREE.MathUtils.degToRad(e.alpha),
    -THREE.MathUtils.degToRad(e.gamma),
    'YXZ'
  );
  _q.setFromEuler(_euler)
    .multiply(_qFlip)
    .multiply(_qScreen.setFromAxisAngle(_zAxis, -THREE.MathUtils.degToRad(screenAngle)));

  // Yaw of the device's look direction in our world convention
  // (0 = -Z ahead, increasing to the right).
  _look.set(0, 0, -1).applyQuaternion(_q);
  const deviceYaw = THREE.MathUtils.radToDeg(Math.atan2(_look.x, -_look.z));

  if (motion.needsCalibration) {
    motion.offset = yaw - deviceYaw;
    motion.needsCalibration = false;
  }
  if (motion.active) yaw = deviceYaw + motion.offset;
}

async function setMotionControl(on) {
  if (!on) {
    motion.active = false;
    removeEventListener('deviceorientation', onDeviceOrientation);
    return false;
  }
  // iOS requires an explicit permission request from a user gesture.
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      if ((await DeviceOrientationEvent.requestPermission()) !== 'granted') return false;
    } catch {
      return false;
    }
  }
  motion.needsCalibration = true;
  motion.active = true;
  addEventListener('deviceorientation', onDeviceOrientation);
  return true;
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
// Visual layer until the real 360 video exists (Stage 2): a 360 photo
// backdrop per scene (equirect JPG on the scene background + IBL), a
// realistic animated human at heading 0, and subtle heading markers.

const EYE_HEIGHT = 1.6;

function headingToPosition(deg, radius, y = 0) {
  const r = THREE.MathUtils.degToRad(deg);
  return new THREE.Vector3(Math.sin(r) * radius, y, -Math.cos(r) * radius);
}

/* ---- 360 photo backdrop: doubles as image-based lighting ---- */

const textureLoader = new THREE.TextureLoader();
const envCache = new Map();

function applyEnvironment(scene3d, sceneCfg) {
  let tex = envCache.get(sceneCfg.env);
  if (!tex) {
    tex = textureLoader.load(sceneCfg.env);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    envCache.set(sceneCfg.env, tex);
  }
  scene3d.background = tex;
  scene3d.environment = tex; // lights the person to match the room
  const rotY = THREE.MathUtils.degToRad(sceneCfg.envYaw ?? 0);
  scene3d.backgroundRotation.set(0, rotY, 0);
  scene3d.environmentRotation.set(0, rotY, 0);
}

/* ---- animated human at heading 0 ---- */

let personMixer = null;

function loadPerson(scene3d) {
  new GLTFLoader().load('models/person.glb', (gltf) => {
    const person = gltf.scene;
    person.position.copy(headingToPosition(0, 1.4));
    // Mixamo-rigged models front along -Z: aim at the listener, then flip.
    person.lookAt(0, 0, 0);
    person.rotateY(Math.PI);
    scene3d.add(person);

    const idle = gltf.animations.find((a) => /idle/i.test(a.name)) ?? gltf.animations[0];
    if (idle) {
      personMixer = new THREE.AnimationMixer(person);
      personMixer.clipAction(idle).play();
    }

    // Soft blob shadow grounds the figure against the photo backdrop.
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 8, 64, 64, 64);
    grad.addColorStop(0, 'rgba(0,0,0,0.45)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.1, 1.1),
      new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(c),
        transparent: true,
        depthWrite: false,
      })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.copy(person.position).setY(0.01);
    scene3d.add(shadow);
  });
}

function buildEnvironment(scene3d) {
  // Gentle fill so the person is never black while the env map streams in.
  scene3d.add(new THREE.HemisphereLight(0xffffff, 0x666677, 0.5));

  // Slim, translucent tick at each stem heading (front one green + taller).
  for (const h of HEADINGS) {
    const isFront = h === 0;
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.012, 0.012, isFront ? 0.4 : 0.2, 8),
      new THREE.MeshBasicMaterial({
        color: isFront ? 0x33ffaa : 0x66ccee,
        transparent: true,
        opacity: 0.4,
      })
    );
    const pos = headingToPosition(h, 1.0);
    post.position.set(pos.x, (isFront ? 0.4 : 0.2) / 2, pos.z);
    scene3d.add(post);
  }

  loadPerson(scene3d);
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
applyEnvironment(scene3d, SCENES['livingroom']); // default scene backdrop

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
  personMixer?.update(dt);

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
  applyEnvironment(scene3d, SCENES[key]);
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

/* ---------------- motion control toggle ---------------- */

const motionBtn = document.getElementById('motion-btn');

// Offer IMU control where orientation events exist and the primary pointer
// is coarse (phones/tablets); desktops keep drag + arrows only.
if (motion.supported && matchMedia('(pointer: coarse)').matches) {
  motionBtn.hidden = false;
}

motionBtn.addEventListener('click', async () => {
  const on = await setMotionControl(!motion.active);
  motionBtn.textContent = on ? 'Motion on' : 'Motion off';
  motionBtn.classList.toggle('active', on);
  if (!on && motion.supported && !motion.active) {
    // Permission denied or sensor failure: leave the button usable for retry.
    motionBtn.blur();
  }
});

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
  applyEnvironment(scene3d, SCENES[sceneKey]);
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
