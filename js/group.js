// 似た写真をグループにまとめ、グループ内で点数を付けて「残す / 削除候補」を決める

const SENS = {
  strict: { hash: 10, color: 16, window: 60e3 },
  normal: { hash: 16, color: 26, window: 180e3 },
  loose: { hash: 22, color: 38, window: 600e3 },
};
const BURST_MS = 1500; // これ以内の間隔は連写とみなし、多少動いても同じグループに
export const BLUR_ABS = 25; // 単独写真で「ひどいブレ」とみなすシャープさ

export function buildGroups(items, opt) {
  const th = SENS[opt.sensitivity] || SENS.normal;
  const groups = [];
  for (const kind of ['photo', 'video']) {
    let cur = null;
    for (const it of orderByTime(items.filter((i) => i.kind === kind))) {
      // 直近の数枚のどれかと似ていれば同じグループ（途中に1枚だけ失敗写真があっても切れない）
      const recent = cur ? cur.items.slice(-5).filter((x) => !x.failed) : [];
      if (!it.failed && recent.some((x) => similar(x, it, th))) cur.items.push(it);
      else groups.push((cur = { kind, items: [it] }));
    }
  }
  groups.sort((a, b) => a.items[0]._t - b.items[0]._t || a.items[0].id - b.items[0].id);
  groups.forEach((g, i) => {
    g.id = i;
    g.items.forEach((it) => (it.groupId = i));
    judge(g, opt);
  });
  return groups;
}

// 撮影日時が無いものは直前（選択順）の日時を引き継いで並べる
function orderByTime(list) {
  list.sort((a, b) => a.id - b.id);
  let last = -Infinity;
  for (const it of list) {
    it._t = it.time ?? last;
    if (it.time != null) last = it.time;
  }
  return list.sort((a, b) => a._t - b._t || a.id - b.id);
}

function similar(a, b, th) {
  if ((a.width >= a.height) !== (b.width >= b.height)) return false;
  const h = hamming(a.hash, b.hash);
  const c = colorDist(a.colors, b.colors);
  const dt = a.time != null && b.time != null ? Math.abs(b.time - a.time) : null;
  if (dt != null && dt <= BURST_MS) return h <= th.hash + 12 || c <= th.color + 16;
  if (dt != null && dt > th.window) return false;
  return h / th.hash + c / th.color <= 2 && h <= th.hash * 1.4 && c <= th.color * 1.4;
}

function judge(g, opt) {
  for (const it of g.items) {
    it.reasons = [];
    it.best = false;
    it.rel = null;
    it.done ??= false;
  }
  const ok = g.items.filter((i) => !i.failed);
  for (const it of g.items.filter((i) => i.failed)) {
    it.decision = it.auto = 'keep';
    it.reasons = ['解析できず'];
  }
  if (!ok.length) return;
  if (ok.length === 1) return single(ok[0], opt);

  const maxSharp = Math.max(...ok.map((i) => i.sharp), 1e-6);
  const maxFaces = Math.max(0, ...ok.map((i) => i.faces?.length || 0));
  const maxDur = Math.min(60, Math.max(...ok.map((i) => i.duration || 0), 1e-6));
  for (const it of ok) {
    it.rel = it.sharp / maxSharp;
    let s = 50 * it.rel + exposureScore(it);
    if (g.kind === 'video') s += (25 * Math.min(it.duration || 0, 60)) / maxDur;
    if (maxFaces > 0) {
      const f = it.faces || [];
      s += (15 * f.length) / maxFaces;
      s -= (25 * f.filter((x) => x.closed).length) / maxFaces;
      if (f.length) s += 10 * avg(f.map((x) => x.smile));
    }
    it.score = s;
  }
  const ranked = [...ok].sort((a, b) => b.score - a.score);
  const keepN = Math.min(opt.keep, ranked.length);
  ranked.forEach((it, i) => (it.decision = it.auto = i < keepN ? 'keep' : 'delete'));
  ranked[0].best = true;
  for (const it of ranked.slice(keepN)) it.reasons = whyWorse(it, ranked[0], g.kind);
}

function single(it, opt) {
  const r = [];
  if (it.kind === 'photo' && it.sharp < BLUR_ABS) r.push('ひどいブレ');
  if (it.bright < 0.06) r.push('真っ暗');
  if (it.kind === 'video' && it.duration < 1.2) r.push('誤操作っぽい短い動画');
  it.reasons = r;
  it.decision = it.auto = r.length && opt.flagSingles ? 'delete' : 'keep';
}

function whyWorse(it, best, kind) {
  const r = [];
  const closed = (x) => (x.faces || []).filter((f) => f.closed).length;
  // 暗い・白飛びの写真はくっきり度も低く出るので、先に明るさを見る
  const exposure = it.bright < 0.15 ? '暗い' : it.bright > 0.85 || it.blown > 0.25 ? '白飛び' : null;
  if (exposure) r.push(exposure);
  else if (it.rel < 0.55) r.push(kind === 'video' ? 'ブレが多い' : 'ブレ・ピンぼけ');
  if (closed(it) > closed(best)) r.push('目つぶり');
  if ((it.faces?.length || 0) < (best.faces?.length || 0)) r.push('顔が見えない');
  if (kind === 'video' && (it.duration || 0) < (best.duration || 0) * 0.5) r.push('短い');
  if (!r.length) r.push(kind === 'video' ? '似た動画あり' : 'ほぼ同じ写真');
  return r;
}

function exposureScore(it) {
  let e = 0;
  if (it.bright < 0.2) e -= (0.2 - it.bright) * 80;
  if (it.bright > 0.8) e -= (it.bright - 0.8) * 80;
  if (it.blown > 0.08) e -= (it.blown - 0.08) * 60;
  return e;
}

function hamming(a, b) {
  return popcount(a[0] ^ b[0]) + popcount(a[1] ^ b[1]);
}

function popcount(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function colorDist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

function avg(a) {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}
