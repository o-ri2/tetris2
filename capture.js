import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

// 캡쳐 전용: 엔딩/사운드/글리치/UI 없이 "블럭이 쌓인 모습"만.

const CELL = 1;
const GRID_X = 18;
const MAX_Y = 28;
const GRID_WORLD_HEIGHT = MAX_Y * CELL;
const GRID_VIEW_CENTER_Y = GRID_WORLD_HEIGHT * 0.5;

// 캡쳐 요구사항: "쌓이는 모습" 없이, 로드시 랜덤으로 쌓여진 상태만 즉시 표시.
// 0~120개 사이에서 "이미 쌓인 상태"를 랜덤 생성(캡쳐용).
const TARGET_BLOCKS_MIN = 0;
const TARGET_BLOCKS_MAX = 120;
const AUTO_CAPTURE_ON_LOAD = true;
const AUTO_CAPTURE_ON_RESET = true;
const USE_FOLDER_SAVE_WHEN_AVAILABLE = true;
// 로컬 저장(프로젝트 폴더의 `save_png/`)을 쓰려면 `npm run capture`로 서버를 실행하세요.
const SAVE_TO_PROJECT_FOLDER_WHEN_AVAILABLE = true;

function pickTargetBlocks() {
  const min = Math.max(0, TARGET_BLOCKS_MIN | 0);
  const max = Math.max(min, TARGET_BLOCKS_MAX | 0);
  return min + ((Math.random() * (max - min + 1)) | 0);
}

let outputDirHandle = null;

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function trySaveViaLocalServer(blob, filename) {
  if (!SAVE_TO_PROJECT_FOLDER_WHEN_AVAILABLE) return false;
  try {
    const res = await fetch('/api/save-png', {
      method: 'POST',
      headers: {
        'Content-Type': 'image/png',
        'X-Filename': filename
      },
      body: blob
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureOutputFolderPickedByUser() {
  if (!USE_FOLDER_SAVE_WHEN_AVAILABLE) return null;
  if (outputDirHandle) return outputDirHandle;
  if (typeof window.showDirectoryPicker !== 'function') return null;
  try {
    // 반드시 사용자 제스처(키 입력 등)에서만 호출 가능
    outputDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    return outputDirHandle;
  } catch {
    return null;
  }
}

async function saveBlobToPickedFolder(blob, filename) {
  const dir = await ensureOutputFolderPickedByUser();
  if (!dir) return false;
  try {
    const fileHandle = await dir.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch {
    return false;
  }
}

function capturePngOnce({ allowFolderPicker = false } = {}) {
  const ts = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${ts.getFullYear()}${p(ts.getMonth() + 1)}${p(ts.getDate())}_${p(ts.getHours())}${p(ts.getMinutes())}${p(ts.getSeconds())}`;
  const filename = `stack_${String(blockCount).padStart(3, '0')}blocks_${stamp}.png`;

  // 렌더가 끝난 다음 프레임에서 캡쳐(텍스처 업로드/후처리 반영 안정화)
  requestAnimationFrame(() => {
    try {
      canvas.toBlob((blob) => {
        if (!blob) return;
        void (async () => {
          // 1) (최우선) 로컬 저장 서버가 있으면 프로젝트 폴더 `save_png/`에 저장
          const okServer = await trySaveViaLocalServer(blob, filename);
          if (okServer) return;

          // 2) (차선) 브라우저 폴더 선택 저장(지원 브라우저/권한 필요)
          if (USE_FOLDER_SAVE_WHEN_AVAILABLE && (outputDirHandle || allowFolderPicker)) {
            const okFolder = await saveBlobToPickedFolder(blob, filename);
            if (okFolder) return;
          }

          // 3) 폴백: 다운로드
          downloadBlob(blob, filename);
        })();
      }, 'image/png');
    } catch {
      // ignore
    }
  });
}

const canvas = document.getElementById('c');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);

const ambientLight = new THREE.AmbientLight(0xffffff, 1.2);
scene.add(ambientLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
dirLight.position.set(5, 12, 100);
scene.add(dirLight);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio * 2, 3));
renderer.setClearColor(0xffffff, 1);

const FRUSTUM_BASE = 34 / 0.78;
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2500);
const CAMERA_BASE = new THREE.Vector3(0, 0, 100);
camera.position.copy(CAMERA_BASE);
camera.lookAt(0, GRID_VIEW_CENTER_Y, 0);

function getCanvasSize() {
  const rect = canvas.getBoundingClientRect();
  const w = Math.floor(rect.width || window.innerWidth);
  const h = Math.floor(rect.height || window.innerHeight);
  return { w: Math.max(1, w), h: Math.max(1, h) };
}

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

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomResolution = new THREE.Vector2(1, 1);
const bloomPass = new UnrealBloomPass(bloomResolution, 0.45, 0.6, 0.88);
composer.addPass(bloomPass);

function resizeAll() {
  const { w, h } = getCanvasSize();
  renderer.setSize(w, h, false);
  updateOrthographicCamera();
  composer.setSize(w, h);
  composer.setPixelRatio(Math.min(window.devicePixelRatio * 2, 3));
  bloomPass.setSize(w, h);
  bloomResolution.set(w, h);
  camera.position.copy(CAMERA_BASE);
  camera.lookAt(0, GRID_VIEW_CENTER_Y, 0);
}

resizeAll();
window.addEventListener('resize', resizeAll);

const offX = ((GRID_X - 1) * CELL) / 2;
function gxToWorldX(gx) { return gx * CELL - offX; }
function iyToWorldY(iy) { return iy * CELL + CELL * 0.5; }
const PLANE_Z = 0;

const grid = Array.from({ length: GRID_X }, () => Array.from({ length: MAX_Y }, () => null));
const placedBlocks = [];

const blockGroup = new THREE.Group();
scene.add(blockGroup);

const boxGeo = new THREE.BoxGeometry(CELL, CELL, CELL);
const edgeGeo = new THREE.EdgesGeometry(boxGeo);

// 원작(main.js)과 동일한 콘크리트 텍스처/머티리얼 세팅
const textureLoader = new THREE.TextureLoader();
const TEX_PATH = 'Concrete031_2K-JPG/Concrete031_2K-JPG_';
const concreteColorTex = textureLoader.load(TEX_PATH + 'Color.jpg');
const concreteNormalTex = textureLoader.load(TEX_PATH + 'NormalGL.jpg');
const concreteRoughnessTex = textureLoader.load(TEX_PATH + 'Roughness.jpg');
const concreteAOTex = textureLoader.load(TEX_PATH + 'AmbientOcclusion.jpg');

concreteColorTex.colorSpace = THREE.SRGBColorSpace;
[concreteColorTex, concreteNormalTex, concreteRoughnessTex, concreteAOTex].forEach((t) => {
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
  color: new THREE.Color(0.72, 0.70, 0.68)
});

const PLACED_EDGE_HEX = 0xb0b0b4;
const placedEdgeMat = new THREE.LineBasicMaterial({
  color: PLACED_EDGE_HEX,
  transparent: true,
  opacity: 0.18
});

function createBlock(age) {
  const a = Math.max(1, age | 0);
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

  const ox = Math.random();
  const oy = Math.random();
  [mat.map, mat.normalMap, mat.roughnessMap].forEach((t) => {
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

function lowestEmptySlot(gx) {
  for (let iy = 0; iy < MAX_Y; iy++) {
    if (grid[gx][iy]) continue;
    const supported = iy === 0 || grid[gx][iy - 1];
    if (supported) return iy;
  }
  return null;
}

function pickRandomPlacableColumn() {
  const candidates = [];
  for (let gx = 0; gx < GRID_X; gx++) {
    if (lowestEmptySlot(gx) !== null) candidates.push(gx);
  }
  if (candidates.length === 0) return null;
  return candidates[(Math.random() * candidates.length) | 0];
}

let blockCount = 0;

function placeOne(gx) {
  const iy = lowestEmptySlot(gx);
  if (iy === null) return false;
  const obj = createBlock(blockCount + 1);
  obj.position.set(gxToWorldX(gx), iyToWorldY(iy), PLANE_Z);
  obj.userData.gx = gx;
  obj.userData.iy = iy;
  blockGroup.add(obj);
  grid[gx][iy] = obj;
  placedBlocks.push(obj);
  blockCount += 1;
  return true;
}

function fillRandomStack(targetBlocks = 0) {
  const cap = GRID_X * MAX_Y;
  const target = Math.max(0, Math.min(cap, targetBlocks | 0));
  if (target > 0) {
    while (blockCount < target) {
      const gx = pickRandomPlacableColumn();
      if (gx === null) break;
      placeOne(gx);
    }
    return;
  }
  while (true) {
    const gx = pickRandomPlacableColumn();
    if (gx === null) break;
    placeOne(gx);
  }
}

function resetAll() {
  placedBlocks.forEach((g) => {
    blockGroup.remove(g);
    g.traverse((ch) => {
      if (ch.geometry && ch.geometry !== boxGeo && ch.geometry !== edgeGeo) ch.geometry.dispose();
      if (ch.material) ch.material.dispose();
    });
  });
  placedBlocks.length = 0;
  for (let x = 0; x < GRID_X; x++) for (let y = 0; y < MAX_Y; y++) grid[x][y] = null;
  blockCount = 0;
  fillRandomStack(pickTargetBlocks());
  if (AUTO_CAPTURE_ON_RESET) {
    composer.render();
    capturePngOnce({ allowFolderPicker: false });
  }
}

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.code === 'KeyR') {
    e.preventDefault();
    resetAll();
    return;
  }
  if (e.code === 'KeyF') {
    // 캡쳐 저장 폴더 선택(한 번만). 이후 자동 저장은 그 폴더로 시도.
    e.preventDefault();
    void ensureOutputFolderPickedByUser();
    return;
  }
  if (e.code === 'KeyC') {
    e.preventDefault();
    composer.render();
    capturePngOnce({ allowFolderPicker: true });
  }
});

function animate() {
  requestAnimationFrame(animate);
  composer.render();
}

// 최초 로드시 즉시 랜덤 스택 한 번 생성
fillRandomStack(pickTargetBlocks());
if (AUTO_CAPTURE_ON_LOAD) {
  composer.render();
  // 로드시엔 사용자 제스처가 아니어서 폴더 선택을 띄울 수 없음.
  // 폴더가 이미 선택된 상태(outputDirHandle)면 그 폴더에 저장 시도.
  capturePngOnce({ allowFolderPicker: false });
}
animate();
