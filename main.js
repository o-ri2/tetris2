import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import {
  checkSurvival,
  cumulativeCohortSurvivalPercent,
  getAnnualSurvivalPercentForAge,
  getDeathProbabilityPercentForAge
} from './mortality.js';
import { buildLifeNarrativeFiveLines } from './lifeStages.js';

/**
 * 〈구축과 쇠락〉작품 정의서 모드: `html[data-work-spec="construction-decline"]`
 * — 40Hz 서브 고정·유휴 자동 배치 끔·085 이후 아카이브만으로 승화(화이트 폭발 스킵)
 */
const WORK_SPEC_CONSTRUCTION_DECLINE =
  typeof document !== 'undefined' &&
  (document.documentElement?.dataset?.workSpec === 'construction-decline' ||
    document.body?.dataset?.workSpec === 'construction-decline');

/** 렌더링: OrthographicCamera + EffectComposer(Render → UnrealBloom → Glitch ShaderPass). Perspective 미사용. */

// —— 공간 / 그리드 ——
const CELL = 1;
const GRID_X = 18;
const MAX_Y = 28;
/** 월드 Y: 0 … MAX_Y*CELL (카메라는 세로 중앙을 보도록 맞춤) */
const GRID_WORLD_HEIGHT = MAX_Y * CELL;
const GRID_VIEW_CENTER_Y = GRID_WORLD_HEIGHT * 0.5;
/** 눈금·게이지 표시용 상한 (실제 종료 연령은 없음) */
const MEMORY_DISPLAY_CAP = 120;
const HI_SCORE_STORAGE_KEY = 'arcade-hi-blocks';
const PHASE_YOUTH_END = 60;
const PHASE_MATURE_END = 80;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);

const ambientLight = new THREE.AmbientLight(0xffffff, 1.2);
scene.add(ambientLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(5, 12, 100);
scene.add(dirLight);

const canvas = document.getElementById('c');

/**
 * 프로젝터/FHD처럼 물리 화면이 커질 때 "픽셀 밀도"를 올려 더 촘촘하게 보이도록 오버샘플링.
 * devicePixelRatio가 1인 환경에서도 2x로 렌더해 선/텍스트가 덜 성글게 보임.
 */
const PIXEL_DENSITY_MULT = 2.0;

function getCanvasSize() {
  const wrap = document.getElementById('canvas-wrap');
  if (!wrap) {
    return { w: Math.max(1, window.innerWidth), h: Math.max(1, window.innerHeight) };
  }
  const w = Math.floor(wrap.clientWidth);
  const h = Math.floor(wrap.clientHeight);
  return { w: Math.max(1, w), h: Math.max(1, h) };
}

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio * PIXEL_DENSITY_MULT, 3));
{
  const { w, h } = getCanvasSize();
  renderer.setSize(w, h);
}
renderer.setClearColor(0xffffff, 1);
renderer.shadowMap.enabled = false;
if ('outputColorSpace' in renderer) {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

/** 직교 투영: 원근 완전 제거. 값을 줄일수록 그리드가 화면을 더 채움(줌 인) */
/** 블록 설치 그리드가 뷰포트에서 잘리지 않도록 기준(34) 대비 80% 크기로 보이게 줌 아웃 */
const FRUSTUM_BASE = 34 / 0.78;
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2500);

function updateOrthographicCamera() {
  const { w, h } = getCanvasSize();
  const aspect = w / Math.max(1, h);
  const halfH = FRUSTUM_BASE * 0.5;
  const halfW = halfH * aspect;
  camera.left = -halfW;
  camera.right = halfW;
  camera.top = halfH;
  camera.bottom = -halfH;
  camera.updateProjectionMatrix();
}
updateOrthographicCamera();

/** Z축 정면: XY 평면만 납작하게 보임 (깊이감 제거) */
const CAMERA_BASE = new THREE.Vector3(0, 0, 100);
camera.position.copy(CAMERA_BASE);
camera.lookAt(0, GRID_VIEW_CENTER_Y, 0);

/** 하드 드롭 시 미세 쉐이크 (프레임 단위) */
let cameraShakeFramesLeft = 0;

// —— 포스트: RGB 분리 / 그레인 / CRT 왜곡 (글리치 시 강도↑) ——
const GlitchPostShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uIntensity: { value: 0 },
    resolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) }
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    precision mediump float;
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uIntensity;
    uniform vec2 resolution;
    varying vec2 vUv;

    float rand(vec2 co) {
      return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec2 uv = vUv;
      vec3 col;

      if (uIntensity < 0.0001) {
        col = texture2D(tDiffuse, uv).rgb;
      } else {
        // 브라운관형 배럴 + 디지털 찢김 + 강한 RGB Shift / 스태틱 그레인 (시스템 셧다운)
        vec2 c = uv - 0.5;
        float r = length(c);
        float barrel = 1.0 + 0.38 * uIntensity * r * r;
        uv = 0.5 + c * barrel;

        float row = floor(uv.y * 180.0);
        uv.x += sin(row * 1.91 + uTime * 58.0) * 0.042 * uIntensity;
        uv.y += sin(uv.x * 110.0 + uTime * 48.0) * 0.018 * uIntensity;
        uv.x += sin(floor(uv.y * 96.0) + uTime * 36.0) * 0.024 * uIntensity;

        uv = clamp(uv, 0.001, 0.999);

        float sep = uIntensity * (0.02 + 0.034 * abs(sin(uTime * 22.0)));
        vec2 offR = vec2(sep, sep * 0.42);
        vec2 offB = vec2(-sep * 1.05, -sep * 0.32);
        float cr = texture2D(tDiffuse, uv + offR).r;
        float cg = texture2D(tDiffuse, uv).g;
        float cb = texture2D(tDiffuse, uv + offB).b;
        col = vec3(cr, cg, cb);

        float g1 = rand(uv * resolution * 0.48 + floor(uTime * 95.0));
        float g2 = rand(uv.yx * resolution.yx * 0.36 + uTime * 240.0);
        float g3 = rand(uv * 3.1 + uTime * 17.0);
        col += (g1 - 0.5) * 0.74 * uIntensity;
        col += (g2 - 0.5) * 0.52 * uIntensity;
        col += (g3 - 0.5) * 0.32 * uIntensity;

        col *= 1.0 - 0.28 * uIntensity * abs(sin(uv.y * resolution.y * 2.6 + uTime * 48.0));
        col += vec3(0.09, 0.05, 0.11) * uIntensity * rand(vec2(uTime * 14.0, uv.y * 520.0));
      }

      gl_FragColor = vec4(col, 1.0);
    }
  `
};

const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);

/** Bloom: 그리드·스캐너는 어두운 색(threshold↑) → 와이어(블록/커서)만 강하게 glow */
const bloomSize = getCanvasSize();
const bloomResolution = new THREE.Vector2(bloomSize.w, bloomSize.h);
const BLOOM_STRENGTH_NORMAL = 0.45;
const bloomPass = new UnrealBloomPass(bloomResolution, BLOOM_STRENGTH_NORMAL, 0.6, 0.88);
composer.addPass(bloomPass);

const glitchPass = new ShaderPass(GlitchPostShader);
composer.addPass(glitchPass);

function resizeComposer() {
  const { w, h } = getCanvasSize();
  composer.setSize(w, h);
  composer.setPixelRatio(Math.min(window.devicePixelRatio * PIXEL_DENSITY_MULT, 3));
  bloomPass.setSize(w, h);
  bloomResolution.set(w, h);
  glitchPass.uniforms.resolution.value.set(w, h);
}
resizeComposer();

const offX = ((GRID_X - 1) * CELL) / 2;

function gxToWorldX(gx) {
  return gx * CELL - offX;
}
function iyToWorldY(iy) {
  return iy * CELL + CELL * 0.5;
}
/** 2D 매트릭스: 월드 Z는 항상 0 */
const PLANE_Z = 0;

function getPlayfieldBounds() {
  const xMin = gxToWorldX(0) - CELL * 0.5;
  const xMax = gxToWorldX(GRID_X - 1) + CELL * 0.5;
  const yMin = 0;
  const yMax = MAX_Y * CELL;
  return { xMin, xMax, yMin, yMax };
}

const { xMin: gridXMin, xMax: gridXMax, yMin: gridYMin, yMax: gridYMax } = getPlayfieldBounds();

/** 가이드 격자선 미표시 — 글리치 시 플레이필드 흔들림용 빈 그룹만 유지 */
const variableGridGroup = new THREE.Group();

/** 수직 스캐너 (월드 X 이동, Z는 약간 앞으로) */
const SCANNER_Z = 0.04;
const scannerGeo = new THREE.BufferGeometry();
scannerGeo.setFromPoints([
  new THREE.Vector3(0, gridYMin, SCANNER_Z),
  new THREE.Vector3(0, gridYMax, SCANNER_Z)
]);
const scannerLine = new THREE.Line(
  scannerGeo,
  new THREE.LineBasicMaterial({ color: 0x5c5c68, transparent: true, opacity: 0.72 })
);
scannerLine.renderOrder = 3;

const SCANNER_PERIOD_MS = 5200;

const blockGroup = new THREE.Group();

/** 엔딩 압축·상승 시 함께 스케일/이동 (플레이필드·스캐너·블록) */
const playfieldRoot = new THREE.Group();
playfieldRoot.add(variableGridGroup);
playfieldRoot.add(scannerLine);
playfieldRoot.add(blockGroup);
scene.add(playfieldRoot);

const boxGeo = new THREE.BoxGeometry(CELL, CELL, CELL);
const edgeGeo = new THREE.EdgesGeometry(boxGeo);
const blackMat = new THREE.MeshBasicMaterial({ color: 0x000000 });

const textureLoader = new THREE.TextureLoader();
const TEX_PATH = 'Concrete031_2K-JPG/Concrete031_2K-JPG_';
const concreteColorTex = textureLoader.load(TEX_PATH + 'Color.jpg');
const concreteNormalTex = textureLoader.load(TEX_PATH + 'NormalGL.jpg');
const concreteRoughnessTex = textureLoader.load(TEX_PATH + 'Roughness.jpg');
const concreteAOTex = textureLoader.load(TEX_PATH + 'AmbientOcclusion.jpg');
concreteColorTex.colorSpace = THREE.SRGBColorSpace;
[concreteColorTex, concreteNormalTex, concreteRoughnessTex, concreteAOTex].forEach(t => {
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
});

const placedFillMat = new THREE.MeshStandardMaterial({
  map: concreteColorTex,
  normalMap: concreteNormalTex,
  normalScale: new THREE.Vector2(0.6, 0.6),
  roughnessMap: concreteRoughnessTex,
  roughness: 0.85,
  metalness: 0.0,
  color: new THREE.Color(0.72, 0.70, 0.68),
});
const PLACED_EDGE_HEX = 0xb0b0b4;
const placedEdgeMat = new THREE.LineBasicMaterial({ color: PLACED_EDGE_HEX, transparent: true, opacity: 0.18 });
const PLACED_EDGE_COLOR = new THREE.Color(PLACED_EDGE_HEX);
const COLOR_WHITE = new THREE.Color(0xffffff);

function createDataBlock(age) {
  const a = age || 1;
  let colorTint = 0.72;
  let normalStr = 0.6;
  if (a > 75) { colorTint = 0.50; normalStr = 1.0; }
  else if (a > 60) { colorTint = 0.58; normalStr = 0.8; }
  else if (a > 40) { colorTint = 0.65; normalStr = 0.7; }

  const g = new THREE.Group();
  const mat = placedFillMat.clone();
  mat.map = concreteColorTex.clone();
  mat.normalMap = concreteNormalTex.clone();
  mat.roughnessMap = concreteRoughnessTex.clone();
  mat.color = new THREE.Color(colorTint, colorTint * 0.98, colorTint * 0.96);
  mat.normalScale = new THREE.Vector2(normalStr, normalStr);
  const ox = Math.random(), oy = Math.random();
  [mat.map, mat.normalMap, mat.roughnessMap].forEach(t => {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.offset.set(ox, oy);
    t.needsUpdate = true;
  });
  mat.map.colorSpace = THREE.SRGBColorSpace;
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = 1;
  mat.polygonOffsetUnits = 1;
  const mesh = new THREE.Mesh(boxGeo, mat);
  const edges = new THREE.LineSegments(edgeGeo, placedEdgeMat.clone());
  edges.renderOrder = 1;
  g.add(mesh);
  g.add(edges);
  g.userData.edges = edges;
  g.userData.age = a;
  return g;
}

const grid = [];
for (let x = 0; x < GRID_X; x++) {
  grid[x] = [];
  for (let y = 0; y < MAX_Y; y++) {
    grid[x][y] = null;
  }
}

const placedBlocks = [];
let blockCount = 0;

/** 다음 설치 위치 가이드 — 주황 점선(고정 블록의 흰·회 와이어와 분리) */
const COLOR_GUIDE_HEX = 0xff7722;
const cursorGeo = new THREE.BoxGeometry(CELL * 1.02, CELL * 1.02, CELL * 1.02);
const cursorEdges = new THREE.EdgesGeometry(cursorGeo);
const cursorMat = new THREE.LineDashedMaterial({
  color: COLOR_GUIDE_HEX,
  transparent: true,
  opacity: 0.95,
  dashSize: 0.14,
  gapSize: 0.1
});
const cursor = new THREE.LineSegments(cursorEdges, cursorMat);
cursor.computeLineDistances();
cursor.renderOrder = 5;
scene.add(cursor);

/** 커서 잔상 (3~4프레임) */
const GHOST_FRAMES = 4;
const cursorGhosts = [];
for (let i = 0; i < GHOST_FRAMES; i++) {
  const gMat = new THREE.LineBasicMaterial({
    color: COLOR_GUIDE_HEX,
    transparent: true,
    opacity: 0.12
  });
  const ghost = new THREE.LineSegments(cursorEdges, gMat);
  ghost.visible = false;
  ghost.renderOrder = 0;
  scene.add(ghost);
  cursorGhosts.push({ mesh: ghost, life: 0 });
}

function spawnCursorGhost(worldX, worldY) {
  let slot = cursorGhosts.find((g) => g.life <= 0);
  if (!slot) {
    slot = cursorGhosts.reduce((a, b) => (a.life < b.life ? a : b));
  }
  slot.mesh.position.set(worldX, worldY, PLANE_Z);
  slot.mesh.material.opacity = 0.12;
  slot.mesh.visible = true;
  slot.life = GHOST_FRAMES;
}

function tickCursorGhosts() {
  cursorGhosts.forEach((g) => {
    if (g.life > 0) {
      g.life -= 1;
      g.mesh.material.opacity = 0.12 * Math.max(0, g.life / GHOST_FRAMES);
      if (g.life <= 0) g.mesh.visible = false;
    }
  });
}

let cursorGx = Math.floor(GRID_X / 2);
/** 스페이스 키 홀드 시 연속 배치 방지 (한 번에 1블록만) */
let isSpacePressed = false;

/** 마지막 수동 스페이스(플레이) 이후 이 시간을 넘기면 자동 쌓기 시작 */
const IDLE_MANUAL_SPACE_QUIET_MS = 10000;
/** 자동 쌓기 간격 */
const IDLE_AUTO_PLACE_INTERVAL_MS = 3000;
let lastManualSpacePlayMs = performance.now();
let nextIdleAutoPlaceAtMs = 0;

function markManualSpacePlay() {
  lastManualSpacePlayMs = performance.now();
  nextIdleAutoPlaceAtMs = 0;
}

/** 유휴 자동 설치: 목표 열까지 화살표와 동일하게 한 칸씩 이동 후 설치 */
const IDLE_NAV_STEP_MS = 150;
let idleNavActive = false;
let idleNavTargetGx = 0;
let idleNavLastStepMs = 0;

function cancelIdleNav() {
  idleNavActive = false;
}

function updateCursorMesh() {
  const slot = lowestEmptySlot(cursorGx);
  if (slot === null) {
    cursor.visible = false;
    return;
  }
  cursor.visible = true;
  const hoverY = iyToWorldY(slot);
  cursor.position.set(gxToWorldX(cursorGx), hoverY, PLANE_Z);
}

function columnTopIndex(gx) {
  let top = -1;
  for (let iy = 0; iy < MAX_Y; iy++) {
    if (grid[gx][iy]) top = iy;
  }
  return top;
}

function lowestEmptySlot(gx) {
  for (let iy = 0; iy < MAX_Y; iy++) {
    if (grid[gx][iy]) continue;
    const supported = iy === 0 || grid[gx][iy - 1];
    if (supported) return iy;
  }
  return null;
}

/** 유휴 자동 쌓기: 블록을 놓을 수 있는 열을 모은 뒤 무작위로 선택(들쭉날쭉한 실루엣) */
function pickPlacementColumnForIdleAuto() {
  const candidates = [];
  for (let gx = 0; gx < GRID_X; gx++) {
    if (lowestEmptySlot(gx) !== null) candidates.push(gx);
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

let physicsCollapseActive = false;
let matterEngine = null;
let matterWorld = null;
let collapseSyncList = [];
let collapseEndAtMs = 0;

let audioCtx = null;
let ambientOsc = null;
let ambientGain = null;
/** 비트 크러시 루프 노이즈 (노이즈 플로어) */
let noiseFloorNodes = null;

function ensureAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

function startAmbient40Hz() {
  if (!audioCtx || ambientOsc) return;
  ambientOsc = audioCtx.createOscillator();
  ambientOsc.type = 'sine';
  /** 정의서: 40Hz 서브 = 시간의 절대적 흐름 / 기본: 45Hz 근처 */
  ambientOsc.frequency.value = WORK_SPEC_CONSTRUCTION_DECLINE ? 40 : 45;
  ambientGain = audioCtx.createGain();
  ambientGain.gain.value = WORK_SPEC_CONSTRUCTION_DECLINE ? 0.078 : 0.06;
  ambientOsc.connect(ambientGain);
  ambientGain.connect(audioCtx.destination);
  ambientOsc.start();
}

function startNoiseFloor() {
  if (!audioCtx || noiseFloorNodes) return;
  const len = 4096;
  const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
  const ch = buf.getChannelData(0);
  const crush = 14;
  for (let i = 0; i < len; i++) {
    const n = Math.random() * 2 - 1;
    ch[i] = Math.round(n * crush) / crush;
  }
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const hp = audioCtx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 90;
  const lp = audioCtx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 7800;
  const g = audioCtx.createGain();
  g.gain.value = 0.011;
  src.connect(hp);
  hp.connect(lp);
  lp.connect(g);
  g.connect(audioCtx.destination);
  src.start();
  noiseFloorNodes = { src, gain: g };
}

function stopNoiseFloor() {
  if (!noiseFloorNodes) return;
  try {
    noiseFloorNodes.src.stop();
    noiseFloorNodes.src.disconnect();
  } catch (e) {
    /* ignore */
  }
  noiseFloorNodes = null;
}

/**
 * x: 그리드 X → StereoPanner (왼쪽 -1 … 중앙 0 … 오른쪽 1)
 * y: 층 iy → 피치
 */
function playDataTickSound(x, y) {
  if (!audioCtx) return;
  const t = 0.05;
  const osc = audioCtx.createOscillator();
  osc.type = 'square';
  const nx = x / Math.max(1, GRID_X - 1);
  const ny = y / Math.max(1, MAX_Y - 1);
  const freq = 2000 + nx * 1200 + ny * 900;
  osc.frequency.value = Math.min(5000, Math.max(2000, freq));
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.12, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + t);
  osc.connect(g);

  if (typeof audioCtx.createStereoPanner === 'function') {
    const panner = audioCtx.createStereoPanner();
    const pan = GRID_X <= 1 ? 0 : (x / (GRID_X - 1)) * 2 - 1;
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(panner);
    panner.connect(audioCtx.destination);
  } else {
    g.connect(audioCtx.destination);
  }
  osc.start();
  osc.stop(audioCtx.currentTime + t);
}

function playWhiteNoiseBurst(durationSec) {
  if (!audioCtx) return;
  const len = Math.floor(audioCtx.sampleRate * durationSec);
  const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.45, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + durationSec);
  src.connect(g);
  g.connect(audioCtx.destination);
  src.start();
}

/** 오버플로우 진입: 하강하는 스퀘어 톤(경고 징글) */
function playOverflowWarningSting() {
  ensureAudio();
  if (!audioCtx) return;
  const run = () => {
    const now = audioCtx.currentTime;
    const freqs = [740, 520, 350, 220];
    freqs.forEach((freq, i) => {
      const t0 = now + i * 0.09;
      const osc = audioCtx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = freq;
      const g = audioCtx.createGain();
      g.gain.setValueAtTime(0.001, t0);
      g.gain.exponentialRampToValueAtTime(0.09, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.11);
      osc.connect(g);
      g.connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.12);
    });
  };
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().then(run).catch(run);
  } else {
    run();
  }
}

/** 화이트아웃 직전: 짧은 게임 오버 멜로디 */
function playGameOverSting() {
  ensureAudio();
  if (!audioCtx) return;
  const run = () => {
    const now = audioCtx.currentTime;
    const freqs = [330, 247, 165];
    freqs.forEach((freq, i) => {
      const t0 = now + i * 0.14;
      const osc = audioCtx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = freq;
      const g = audioCtx.createGain();
      g.gain.setValueAtTime(0.001, t0);
      g.gain.exponentialRampToValueAtTime(0.11, t0 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.2);
      osc.connect(g);
      g.connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.22);
    });
  };
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().then(run).catch(run);
  } else {
    run();
  }
}

/** 오버플로우 프리즈 직전: 짧은 상승 사이렌(경고 레이어) */
function playOverflowSiren() {
  ensureAudio();
  if (!audioCtx) return;
  const run = () => {
    const now = audioCtx.currentTime;
    const dur = 0.65;
    const osc = audioCtx.createOscillator();
    osc.type = 'sawtooth';
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.001, now);
    g.gain.exponentialRampToValueAtTime(0.055, now + 0.06);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    osc.frequency.setValueAtTime(380, now);
    osc.frequency.exponentialRampToValueAtTime(1100, now + dur * 0.55);
    osc.frequency.exponentialRampToValueAtTime(400, now + dur);
    osc.connect(g);
    g.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + dur + 0.03);
  };
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().then(run).catch(run);
  } else {
    run();
  }
}

function stopAmbient() {
  try {
    if (ambientOsc) {
      ambientOsc.stop();
      ambientOsc.disconnect();
    }
  } catch (e) {
    /* ignore */
  }
  ambientOsc = null;
  ambientGain = null;
  stopNoiseFloor();
}

function resumeAudioAndAmbient() {
  ensureAudio();
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  if (!ambientOsc) {
    startAmbient40Hz();
  }
  startNoiseFloor();
}
window.addEventListener('click', resumeAudioAndAmbient);
window.addEventListener('keydown', resumeAudioAndAmbient);

const dataLogEl = document.getElementById('data-log');
const addrDisplayEl = document.getElementById('addr-display');
const floatMetaEl = document.getElementById('float-meta');
const floatMetaCoordsEl = floatMetaEl?.querySelector('.float-meta__coords');
const floatMetaJunkEl = floatMetaEl?.querySelector('.float-meta__junk');
const floatMetaVec = new THREE.Vector3();
let uiFrame = 0;
let metaJitterRemain = 0;

function corruptMetaText(s) {
  if (!s || s.length < 1) return s;
  const pool = '01█▒░?*';
  const i = (Math.random() * s.length) | 0;
  const arr = s.split('');
  arr[i] = pool[(Math.random() * pool.length) | 0];
  if (Math.random() < 0.35 && i + 1 < arr.length) {
    arr[i + 1] = pool[(Math.random() * pool.length) | 0];
  }
  return arr.join('');
}

function updateTerminalClock() {
  const el = document.getElementById('terminal-clock');
  if (!el) return;
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  el.textContent = `시각 ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function updateFloatingMeta(now) {
  if (!floatMetaEl || !floatMetaCoordsEl || !floatMetaJunkEl) return;
  uiFrame += 1;
  if (uiFrame % 10 === 0) {
    metaJitterRemain = 3;
  }

  const slot = lowestEmptySlot(cursorGx);
  const colTop = columnTopIndex(cursorGx);
  let coordsText = `[열:${cursorGx}] [행:${slot !== null ? String(slot) : '--'}]`;
  let junkText = floatMetaJunkEl.textContent;
  if ((now | 0) % 2 === 0) {
    let bits = '';
    for (let i = 0; i < 56; i++) bits += Math.random() < 0.5 ? '0' : '1';
    const r = (Math.random() * 0xffffffff) >>> 0;
    junkText = `${bits}  ${r.toString(16).toUpperCase()}  ${((now / 17) | 0) % 100000}`;
  }

  if (metaJitterRemain > 0) {
    metaJitterRemain -= 1;
    floatMetaEl.style.transform = `translateY(${uiFrame % 2 === 0 ? '1px' : '-1px'})`;
    floatMetaCoordsEl.textContent = corruptMetaText(coordsText);
    floatMetaJunkEl.textContent = corruptMetaText(junkText);
  } else {
    floatMetaEl.style.transform = '';
    floatMetaCoordsEl.textContent = coordsText;
    floatMetaJunkEl.textContent = junkText;
  }

  const hoverY =
    slot !== null
      ? iyToWorldY(slot)
      : colTop >= 0
        ? iyToWorldY(colTop)
        : iyToWorldY(0);
  floatMetaVec.set(gxToWorldX(cursorGx), hoverY, PLANE_Z);
  floatMetaVec.project(camera);
  const rect = canvas.getBoundingClientRect();
  const px = (floatMetaVec.x * 0.5 + 0.5) * rect.width + rect.left;
  const py = (-floatMetaVec.y * 0.5 + 0.5) * rect.height + rect.top;
  const shell = document.getElementById('app-shell');
  const sr = shell
    ? shell.getBoundingClientRect()
    : { left: 0, right: window.innerWidth, top: 0 };
  floatMetaEl.style.left = `${Math.min(sr.right - 8, Math.max(sr.left + 4, px + 14))}px`;
  floatMetaEl.style.top = `${Math.max(sr.top + 72, py - 38)}px`;
}

const topEqBars = [];
const leftEqBars = [];
(function initEdgeSpectrograms() {
  const topEl = document.getElementById('edge-eq-top');
  const leftEl = document.getElementById('edge-eq-left');
  if (!topEl || !leftEl) return;
  for (let gx = 0; gx < GRID_X; gx++) {
    const d = document.createElement('div');
    d.className = 'edge-eq__bar edge-eq__bar--top';
    topEl.appendChild(d);
    topEqBars.push(d);
  }
  for (let iy = 0; iy < MAX_Y; iy++) {
    const d = document.createElement('div');
    d.className = 'edge-eq__bar edge-eq__bar--left';
    leftEl.appendChild(d);
    leftEqBars.push(d);
  }
})();

function updateEdgeSpectrograms() {
  for (let gx = 0; gx < GRID_X; gx++) {
    const top = columnTopIndex(gx);
    const h = top + 1;
    const pct = Math.max(3, (h / MAX_Y) * 100);
    const el = topEqBars[gx];
    if (el) el.style.height = `${pct}%`;
  }
  for (let iy = 0; iy < MAX_Y; iy++) {
    let c = 0;
    for (let gx = 0; gx < GRID_X; gx++) {
      if (grid[gx][iy]) c += 1;
    }
    const pct = Math.max(3, (c / GRID_X) * 100);
    const el = leftEqBars[iy];
    if (el) el.style.width = `${pct}%`;
  }
}

function loadHiScore() {
  try {
    const n = parseInt(localStorage.getItem(HI_SCORE_STORAGE_KEY) || '0', 10);
    if (Number.isNaN(n)) return 0;
    return Math.min(999999, Math.max(0, n));
  } catch {
    return 0;
  }
}

function saveHiScoreIfBeat(currentBlocks) {
  const prev = loadHiScore();
  if (currentBlocks > prev) {
    try {
      localStorage.setItem(HI_SCORE_STORAGE_KEY, String(currentBlocks));
    } catch {
      /* ignore */
    }
  }
}

function updateArcadeHud() {
  const scoreEl = document.getElementById('hud-score');
  const hiEl = document.getElementById('hud-hi');
  const creditEl = document.getElementById('hud-credit');
  const v = Math.max(0, blockCount);
  if (scoreEl) scoreEl.textContent = String(v).padStart(3, '0');
  if (hiEl) hiEl.textContent = String(loadHiScore()).padStart(3, '0');
  if (creditEl) creditEl.textContent = String(Math.max(0, Math.min(99, credits))).padStart(2, '0');
}

function playInsertCoinSound() {
  ensureAudio();
  if (!audioCtx) return;
  const run = () => {
    const now = audioCtx.currentTime;
    [880, 1100, 1320].forEach((freq, i) => {
      const t0 = now + i * 0.06;
      const osc = audioCtx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = freq;
      const g = audioCtx.createGain();
      g.gain.setValueAtTime(0.001, t0);
      g.gain.exponentialRampToValueAtTime(0.09, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.08);
      osc.connect(g);
      g.connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.09);
    });
  };
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().then(run).catch(run);
  } else {
    run();
  }
}

function showInsertCoinPrompt() {
  const el = document.getElementById('insert-coin-prompt');
  if (!el) return;
  el.classList.add('insert-coin-prompt--visible');
  el.setAttribute('aria-hidden', 'false');
}

function hideInsertCoinPrompt() {
  const el = document.getElementById('insert-coin-prompt');
  if (!el) return;
  el.classList.remove('insert-coin-prompt--visible');
  el.setAttribute('aria-hidden', 'true');
}

function insertCoin() {
  if (credits >= 1) return false;
  credits = 1;
  gameKrAddress = buildRandomKrRoadAddress();
  updateArcadeHud();
  playInsertCoinSound();
  hideInsertCoinPrompt();
  markManualSpacePlay();
  updateAddrDisplay();
  return true;
}

function updateRulerGauge() {
  const fill = document.getElementById('ruler-gauge-fill');
  if (!fill) return;
  const pct = Math.min(100, (blockCount / MEMORY_DISPLAY_CAP) * 100);
  fill.style.height = `${pct}%`;
}

/** 한 게임(크레딧으로 시작~게임 오버)당 하나 — insertCoin 또는 최초 로드 시 부여 */
let gameKrAddress = null;

function pickKr(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function rndKrInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function buildRandomKrRoadAddress() {
  const sidoSigungu = [
    ['서울특별시', '강남구'],
    ['서울특별시', '마포구'],
    ['서울특별시', '송파구'],
    ['서울특별시', '영등포구'],
    ['서울특별시', '종로구'],
    ['부산광역시', '해운대구'],
    ['부산광역시', '부산진구'],
    ['인천광역시', '연수구'],
    ['대구광역시', '수성구'],
    ['광주광역시', '서구'],
    ['대전광역시', '유성구'],
    ['울산광역시', '남구'],
    ['세종특별자치시', '한솔동'],
    ['경기도', '수원시 영통구'],
    ['경기도', '성남시 분당구'],
    ['경기도', '용인시 기흥구'],
    ['경기도', '고양시 일산동구'],
    ['경기도', '부천시 원미구'],
    ['강원특별자치도', '춘천시'],
    ['충청북도', '청주시 흥덕구'],
    ['충청남도', '천안시 서북구'],
    ['전북특별자치도', '전주시 완산구'],
    ['전라남도', '여수시'],
    ['경상북도', '포항시 남구'],
    ['경상남도', '창원시 성산구'],
    ['제주특별자치도', '제주시']
  ];
  const road = [
    '테헤란로',
    '강남대로',
    '중앙로',
    '논현로',
    '봉은사로',
    '해운대로',
    '광안로',
    '어울마당로',
    '종로',
    '세종로',
    '월드컵북로',
    '마포대로',
    '판교로',
    '동백로',
    '광교로',
    '수성로',
    '온천천로',
    '학동로',
    '백제고분로',
    '탑동로',
    '연동로',
    '노형로',
    '중앙로1가길'
  ];
  const dong = [
    '역삼동',
    '논현동',
    '청담동',
    '합정동',
    '상암동',
    '여의도동',
    '잠실동',
    '해운대동',
    '연남동',
    '부평동',
    '구월동',
    '봉명동',
    '온천동',
    '연동',
    '노형동',
    '이도이동',
    '화도읍',
    '대관령면'
  ];
  const [sido, sigungu] = pickKr(sidoSigungu);
  const roll = Math.random();
  if (roll < 0.55) {
    const r = pickKr(road);
    const main = rndKrInt(8, 420);
    if (Math.random() < 0.42) {
      const gil = rndKrInt(1, 22);
      const tail = rndKrInt(1, 99);
      return `${sido} ${sigungu} ${r} ${gil}번길 ${tail}`;
    }
    return `${sido} ${sigungu} ${r} ${main}`;
  }
  if (roll < 0.82) {
    const d = pickKr(dong);
    const bun = rndKrInt(1, 198);
    const ji = rndKrInt(1, 48);
    return `${sido} ${sigungu} ${d} ${bun}-${ji}`;
  }
  const apt = pickKr(['래미안', '자이', '푸르지오', 'e편한세상', '스카이', '힐스테이트']);
  const dongNum = rndKrInt(101, 2505);
  const ho = rndKrInt(1, 35);
  return `${sido} ${sigungu} ${apt} ${dongNum}동 ${ho}호`;
}

const ENDING_NAMES_FAMILY = [
  '김',
  '이',
  '박',
  '최',
  '정',
  '강',
  '조',
  '윤',
  '장',
  '임',
  '한',
  '오',
  '서',
  '신',
  '권',
  '황',
  '안',
  '송',
  '류',
  '홍'
];

/**
 * 시대별 한국 이름 유행을 반영한 given name 풀.
 * 게임 안 사망 시점 나이를 받아서 그 사람이 "태어났을 시대"에 맞는 이름을 고른다.
 *  - 0~15세  : 2010~현재 트렌드 (하율, 서윤, 도윤 …)
 *  - 16~29세 : 1995~2010 출생대
 *  - 30~44세 : 1980~1995 출생대
 *  - 45~59세 : 1965~1980 출생대
 *  - 60~74세 : 1950~1965 출생대
 *  - 75~89세 : 1935~1950 출생대
 *  - 90+     : ~1935 출생대 (해방 이전 정서)
 */
const ENDING_GIVEN_BY_ERA = {
  modern: [
    '하율', '서윤', '도윤', '시우', '하은', '서연', '지안', '예은',
    '다온', '라온', '시온', '유주', '채원', '이안', '로아', '주아',
    '예린', '리아', '하린', '연우',
    '서아', '하린', '지우', '서하', '윤슬', '이든', '도하', '하온',
    '서진', '지율', '은우', '하람', '수아', '아린', '민준', '예서'
  ],
  young: [
    '민준', '서준', '지후', '건우', '예준', '지민', '유진', '민서',
    '수아', '채영', '다은', '윤서', '지윤', '도현', '예린', '하진',
    '서영', '재현', '준영', '소율',
    '수빈', '현서', '예지', '지수', '민지', '지은', '주원', '승현',
    '동현', '태훈', '정우', '현우', '은지', '혜진', '지현', '수현',
    '민수', '정민', '지호', '하영'
  ],
  midearly: [
    '지영', '현우', '수진', '미정', '은정', '보람', '진수', '정민',
    '동현', '민정', '영훈', '혜진', '승현', '가영', '종민', '윤정',
    '상호', '은주', '경민', '지혜',
    '성민', '성훈', '재훈', '재영', '수경', '수현', '수정', '영미',
    '영희', '선영', '선희', '지은', '지현', '현정', '현숙', '미경',
    '정훈', '정호', '정우', '경희'
  ],
  midlate: [
    '영수', '미숙', '정희', '영미', '명숙', '경자', '철수', '진희',
    '종철', '인숙', '옥희', '동수', '순영', '광수', '명희', '병철',
    '정자', '경숙', '재호', '순희',
    '영철', '상철', '상수', '상훈', '성호', '성수', '성철', '기철',
    '기수', '기호', '진수', '진호', '미영', '미자', '미경', '영자',
    '영숙', '정숙', '정순', '정미'
  ],
  senior: [
    '정숙', '영자', '순자', '명자', '만수', '정수', '영기', '정애',
    '영순', '종근', '정호', '길수', '옥자', '영애', '명순', '병수',
    '재근', '봉희', '동근', '말순',
    '춘자', '춘희', '미자', '복자', '복순', '정희', '정순', '순희',
    '영희', '영숙', '영순', '명숙', '명희', '상기', '성기', '동식',
    '동호', '재수', '재덕', '재식'
  ],
  elder: [
    '옥자', '분이', '영순', '갑순', '종근', '봉수', '만석', '영덕',
    '두만', '끝순', '점순', '막순', '봉희', '귀순', '만복', '순돌',
    '복순', '천수', '옥분', '분옥',
    '칠성', '칠복', '만수', '만덕', '만식', '만철', '봉식', '봉철',
    '순덕', '순애', '순남', '순임', '귀덕', '귀자', '옥순', '옥남',
    '옥례', '분례', '분순', '갑돌'
  ],
  ancient: [
    '길동', '막달', '봉이', '점순', '칠성', '만덕', '옥분', '분례',
    '임순', '천복', '갑돌', '갑순', '말자', '돌이', '봉남', '말순',
    '곱단', '귀남', '점동', '칠복',
    '복동', '복례', '복순', '만복', '만석', '덕수', '덕구', '덕만',
    '금례', '금순', '금동', '춘복', '춘삼', '춘호', '봉수', '봉식',
    '봉철', '갑수', '갑만', '임복'
  ]
};

function pickGivenPoolByAge(age) {
  if (age <= 15) return ENDING_GIVEN_BY_ERA.modern;
  if (age <= 29) return ENDING_GIVEN_BY_ERA.young;
  if (age <= 44) return ENDING_GIVEN_BY_ERA.midearly;
  if (age <= 59) return ENDING_GIVEN_BY_ERA.midlate;
  if (age <= 74) return ENDING_GIVEN_BY_ERA.senior;
  if (age <= 89) return ENDING_GIVEN_BY_ERA.elder;
  return ENDING_GIVEN_BY_ERA.ancient;
}

function pickRandomEndingName(age = 0) {
  const given = pickGivenPoolByAge(Math.max(0, Math.floor(age)));
  return `${pickKr(ENDING_NAMES_FAMILY)}${pickKr(given)}`;
}

function updateAddrDisplay() {
  if (!addrDisplayEl) return;
  if (credits < 1) {
    addrDisplayEl.textContent = '주소: —';
  } else {
    if (gameKrAddress == null) {
      gameKrAddress = buildRandomKrRoadAddress();
    }
    addrDisplayEl.textContent = `주소: ${gameKrAddress}`;
    /** 크레딧이 있으면 중앙 코인 안내는 항상 숨김(클래스 잔류·초기 상태 버그 방지) */
    hideInsertCoinPrompt();
  }
  updateArcadeHud();
  updateRulerGauge();
  updateAgeDisplay();
}

function updateAgeDisplay() {
  const ageValEl = document.getElementById('age-value');
  if (!ageValEl) return;
  const age = Math.max(0, blockCount);
  ageValEl.textContent = age < 100 ? `나이 ${String(age).padStart(2, '0')} 세` : `나이 ${age} 세`;
}

(function initTerminalHud() {
  const ruler = document.getElementById('terminal-ruler');
  if (ruler) {
    ruler.innerHTML = '';
    for (let n = 0; n <= MEMORY_DISPLAY_CAP; n++) {
      const s = document.createElement('span');
      s.className = 'terminal-ruler__tick';
      s.textContent = String(n);
      ruler.appendChild(s);
    }
  }
})();

function hideDataDump() {
  const root = document.getElementById('data-dump');
  if (!root) return;
  root.classList.remove('data-dump--active');
  root.classList.remove('data-dump--dense');
}

function flashDataLog(gx, iy) {
  if (!dataLogEl) return;
  dataLogEl.textContent = `[기록 @0x${blockCount.toString(16).toUpperCase().padStart(2, '0')}  열${gx}_행${iy}]`;
  dataLogEl.classList.remove('data-log--flash');
  void dataLogEl.offsetHeight;
  dataLogEl.classList.add('data-log--flash');
}

/** 1크레딧 = 1플레이(게임 오버 후 0, 스페이스로 코인) */
let credits = 1;

let explodeHudLine = '게임 오버';

let overflowPhase = 'none';
let overflowPhaseStartMs = 0;
let overflowDumpLastRebuildMs = 0;
let frozenGlitchTime = 0;
const OVERFLOW_FREEZE_MS = 500;
const OVERFLOW_DUMP_MS = 1500;
const OVERFLOW_ARCHIVE_MS = 2200;
/** 정의서 모드: 아카이브(승화) 구간 — 1px 라인 상승 연출 길이에 맞춤 */
const OVERFLOW_ARCHIVE_MS_SPEC = 5200;
/** explode: 게임 오버 후 이어하기? 9→0 카운트다운(숫자당 1초) */
const OVERFLOW_EXPLODE_GAMEOVER_MS = 800;
const OVERFLOW_CONTINUE_STEP_MS = 1000;
const OVERFLOW_CONTINUE_STEPS = 10;
const OVERFLOW_BLOOM_BURST = 12;
const blockBasePositions = new WeakMap();

/**
 * 엔딩 멘트(오버레이) 대신 "마지막 블록이 쌓인 화면"만 보이게 하는 옵션.
 * - true: 사망/오버플로우 직전 화면을 프리즈하고 스페이스로 즉시 리스타트
 * - false: 기존처럼 엔딩 오버레이/연출 진행
 */
const ENDING_LAST_FRAME_ONLY =
  new URLSearchParams(location.search).get('endingLastFrameOnly') === '1';
let endingHoldMode = 'none'; // 'none' | 'death' | 'overflow'

function restartRunFromEndingHold() {
  endingHoldMode = 'none';
  hideCollapseResultOverlay();
  hideArchiveOverlay();
  hideOverflowMatrixOverlay();
  hideDataDump();
  clearAutoRestartTimer();
  clearBoardMeshesAndGrid();
  cursorGx = Math.floor(GRID_X / 2);
  cursor.visible = true;
  physicsCollapseActive = false;
  matterEngine = null;
  matterWorld = null;
  matterApiRef = null;
  collapseSyncList = [];
  overflowPhase = 'none';
  playfieldRoot.scale.set(1, 1, 1);
  playfieldRoot.position.set(0, 0, 0);
  scene.background.setHex(0xffffff);
  renderer.setClearColor(0xffffff, 1);
  bloomPass.strength = BLOOM_STRENGTH_NORMAL;
  glitchPass.uniforms.uIntensity.value = 0;
  camera.position.copy(CAMERA_BASE);
  camera.lookAt(0, GRID_VIEW_CENTER_Y, 0);
  cameraShakeFramesLeft = 0;
  variableGridGroup.position.set(0, 0, 0);
  cursorGhosts.forEach((g) => {
    g.life = 0;
    g.mesh.visible = false;
  });
  credits = 1;
  gameKrAddress = buildRandomKrRoadAddress();
  hideInsertCoinPrompt();
  updateAddrDisplay();
  updateCursorMesh();
  markManualSpacePlay();
}

function enterDeathLastFrameHold() {
  endingHoldMode = 'death';
  credits = 0;
  updateArcadeHud();
  cursor.visible = false;
  clearAutoRestartTimer();
  hideCollapseResultOverlay();
  hideInsertCoinPrompt();
  resetSurvivalHudIdle();
}

function enterOverflowLastFrameHold() {
  endingHoldMode = 'overflow';
  credits = 0;
  updateArcadeHud();
  cursor.visible = false;
  hideArchiveOverlay();
  hideOverflowMatrixOverlay();
  hideInsertCoinPrompt();
}

function clearBoardMeshesAndGrid() {
  placedBlocks.length = 0;
  for (let x = 0; x < GRID_X; x++) {
    for (let y = 0; y < MAX_Y; y++) {
      const m = grid[x][y];
      if (m) {
        blockGroup.remove(m);
        m.traverse((ch) => {
          if (ch.geometry && ch.geometry !== boxGeo && ch.geometry !== edgeGeo) {
            ch.geometry.dispose();
          }
          if (ch.material) ch.material.dispose();
        });
      }
      grid[x][y] = null;
    }
  }
  blockCount = 0;
}

/** 글리치·사운드·로그 없이 블록만 쌓음 (단축키 엔딩을 실제 85칸과 동일 연출로 맞추기 위함) */
function placeBlockSilent(gx, iy) {
  const mesh = createDataBlock(blockCount + 1);
  mesh.position.set(gxToWorldX(gx), iyToWorldY(iy), PLANE_Z);
  blockBasePositions.set(mesh, mesh.position.clone());
  mesh.userData.gx = gx;
  mesh.userData.iy = iy;
  blockGroup.add(mesh);
  grid[gx][iy] = mesh;
  placedBlocks.push(mesh);
  blockCount++;
}

/** 남은 칸을 (열→행) 스캔 순으로 채워 표시 상한까지 (중간 랜덤 글리치 없음) */
function fillBoardToMemoryCapSilent() {
  outer: for (let x = 0; x < GRID_X; x++) {
    for (let y = 0; y < MAX_Y; y++) {
      if (blockCount >= MEMORY_DISPLAY_CAP) break outer;
      if (grid[x][y] !== null) continue;
      placeBlockSilent(x, y);
    }
  }
}

/**
 * 오버플로우 엔딩의 유일 진입점 (플레이로 85칸 달성 시).
 * 85칸 미만이면 조용히 채운 뒤 동일 시퀀스 시작.
 */
function forceOverflowEnding() {
  if (overflowPhase !== 'none') return;
  cancelIdleNav();
  if (blockCount >= MEMORY_DISPLAY_CAP) {
    startOverflowEnding();
    return;
  }
  fillBoardToMemoryCapSilent();
  const last = placedBlocks[placedBlocks.length - 1];
  if (last && last.userData.gx !== undefined) {
    cursorGx = last.userData.gx;
  }
  updateAddrDisplay();
  updateCursorMesh();
  startOverflowEnding();
}

function showArchiveOverlay() {
  const el = document.getElementById('archive-overlay');
  if (!el) return;
  const age = Math.max(0, blockCount);
  const pre = el.querySelector('.archive-overlay__pre');
  const sub = el.querySelector('.archive-overlay__sub');
  if (pre) pre.textContent = `★ ${age}세. 여기까지 ★`;
  if (sub) sub.textContent = '한 칸이 한 해. 끝은 늘 한 번이다.';
  el.removeAttribute('hidden');
  el.classList.add('archive-overlay--active');
  el.setAttribute('aria-hidden', 'false');
  if (WORK_SPEC_CONSTRUCTION_DECLINE) {
    document.documentElement.classList.add('archive-sublime-active');
  }
}

function hideArchiveOverlay() {
  const el = document.getElementById('archive-overlay');
  if (!el) return;
  el.setAttribute('hidden', '');
  el.classList.remove('archive-overlay--active');
  el.setAttribute('aria-hidden', 'true');
  document.documentElement.classList.remove('archive-sublime-active');
}

/** 내부: forceOverflowEnding()에서만 호출 — 프리즈 → 덤프 → 아카이브 → 화이트아웃 → 콜드 리부트 */
function startOverflowEnding() {
  cancelIdleNav();
  playfieldRoot.scale.set(1, 1, 1);
  playfieldRoot.position.set(0, 0, 0);
  cursor.visible = false;
  overflowPhase = 'freeze';
  overflowPhaseStartMs = performance.now();
  frozenGlitchTime = performance.now() * 0.001;
  stopAmbient();
  ensureAudio();
  playOverflowWarningSting();
  playOverflowSiren();
  setShellOverflowPhase('freeze');
  syncOverflowArcadeHud();
}

function buildOverflowMatrixContent() {
  const lines = [];
  placedBlocks.forEach((obj, idx) => {
    const gx = obj.userData.gx;
    const iy = obj.userData.iy;
    lines.push(`0x${idx.toString(16).padStart(2, '0').toUpperCase()}  열${gx}  행${iy}`);
  });
  const coordBlock = lines.join('\n');
  const bitCols = [];
  for (let c = 0; c < 64; c++) {
    let s = '';
    for (let r = 0; r < 96; r++) {
      s += Math.random() < 0.5 ? '0' : '1';
      if ((r + 1) % 8 === 0) s += ' ';
    }
    bitCols.push(s);
  }
  const noise = bitCols.join('\n');
  return `${coordBlock}\n\n${noise}\n\n${coordBlock}\n\n${noise}\n\n${coordBlock}`;
}

function showOverflowMatrixOverlay() {
  const root = document.getElementById('overflow-matrix');
  const pre = document.getElementById('overflow-matrix-pre');
  if (!root || !pre) return;
  pre.textContent = buildOverflowMatrixContent();
  root.removeAttribute('hidden');
  root.classList.add('overflow-matrix--active');
  root.setAttribute('aria-hidden', 'false');
}

function hideOverflowMatrixOverlay() {
  const root = document.getElementById('overflow-matrix');
  if (!root) return;
  root.setAttribute('hidden', '');
  root.classList.remove('overflow-matrix--active');
  root.setAttribute('aria-hidden', 'true');
}

function playOverflowExplosionNoise() {
  ensureAudio();
  const run = () => {
    const dur = 0.9;
    const len = Math.floor(audioCtx.sampleRate * dur);
    const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.99, audioCtx.currentTime);
    src.connect(g);
    g.connect(audioCtx.destination);
    src.start();
  };
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().then(run).catch(run);
  } else {
    run();
  }
}

function coldRebootOverflow() {
  saveHiScoreIfBeat(blockCount);
  cancelIdleNav();
  clearBoardMeshesAndGrid();
  cursorGx = Math.floor(GRID_X / 2);
  overflowPhase = 'none';
  frozenGlitchTime = performance.now() * 0.001;
  playfieldRoot.scale.set(1, 1, 1);
  playfieldRoot.position.set(0, 0, 0);
  cursor.visible = true;
  hideArchiveOverlay();
  scene.background.setHex(0xffffff);
  renderer.setClearColor(0xffffff, 1);
  bloomPass.strength = BLOOM_STRENGTH_NORMAL;
  glitchPass.uniforms.uIntensity.value = 0;
  camera.position.copy(CAMERA_BASE);
  camera.lookAt(0, GRID_VIEW_CENTER_Y, 0);
  cameraShakeFramesLeft = 0;
  variableGridGroup.position.set(0, 0, 0);
  cursorGhosts.forEach((g) => {
    g.life = 0;
    g.mesh.visible = false;
  });
  hideOverflowMatrixOverlay();
  hideDataDump();
  setShellOverflowPhase('none');
  syncOverflowArcadeHud();
  updateCursorMesh();
  stopAmbient();
  if (audioCtx) {
    audioCtx.suspend().catch(() => {});
  }
  credits = 0;
  gameKrAddress = null;
  updateArcadeHud();
  document.getElementById('app-shell')?.removeAttribute('data-continue-white');
  document.body.classList.remove('system-reboot-wait');
  showInsertCoinPrompt();
  updateAddrDisplay();
}

function setShellOverflowPhase(phase) {
  const shell = document.getElementById('app-shell');
  if (!shell) return;
  if (!phase || phase === 'none') {
    shell.removeAttribute('data-overflow-phase');
  } else {
    shell.setAttribute('data-overflow-phase', phase);
  }
}

function syncOverflowArcadeHud() {
  const root = document.getElementById('arcade-phase-hud');
  const text = document.getElementById('arcade-phase-hud-text');
  const badge = document.getElementById('arcade-phase-hud-badge');
  const sub = document.getElementById('arcade-phase-hud-sub');
  if (!root || !text) return;
  if (overflowPhase === 'none' || overflowPhase === 'archive') {
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    if (overflowPhase === 'none') {
      setShellOverflowPhase('none');
    }
    return;
  }
  if (overflowPhase === 'explode') {
    const shell = document.getElementById('app-shell');
    if (explodeHudLine.startsWith('이어하기')) {
      if (shell) shell.setAttribute('data-continue-white', '1');
      text.textContent = explodeHudLine;
      if (badge) badge.textContent = '';
      if (sub) sub.textContent = '';
      root.hidden = false;
      root.setAttribute('aria-hidden', 'false');
      hideInsertCoinPrompt();
      return;
    }
    if (shell) shell.removeAttribute('data-continue-white');
    text.textContent = explodeHudLine;
    if (badge) badge.textContent = '';
    if (sub) sub.textContent = '1인 플레이 · 종료';
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    hideInsertCoinPrompt();
    return;
  }
  if (overflowPhase === 'freeze') {
    const age = blockCount;
    if (badge) badge.textContent = `나이 ${String(age).padStart(2, '0')}`;
    text.textContent = `${age}세까지 살았다`;
    if (sub) sub.textContent = `${age}살을 살다가 갔다`;
  } else if (overflowPhase === 'dump') {
    if (badge) badge.textContent = '99단계';
    text.textContent = '데이터 흘려보내기';
    if (sub) sub.textContent = '전원 끄지 마시오 —';
  } else {
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    return;
  }
  root.hidden = false;
  root.setAttribute('aria-hidden', 'false');
}

function tickOverflowSequence(now) {
  glitchPass.uniforms.uTime.value = frozenGlitchTime;
  const elapsed = now - overflowPhaseStartMs;

  if (overflowPhase === 'freeze') {
    if (elapsed >= OVERFLOW_FREEZE_MS) {
      overflowPhase = 'dump';
      overflowPhaseStartMs = now;
      overflowDumpLastRebuildMs = now;
      showOverflowMatrixOverlay();
    }
  } else if (overflowPhase === 'dump') {
    if (now - overflowDumpLastRebuildMs >= 56) {
      overflowDumpLastRebuildMs = now;
      const pre = document.getElementById('overflow-matrix-pre');
      if (pre) pre.textContent = buildOverflowMatrixContent();
    }
    if (elapsed >= OVERFLOW_DUMP_MS) {
      overflowPhase = 'archive';
      overflowPhaseStartMs = now;
      hideOverflowMatrixOverlay();
      if (ENDING_LAST_FRAME_ONLY) {
        // 마지막 프레임(덤프 종료 직후)을 고정하고 엔딩 텍스트는 띄우지 않는다.
        enterOverflowLastFrameHold();
        overflowPhase = 'none';
        return;
      }
      showArchiveOverlay();
    }
  } else if (overflowPhase === 'archive') {
    const archiveHoldMs = WORK_SPEC_CONSTRUCTION_DECLINE
      ? OVERFLOW_ARCHIVE_MS_SPEC
      : OVERFLOW_ARCHIVE_MS;
    if (elapsed >= archiveHoldMs) {
      if (WORK_SPEC_CONSTRUCTION_DECLINE) {
        hideArchiveOverlay();
        coldRebootOverflow();
        return;
      }
      overflowPhase = 'explode';
      overflowPhaseStartMs = now;
      explodeHudLine = '게임 오버';
      hideArchiveOverlay();
      scene.background.setHex(0xffffff);
      renderer.setClearColor(0xffffff, 1);
      bloomPass.strength = OVERFLOW_BLOOM_BURST;
      glitchPass.uniforms.uIntensity.value = 0;
      playGameOverSting();
      playOverflowExplosionNoise();
    }
  } else if (overflowPhase === 'explode') {
    const go = OVERFLOW_EXPLODE_GAMEOVER_MS;
    const stepMs = OVERFLOW_CONTINUE_STEP_MS;
    const steps = OVERFLOW_CONTINUE_STEPS;
    if (elapsed < go) {
      explodeHudLine = '게임 오버';
    } else if (elapsed < go + stepMs * steps) {
      const step = Math.floor((elapsed - go) / stepMs);
      const n = 9 - step;
      explodeHudLine = `이어하기? ${Math.max(0, n)}`;
    } else {
      coldRebootOverflow();
      return;
    }
  }

  setShellOverflowPhase(overflowPhase);
  syncOverflowArcadeHud();

  composer.render();
}

function tryIdleAutoPlace() {
  if (WORK_SPEC_CONSTRUCTION_DECLINE) return;
  if (overflowPhase !== 'none') return;
  if (physicsCollapseActive) return;
  if (credits < 1) return;
  if (idleNavActive) return;
  const now = performance.now();
  if (now - lastManualSpacePlayMs < IDLE_MANUAL_SPACE_QUIET_MS) return;
  if (nextIdleAutoPlaceAtMs === 0) {
    nextIdleAutoPlaceAtMs = lastManualSpacePlayMs + IDLE_MANUAL_SPACE_QUIET_MS;
  }
  if (now < nextIdleAutoPlaceAtMs) return;
  const gx = pickPlacementColumnForIdleAuto();
  if (gx === null) {
    // 더 이상 놓을 칸이 없으면(자동쌓기 정지) 오버플로우 엔딩으로 종결.
    forceOverflowEnding();
    return;
  }
  const collapsingBefore = physicsCollapseActive;
  attemptPlacingOneBlock(gx);
  if (physicsCollapseActive && !collapsingBefore) return;
  nextIdleAutoPlaceAtMs += IDLE_AUTO_PLACE_INTERVAL_MS;
  while (nextIdleAutoPlaceAtMs <= now) {
    nextIdleAutoPlaceAtMs += IDLE_AUTO_PLACE_INTERVAL_MS;
  }
}

function updateSurvivalHud(nextAge, survivalPct) {
  const elA = document.getElementById('survival-hud-age');
  const elS = document.getElementById('survival-hud-rate');
  if (elA) elA.textContent = `다음 ${nextAge} 살`;
  if (elS) elS.textContent = `이번 해 ${Number(survivalPct).toFixed(3)}%`;
}

function resetSurvivalHudIdle() {
  const elA = document.getElementById('survival-hud-age');
  const elS = document.getElementById('survival-hud-rate');
  if (elA) elA.textContent = '다음 — 살';
  if (elS) elS.textContent = '이번 해 —%';
}

let matterApiRef = null;
let pendingCollapseUi = null;

function placeBlockAtColumn(gx) {
  if (overflowPhase !== 'none') return false;
  if (credits < 1) return false;
  const iy = lowestEmptySlot(gx);
  if (iy === null) return false;
  const mesh = createDataBlock(blockCount + 1);
  mesh.position.set(gxToWorldX(gx), iyToWorldY(iy), PLANE_Z);
  blockBasePositions.set(mesh, mesh.position.clone());
  mesh.userData.gx = gx;
  mesh.userData.iy = iy;
  blockGroup.add(mesh);
  grid[gx][iy] = mesh;
  placedBlocks.push(mesh);
  blockCount++;
  cursorGx = gx;
  updateAddrDisplay();
  playDataTickSound(gx, iy);
  flashDataLog(gx, iy);
  cameraShakeFramesLeft = 3;
  triggerPlaceFlash();
  triggerBezelInputFlash();
  updateCursorMesh();
  return true;
}

/** 생존 검사 후 한 칸 쌓기 — 스페이스 한 번당 한 번만 호출 */
function attemptPlacingOneBlock(gx) {
  if (physicsCollapseActive) return false;
  if (overflowPhase !== 'none') return false;
  if (credits < 1) return false;
  const nextAge = blockCount + 1;
  const survivalPct = getAnnualSurvivalPercentForAge(nextAge);
  updateSurvivalHud(nextAge, survivalPct);
  if (!checkSurvival(nextAge)) {
    if (ENDING_LAST_FRAME_ONLY) {
      // "죽는 해"에는 블록을 추가하지 않으므로, 지금 화면이 곧 마지막 스택 상태.
      enterDeathLastFrameHold();
      return false;
    }
    void triggerCollapse(nextAge);
    return false;
  }
  const ok = placeBlockAtColumn(gx);
  if (ok) {
    saveHiScoreIfBeat(blockCount);
  } else {
    // 입력/자동 모두 공통: "현재 열"에 못 놓는 경우가 생길 수 있음.
    // 전체 보드에도 빈 칸이 없으면 엔딩으로 종결한다.
    if (pickPlacementColumnForIdleAuto() === null) {
      forceOverflowEnding();
    }
  }
  return ok;
}

function tryPlaceBlock() {
  attemptPlacingOneBlock(cursorGx);
}

async function triggerCollapse(fatalAge) {
  if (physicsCollapseActive) return;
  physicsCollapseActive = true;
  const survivedYears = blockCount;
  const marginalAnnualPct = getAnnualSurvivalPercentForAge(fatalAge);
  const cumulativeCohortPct = cumulativeCohortSurvivalPercent(survivedYears);
  pendingCollapseUi = { survivedYears, fatalAge, marginalAnnualPct, cumulativeCohortPct };
  playWhiteNoiseBurst(0.95);
  playOverflowExplosionNoise();
  cancelIdleNav();
  cursor.visible = false;

  const snapshot = [...placedBlocks];
  for (const g of snapshot) {
    const gx = g.userData.gx;
    const iy = g.userData.iy;
    if (gx !== undefined && iy !== undefined && grid[gx] && grid[gx][iy] === g) {
      grid[gx][iy] = null;
    }
  }
  placedBlocks.length = 0;
  blockCount = 0;
  updateRulerGauge();

  let Matter;
  try {
    Matter = await import('matter-js');
  } catch (err) {
    console.error(err);
    for (const g of snapshot) {
      blockGroup.remove(g);
    }
    collapseSyncList = [];
    matterEngine = null;
    matterWorld = null;
    matterApiRef = null;
    physicsCollapseActive = false;
    finalizeCollapseWithoutPhysics();
    return;
  }
  const Mo = Matter.default ?? Matter;
  matterApiRef = Mo;
  const { Engine, Bodies, Composite, Body } = Mo;

  const engine = Engine.create();
  const world = engine.world;
  world.gravity.y = 1.05;
  world.gravity.scale = 0.001;
  matterEngine = engine;
  matterWorld = world;
  collapseSyncList = [];

  const pad = CELL * 3;
  const floorY = GRID_WORLD_HEIGHT + CELL * 3;
  const floor = Bodies.rectangle(0, floorY, (gridXMax - gridXMin) + pad * 4, CELL * 2.5, {
    isStatic: true,
    friction: 0.95,
    frictionStatic: 1
  });
  const wallH = GRID_WORLD_HEIGHT * 2.5;
  const leftWall = Bodies.rectangle(gridXMin - CELL * 2, GRID_WORLD_HEIGHT * 0.5, CELL * 1.2, wallH, {
    isStatic: true,
    friction: 0.4
  });
  const rightWall = Bodies.rectangle(gridXMax + CELL * 2, GRID_WORLD_HEIGHT * 0.5, CELL * 1.2, wallH, {
    isStatic: true,
    friction: 0.4
  });
  Composite.add(world, floor, leftWall, rightWall);

  for (const g of snapshot) {
    const bx = g.position.x;
    const by = g.position.y;
    const body = Bodies.rectangle(bx, GRID_WORLD_HEIGHT - by, CELL * 0.98, CELL * 0.98, {
      angle: -g.rotation.z,
      restitution: 0.05,
      friction: 0.92,
      frictionAir: 0.018,
      density: 0.0018 + Math.random() * 0.001
    });
    Body.setVelocity(body, {
      x: (Math.random() - 0.5) * 5.5,
      y: (Math.random() - 0.5) * 4.2
    });
    Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.28);
    Composite.add(world, body);
    collapseSyncList.push({ group: g, body });
  }

  credits = 0;
  updateArcadeHud();
  collapseEndAtMs = performance.now() + 6200;
}

function finalizeCollapseWithoutPhysics() {
  const p = pendingCollapseUi;
  pendingCollapseUi = null;
  credits = 0;
  updateArcadeHud();
  if (p) showCollapseResultOverlay(p);
}

function endCollapsePhysicsPass() {
  const p = pendingCollapseUi;
  pendingCollapseUi = null;
  const Mo = matterApiRef;
  for (const { group } of collapseSyncList) {
    blockGroup.remove(group);
    group.traverse((ch) => {
      if (ch.geometry && ch.geometry !== boxGeo && ch.geometry !== edgeGeo) {
        ch.geometry.dispose();
      }
      if (ch.material && ch.material !== placedFillMat && ch.material !== blackMat) {
        if (Array.isArray(ch.material)) ch.material.forEach((m) => m.dispose());
        else ch.material.dispose();
      }
    });
  }
  collapseSyncList = [];
  if (matterEngine && Mo && typeof Mo.Engine.clear === 'function') {
    Mo.Engine.clear(matterEngine);
  }
  matterEngine = null;
  matterWorld = null;
  matterApiRef = null;
  physicsCollapseActive = false;
  if (p) showCollapseResultOverlay(p);
}

let autoRestartTimerId = null;

function clearAutoRestartTimer() {
  if (autoRestartTimerId !== null) {
    clearTimeout(autoRestartTimerId);
    autoRestartTimerId = null;
  }
}

function scheduleAutoRestart() {
  clearAutoRestartTimer();
  autoRestartTimerId = setTimeout(() => {
    autoRestartTimerId = null;
    const root = document.getElementById('collapse-result');
    if (root && !root.hidden) {
      restartRunFromResultOverlay();
    }
  }, 60000);
}

function showCollapseResultOverlay(ui) {
  const { survivedYears } = ui;
  const root = document.getElementById('collapse-result');
  const title = document.getElementById('collapse-result-title');
  const stats = document.getElementById('collapse-result-stats');
  const lived = Math.max(0, survivedYears);
  const endingName = pickRandomEndingName(lived);
  if (title) {
    title.textContent = `${endingName} / 나이 ${lived}세`;
  }
  if (stats) {
    stats.textContent = buildLifeNarrativeFiveLines(endingName, lived).join('\n');
  }
  if (root) {
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
  }
  resetSurvivalHudIdle();
  updateAgeDisplay();
  hideInsertCoinPrompt();
  scheduleAutoRestart();
}

function hideCollapseResultOverlay() {
  const root = document.getElementById('collapse-result');
  if (root) {
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
  }
}

function restartRunFromResultOverlay() {
  clearAutoRestartTimer();
  hideCollapseResultOverlay();
  clearBoardMeshesAndGrid();
  cursorGx = Math.floor(GRID_X / 2);
  cursor.visible = true;
  credits = 1;
  gameKrAddress = buildRandomKrRoadAddress();
  hideInsertCoinPrompt();
  updateAddrDisplay();
  updateCursorMesh();
  markManualSpacePlay();
}

/** 브라우저 전체화면 토글 — 단축키는 Shift+F */
function toggleFullscreen() {
  const docEl = document.documentElement;
  if (!document.fullscreenElement) {
    const req =
      docEl.requestFullscreen ||
      docEl.webkitRequestFullscreen ||
      docEl.mozRequestFullScreen ||
      docEl.msRequestFullscreen;
    if (req) req.call(docEl).catch(() => {});
  } else {
    const exit =
      document.exitFullscreen ||
      document.webkitExitFullscreen ||
      document.mozCancelFullScreen ||
      document.msExitFullscreen;
    if (exit) exit.call(document).catch(() => {});
  }
}

window.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || e.isComposing;

  if (!typing && !e.repeat && endingHoldMode !== 'none' && e.code === 'Space') {
    e.preventDefault();
    resumeAudioAndAmbient();
    restartRunFromEndingHold();
    return;
  }

  if (e.shiftKey && e.code === 'KeyF') {
    e.preventDefault();
    toggleFullscreen();
    return;
  }
  if (!typing && !e.repeat && e.shiftKey && (e.code === 'Digit1' || e.code === 'Numpad1')) {
    e.preventDefault();
    setDisplayAspectMode('9-16');
    return;
  }
  if (!typing && !e.repeat && e.shiftKey && (e.code === 'Digit2' || e.code === 'Numpad2')) {
    e.preventDefault();
    setDisplayAspectMode('9-21');
    return;
  }
  if (!typing && !e.repeat && e.shiftKey && e.code === 'KeyA') {
    e.preventDefault();
    forceOverflowEnding();
    return;
  }
  if (!typing && !e.repeat && e.shiftKey && e.code === 'KeyB') {
    e.preventDefault();
    if (!physicsCollapseActive && overflowPhase === 'none') {
      void triggerCollapse(Math.max(1, blockCount + 1));
    }
    return;
  }
  const collapseResultEl = document.getElementById('collapse-result');
  if (
    collapseResultEl &&
    !collapseResultEl.hidden &&
    e.code === 'Space' &&
    !e.repeat
  ) {
    e.preventDefault();
    resumeAudioAndAmbient();
    restartRunFromResultOverlay();
    return;
  }
  resumeAudioAndAmbient();
  if (physicsCollapseActive) return;
  if (overflowPhase !== 'none') return;
  if (e.code === 'Space' && credits < 1) {
    e.preventDefault();
    if (e.repeat) return;
    insertCoin();
    return;
  }
  if (e.code === 'ArrowLeft' || e.code === 'ArrowRight' || e.code === 'Space') {
    cancelIdleNav();
  }
  let moved = false;
  switch (e.code) {
    case 'ArrowLeft':
      if (cursorGx > 0) {
        {
          const s = lowestEmptySlot(cursorGx);
          const top = columnTopIndex(cursorGx);
          const hy =
            s !== null ? iyToWorldY(s) : top >= 0 ? iyToWorldY(top) : iyToWorldY(0);
          spawnCursorGhost(gxToWorldX(cursorGx), hy);
        }
        cursorGx--;
        moved = true;
      }
      e.preventDefault();
      break;
    case 'ArrowRight':
      if (cursorGx < GRID_X - 1) {
        {
          const s = lowestEmptySlot(cursorGx);
          const top = columnTopIndex(cursorGx);
          const hy =
            s !== null ? iyToWorldY(s) : top >= 0 ? iyToWorldY(top) : iyToWorldY(0);
          spawnCursorGhost(gxToWorldX(cursorGx), hy);
        }
        cursorGx++;
        moved = true;
      }
      e.preventDefault();
      break;
    case 'Space':
      e.preventDefault();
      if (WORK_SPEC_CONSTRUCTION_DECLINE && e.repeat) break;
      if (isSpacePressed) break;
      isSpacePressed = true;
      if (credits >= 1) {
        markManualSpacePlay();
        tryPlaceBlock();
      }
      break;
    default:
      break;
  }
  if (moved) updateCursorMesh();
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    isSpacePressed = false;
  }
});

function triggerPlaceFlash() {
  const el = document.getElementById('place-flash');
  if (!el) return;
  el.classList.remove('place-flash--tick');
  void el.offsetWidth;
  el.classList.add('place-flash--tick');
}

function triggerBezelInputFlash() {
  const shell = document.getElementById('app-shell');
  if (!shell) return;
  shell.classList.remove('app-shell--input-pulse');
  void shell.offsetWidth;
  shell.classList.add('app-shell--input-pulse');
}

function resizeRendererAndCamera() {
  const { w, h } = getCanvasSize();
  renderer.setSize(w, h);
  updateOrthographicCamera();
  resizeComposer();
}

const appShellEl = document.getElementById('app-shell');

function setDisplayAspectMode(mode) {
  cancelIdleNav();
  if (!appShellEl) return;
  appShellEl.classList.remove('app-shell--9-16', 'app-shell--9-21');
  if (mode === '9-21') {
    appShellEl.classList.add('app-shell--9-21');
    appShellEl.dataset.aspect = '9:21';
  } else {
    appShellEl.classList.add('app-shell--9-16');
    appShellEl.dataset.aspect = '9:16';
  }
  resizeRendererAndCamera();
}

window.addEventListener('resize', () => {
  resizeRendererAndCamera();
});

function onFullscreenChange() {
  resizeRendererAndCamera();
}
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);

const canvasWrapEl = document.getElementById('canvas-wrap');
if (canvasWrapEl && typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => resizeRendererAndCamera()).observe(canvasWrapEl);
}

resizeRendererAndCamera();

updateCursorMesh();
updateAddrDisplay();

/** 수동 스페이스 10초 없음 → 3초마다 한 칸 자동 (백그라운드 탭에서도 시간 기준 유지) */
setInterval(() => {
  tryIdleAutoPlace();
}, 250);

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  if (endingHoldMode !== 'none') {
    // 마지막 프레임만 유지: 입력은 스페이스(리스타트)만 허용되고,
    // 오버플로우/붕괴 시퀀스와 UI 오버레이는 진행하지 않는다.
    glitchPass.uniforms.uTime.value = now * 0.001;
    glitchPass.uniforms.uIntensity.value = 0;
    composer.render();
    return;
  }
  if (overflowPhase !== 'none') {
    tickOverflowSequence(now);
    return;
  }

  if (physicsCollapseActive && matterEngine && matterApiRef) {
    matterApiRef.Engine.update(matterEngine, 1000 / 60);
    for (const { group, body } of collapseSyncList) {
      group.position.x = body.position.x;
      group.position.y = GRID_WORLD_HEIGHT - body.position.y;
      group.rotation.z = -body.angle;
    }
    if (now >= collapseEndAtMs) {
      endCollapsePhysicsPass();
    }
  }

  if (idleNavActive) {
    if (now - idleNavLastStepMs >= IDLE_NAV_STEP_MS) {
      idleNavLastStepMs = now;
      if (cursorGx !== idleNavTargetGx) {
        const s = lowestEmptySlot(cursorGx);
        const top = columnTopIndex(cursorGx);
        const hy =
          s !== null ? iyToWorldY(s) : top >= 0 ? iyToWorldY(top) : iyToWorldY(0);
        spawnCursorGhost(gxToWorldX(cursorGx), hy);
        cursorGx += cursorGx < idleNavTargetGx ? 1 : -1;
        updateCursorMesh();
      }
      if (cursorGx === idleNavTargetGx) {
        idleNavActive = false;
        tryPlaceBlock();
      }
    }
  }

  glitchPass.uniforms.uTime.value = now * 0.001;
  {
    const nextAge = Math.max(1, blockCount + 1);
    const pd = getDeathProbabilityPercentForAge(nextAge);
    glitchPass.uniforms.uIntensity.value = 0.0022 * Math.min(1, pd / 18);
    variableGridGroup.position.set(0, 0, 0);
  }

  if (!physicsCollapseActive && placedBlocks.length > 0) {
    const refAge = Math.max(1, blockCount);
    const pRef = getDeathProbabilityPercentForAge(refAge);
    let jitterAmp = 0.00085 * pRef;
    if (pRef > 1 || refAge >= 60) {
      jitterAmp = 0.0045 + (pRef / 100) * 0.1;
    }
    placedBlocks.forEach((obj) => {
      const base = blockBasePositions.get(obj);
      if (!base) {
        blockBasePositions.set(obj, obj.position.clone());
        return;
      }
      const ageBlock = obj.userData.age || 1;
      const pb = getDeathProbabilityPercentForAge(ageBlock);
      const mult = pb > 1 ? 1.12 : 0.9;
      obj.position.x = base.x + (Math.random() - 0.5) * jitterAmp * mult;
      obj.position.y = base.y + (Math.random() - 0.5) * jitterAmp * mult;
    });
  }

  const span = gridXMax - gridXMin;
  const u = (now % SCANNER_PERIOD_MS) / SCANNER_PERIOD_MS;
  const tri = u < 0.5 ? u * 2 : 2 - u * 2;
  const scannerX = gridXMin + tri * span;
  scannerLine.position.set(
    scannerX + variableGridGroup.position.x,
    variableGridGroup.position.y,
    0
  );

  const scanWorldX = scannerLine.position.x;
  const scanHalf = CELL * 0.52;
  placedBlocks.forEach((obj) => {
    const edges = obj.userData.edges;
    if (!edges || obj.userData.gx === undefined) return;
    const cx = gxToWorldX(obj.userData.gx);
    const hit = Math.abs(scanWorldX - cx) < scanHalf;
    const pulse = 0.62 + 0.38 * Math.sin(now * 0.031);
    if (hit) {
      const t = 0.22 * pulse;
      edges.material.color.copy(PLACED_EDGE_COLOR).lerp(COLOR_WHITE, t);
    } else {
      edges.material.color.copy(PLACED_EDGE_COLOR);
    }
  });

  let camX = CAMERA_BASE.x;
  let camY = CAMERA_BASE.y;
  let appliedCamShake = false;
  if (cameraShakeFramesLeft > 0) {
    const mx = (0.05 + Math.random() * 0.05) * (Math.random() < 0.5 ? -1 : 1);
    const my = (0.05 + Math.random() * 0.05) * (Math.random() < 0.5 ? -1 : 1);
    camX += mx;
    camY += my;
    cameraShakeFramesLeft -= 1;
    appliedCamShake = true;
  }
  if (appliedCamShake) {
    camera.position.set(camX, camY, CAMERA_BASE.z);
    camera.lookAt(0, GRID_VIEW_CENTER_Y, 0);
  } else {
    camera.position.copy(CAMERA_BASE);
    camera.lookAt(0, GRID_VIEW_CENTER_Y, 0);
  }

  if (audioCtx && noiseFloorNodes && noiseFloorNodes.gain) {
    let ng = 0.008;
    if (blockCount <= PHASE_YOUTH_END) ng = 0.007;
    else if (blockCount <= PHASE_MATURE_END) ng = 0.014;
    else ng = 0.021;
    noiseFloorNodes.gain.gain.setTargetAtTime(ng, audioCtx.currentTime, 0.04);
  }

  tickCursorGhosts();
  updateEdgeSpectrograms();
  updateFloatingMeta(now);
  updateTerminalClock();

  composer.render();
}

animate();
