// 顔・目つぶり・笑顔の検出（MediaPipe Face Landmarker を端末内で実行）
// 写真はどこにも送られない。CDN から読み込むのはプログラムとモデルだけ。

const VERSION = '0.10.14';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

let landmarker = null;
let loading = null;

export function loadFaceModel() {
  if (landmarker) return Promise.resolve();
  loading ??= (async () => {
    const vision = await import(`${CDN}/vision_bundle.mjs`);
    const fileset = await vision.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
    landmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL, delegate: 'CPU' },
      runningMode: 'IMAGE',
      numFaces: 6,
      outputFaceBlendshapes: true,
      minFaceDetectionConfidence: 0.5,
    });
  })().catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

export function detectFaces(canvas) {
  const r = landmarker.detect(canvas);
  return (r.faceLandmarks || [])
    .map((lm, i) => {
      const bs = {};
      for (const c of r.faceBlendshapes?.[i]?.categories || []) bs[c.categoryName] = c.score;
      let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
      for (const p of lm) {
        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
        y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
      }
      const blink = ((bs.eyeBlinkLeft || 0) + (bs.eyeBlinkRight || 0)) / 2;
      const smile = ((bs.mouthSmileLeft || 0) + (bs.mouthSmileRight || 0)) / 2;
      return { closed: blink > 0.5, blink: round(blink), smile: round(smile), area: round((x1 - x0) * (y1 - y0)) };
    })
    .filter((f) => f.area > 0.002);
}

function round(x) {
  return Math.round(x * 1000) / 1000;
}
