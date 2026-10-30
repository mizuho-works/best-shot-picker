// 1枚ずつ縮小して特徴量を測る（すべて端末内で処理）
//  sharp  : ラプラシアン分散（タイル単位で上位3つの平均 = 被写体がくっきりしているか）
//  bright : 平均輝度 0..1 / blown: 白飛び率 / dark: 黒つぶれ率
//  hash   : dHash 64bit（構図の似ている度）/ colors: 4x4 の平均色（色合いの似ている度）

const SIZE = 512;

export async function analyzePhoto(file, detectFaces) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  try {
    // decode() は画面が裏にあると止まることがあるので onload で待つ
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('decode failed'));
      img.src = url;
    });
    const canvas = drawScaled(img, img.naturalWidth, img.naturalHeight);
    const res = measure(canvas);
    res.width = img.naturalWidth;
    res.height = img.naturalHeight;
    res.faces = detectFaces ? safe(() => detectFaces(canvas)) : null;
    res.thumb = await toBlob(canvas);
    return res;
  } finally {
    img.src = '';
    URL.revokeObjectURL(url);
  }
}

export async function analyzeVideo(file) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.preload = 'auto';
  v.src = url;
  try {
    await once(v, 'loadeddata', 15000);
    const dur = v.duration;
    const samples = [];
    let mid = null;
    for (const f of [0.15, 0.5, 0.85]) {
      v.currentTime = Math.max(0, Math.min(dur * f, dur - 0.05));
      try { await once(v, 'seeked', 5000); } catch { /* シーク失敗時は今のフレームで測る */ }
      const canvas = drawScaled(v, v.videoWidth, v.videoHeight);
      const m = measure(canvas);
      samples.push(m);
      if (f === 0.5) mid = { canvas, m };
    }
    return {
      width: v.videoWidth,
      height: v.videoHeight,
      duration: dur,
      sharp: avg(samples.map((s) => s.sharp)),
      bright: avg(samples.map((s) => s.bright)),
      dark: avg(samples.map((s) => s.dark)),
      blown: avg(samples.map((s) => s.blown)),
      hash: mid.m.hash,
      colors: mid.m.colors,
      faces: null,
      thumb: await toBlob(mid.canvas),
    };
  } finally {
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
}

function drawScaled(src, w, h) {
  const k = Math.min(1, SIZE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function measure(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  const colors = new Array(48).fill(0);
  const colorN = new Array(16).fill(0);
  let sum = 0;
  let dark = 0;
  let blown = 0;
  for (let y = 0, p = 0; y < h; y++) {
    const cy = Math.min(3, (y * 4 / h) | 0);
    for (let x = 0; x < w; x++, p++) {
      const r = d[p * 4], gg = d[p * 4 + 1], b = d[p * 4 + 2];
      const v = 0.299 * r + 0.587 * gg + 0.114 * b;
      g[p] = v;
      sum += v;
      if (v < 12) dark++;
      if (v > 248) blown++;
      const c = cy * 4 + Math.min(3, (x * 4 / w) | 0);
      colors[c * 3] += r;
      colors[c * 3 + 1] += gg;
      colors[c * 3 + 2] += b;
      colorN[c]++;
    }
  }
  for (let c = 0; c < 16; c++) for (let k = 0; k < 3; k++) colors[c * 3 + k] = Math.round(colors[c * 3 + k] / Math.max(1, colorN[c]));

  // ラプラシアン分散をタイル(4x4)ごとに
  const T = 4;
  const ts = new Float64Array(T * T), ts2 = new Float64Array(T * T), tn = new Float64Array(T * T);
  for (let y = 1; y < h - 1; y++) {
    const ty = Math.min(T - 1, (y * T / h) | 0);
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      const t = ty * T + Math.min(T - 1, (x * T / w) | 0);
      ts[t] += lap;
      ts2[t] += lap * lap;
      tn[t]++;
    }
  }
  const vars = [];
  for (let t = 0; t < T * T; t++) if (tn[t]) vars.push(ts2[t] / tn[t] - (ts[t] / tn[t]) ** 2);
  vars.sort((a, b) => b - a);
  const sharp = avg(vars.slice(0, 3));

  return { sharp, bright: sum / (w * h) / 255, dark: dark / (w * h), blown: blown / (w * h), hash: dHash(g, w, h), colors };
}

// 9x8 に平均化して左右の明暗差を 64bit に
function dHash(g, w, h) {
  const cells = new Float64Array(72), n = new Float64Array(72);
  for (let y = 0; y < h; y++) {
    const r = Math.min(7, (y * 8 / h) | 0);
    for (let x = 0; x < w; x++) {
      const c = r * 9 + Math.min(8, (x * 9 / w) | 0);
      cells[c] += g[y * w + x];
      n[c]++;
    }
  }
  let hi = 0, lo = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const a = cells[r * 9 + c] / n[r * 9 + c], b = cells[r * 9 + c + 1] / n[r * 9 + c + 1];
      const bit = a > b ? 1 : 0;
      const k = r * 8 + c;
      if (k < 32) hi = (hi | (bit << k)) >>> 0;
      else lo = (lo | (bit << (k - 32))) >>> 0;
    }
  }
  return [hi, lo];
}

function toBlob(canvas) {
  return new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.78));
}

function once(el, ev, timeout) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { cleanup(); rej(new Error(ev + ' timeout')); }, timeout);
    const ok = () => { cleanup(); res(); };
    const ng = () => { cleanup(); rej(new Error('media error')); };
    const cleanup = () => { clearTimeout(t); el.removeEventListener(ev, ok); el.removeEventListener('error', ng); };
    el.addEventListener(ev, ok);
    el.addEventListener('error', ng);
  });
}

function safe(fn) {
  try { return fn(); } catch (e) { console.warn(e); return null; }
}

function avg(a) {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}
