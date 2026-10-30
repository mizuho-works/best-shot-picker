import { captureTime, isVideo } from './meta.js';
import { analyzePhoto, analyzeVideo } from './analyze.js';
import { buildGroups, BLUR_ABS } from './group.js';
import { loadFaceModel, detectFaces } from './face.js';
import * as store from './store.js';

const $ = (s, el = document) => el.querySelector(s);

const DEFAULTS = { keep: 1, sensitivity: 'normal', faces: true, flagSingles: true };
const state = {
  settings: loadSettings(),
  items: [],
  groups: [],
  lists: {}, // 拡大表示で左右に送る範囲
  cancel: false,
  viewer: null,
};

// ---------- 画面切替 ----------

function show(name) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== 'screen-' + name;
  $('#btn-home').hidden = name === 'start' || name === 'progress';
  window.scrollTo(0, 0);
}

function toast(msg, ms = 3000) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

// ---------- 設定 ----------

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('bs-settings') || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  try { localStorage.setItem('bs-settings', JSON.stringify(state.settings)); } catch { /* プライベートモード等 */ }
}

function mountSettings(el, { withFaces, onChange }) {
  const s = state.settings;
  const seg = (key, opts) =>
    `<div class="seg" data-key="${key}">${opts
      .map(([v, l]) => `<button type="button" data-value="${v}" class="${String(s[key]) === String(v) ? 'on' : ''}">${l}</button>`)
      .join('')}</div>`;
  const sw = (key, label, note = '') =>
    `<label class="set-row switch"><span class="set-label">${label}${note ? `<small>${note}</small>` : ''}</span>
      <input type="checkbox" data-key="${key}" ${s[key] ? 'checked' : ''}><i></i></label>`;
  el.innerHTML = `
    <div class="set-row"><span class="set-label">1グループで残す数</span>${seg('keep', [[1, '1枚'], [2, '2枚'], [3, '3枚']])}</div>
    <div class="set-row"><span class="set-label">似ている判定<small>ゆるめ＝まとめる範囲が広い</small></span>${seg('sensitivity', [['strict', 'きびしめ'], ['normal', 'ふつう'], ['loose', 'ゆるめ']])}</div>
    ${withFaces ? sw('faces', '顔・目つぶり・笑顔もチェック', '初回だけ解析用データ(約4MB)を読み込みます') : ''}
    ${sw('flagSingles', '1枚だけのひどいブレ・真っ暗も候補に')}`;
  el.onclick = (e) => {
    const b = e.target.closest('.seg button');
    if (!b) return;
    const key = b.parentElement.dataset.key;
    state.settings[key] = key === 'keep' ? +b.dataset.value : b.dataset.value;
    saveSettings();
    mountSettings(el, { withFaces, onChange });
    onChange?.();
  };
  el.onchange = (e) => {
    const key = e.target.dataset.key;
    if (!key) return;
    state.settings[key] = e.target.checked;
    saveSettings();
    onChange?.();
  };
}

// ---------- 解析 ----------

async function runAnalysis(files) {
  state.cancel = false;
  state.items = [];
  await store.clear();
  show('progress');
  const wake = await navigator.wakeLock?.request('screen').catch(() => null);

  let faceOn = false;
  if (state.settings.faces && files.some((f) => !isVideo(f))) {
    $('#prog-text').textContent = '顔チェックの準備中…';
    $('#prog-sub').textContent = '初回は少し時間がかかります';
    try {
      await loadFaceModel();
      faceOn = true;
    } catch (e) {
      console.warn(e);
      toast('顔チェックを読み込めなかったので、ブレ・明るさだけで判定します', 5000);
    }
  }

  const started = performance.now();
  for (let i = 0; i < files.length && !state.cancel; i++) {
    const file = files[i];
    const kind = isVideo(file) ? 'video' : 'photo';
    const item = { id: i, name: file.name, size: file.size, kind, file, time: await captureTime(file) };
    try {
      Object.assign(item, kind === 'video' ? await analyzeVideo(file) : await analyzePhoto(file, faceOn ? detectFaces : null));
    } catch (e) {
      console.warn(file.name, e);
      item.failed = true;
    }
    if (item.thumb) {
      item.thumbUrl = URL.createObjectURL(item.thumb);
      store.put('thumb:' + i, item.thumb);
      $('#prog-thumb').src = item.thumbUrl;
    }
    state.items.push(item);

    const done = i + 1;
    const per = (performance.now() - started) / done;
    const left = Math.ceil(((files.length - done) * per) / 1000);
    $('#prog-text').textContent = `${done} / ${files.length} 件を解析中`;
    $('#prog-sub').textContent = left > 3 ? `残り約 ${left >= 60 ? Math.ceil(left / 60) + ' 分' : left + ' 秒'}` : 'もうすぐ終わります';
    $('#prog-bar').style.width = (done / files.length) * 100 + '%';
    await new Promise((r) => setTimeout(r, 0));
  }
  wake?.release().catch(() => {});

  if (!state.items.length) return show('start');
  regroup();
  renderReview();
  show('review');
  const failed = state.items.filter((i) => i.failed).length;
  if (failed) toast(`${failed} 件は読み込めなかったので「残す」にしています`, 5000);
}

function regroup() {
  state.groups = buildGroups(state.items, state.settings);
  saveSession();
}

// ---------- 保存と再開 ----------

let saveTimer = null;
function saveSession() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    store.put('session', {
      savedAt: Date.now(),
      items: state.items.map(({ file, thumb, thumbUrl, ...rest }) => rest),
      groups: state.groups.map((g) => ({ id: g.id, kind: g.kind, ids: g.items.map((i) => i.id) })),
    });
  }, 300);
}

async function checkResume() {
  const s = await store.get('session');
  if (!s?.items?.length) return;
  const el = $('#resume');
  const del = s.items.filter((i) => i.decision === 'delete');
  const left = del.filter((i) => !i.done).length;
  el.innerHTML = `
    <div><b>前回の整理の続きがあります</b><br>
    <span class="muted small">${fmtDate(s.savedAt)} ・ ${s.items.length} 件中 削除候補 ${del.length} 件（未完了 ${left} 件）</span></div>
    <div class="row"><button class="primary" id="btn-resume">続きから</button><button class="ghost" id="btn-discard">破棄</button></div>`;
  el.hidden = false;
  $('#btn-resume').onclick = async () => {
    const byId = new Map(s.items.map((i) => [i.id, i]));
    for (const it of s.items) {
      const blob = await store.get('thumb:' + it.id);
      if (blob) it.thumbUrl = URL.createObjectURL(blob);
    }
    state.items = s.items;
    state.groups = s.groups.map((g) => ({ ...g, items: g.ids.map((id) => byId.get(id)) }));
    el.hidden = true;
    renderReview();
    if (left < del.length) {
      renderFinish();
      show('finish');
    } else {
      show('review');
    }
  };
  $('#btn-discard').onclick = async () => {
    await store.clear();
    el.hidden = true;
  };
}

// ---------- 確認画面 ----------

function renderReview() {
  const multi = state.groups.filter((g) => g.items.length > 1);
  const singles = state.groups.filter((g) => g.items.length === 1).map((g) => g.items[0]);
  const flagged = singles.filter((i) => i.decision === 'delete' || i.reasons?.length);
  const fine = singles.filter((i) => !flagged.includes(i));
  state.lists = { flagged: flagged.map((i) => i.id), fine: fine.map((i) => i.id) };
  multi.forEach((g) => (state.lists['g' + g.id] = g.items.map((i) => i.id)));

  let html = multi.length
    ? `<h3 class="sec">似た写真・動画のグループ <small>${multi.length}</small></h3>` + multi.map(groupCard).join('')
    : '<p class="empty">似た写真のグループは見つかりませんでした。<br>「似ている判定」をゆるめにすると見つかるかもしれません。</p>';
  if (flagged.length)
    html += `<h3 class="sec">1枚だけど気になるもの <small>${flagged.length}</small></h3>
      <div class="group"><div class="grid" data-list="flagged">${flagged.map(cell).join('')}</div></div>`;
  if (fine.length)
    html += `<details class="sec-details"><summary>1枚だけ・問題なし <small>${fine.length}</small></summary>
      <div class="group"><div class="grid" data-list="fine">${fine.map(cell).join('')}</div></div></details>`;
  $('#group-list').innerHTML = html;
  updateSummary();
}

function groupHead(g) {
  const n = g.items.filter((i) => i.decision === 'delete').length;
  const allKeep = n === 0;
  const changed = g.items.some((i) => i.decision !== i.auto);
  const label = g.kind === 'video' ? `🎬 似た動画 ${g.items.length}本` : `📷 似た写真 ${g.items.length}枚`;
  return `<div><b>${label}</b><span class="g-time">${fmtTime(g.items[0].time)}</span></div>
    <div class="g-actions">${n ? `<span class="g-del">${n}件削除</span>` : ''}
      ${allKeep && changed ? '<button class="link" data-act="reset">提案に戻す</button>' : ''}
      ${!allKeep ? '<button class="link" data-act="keepall">全部残す</button>' : ''}</div>`;
}

function groupCard(g) {
  return `<div class="group" data-gid="${g.id}">
    <div class="g-head">${groupHead(g)}</div>
    <div class="grid" data-list="g${g.id}">${g.items.map(cell).join('')}</div></div>`;
}

function cell(it) {
  const del = it.decision === 'delete';
  let badge = '';
  if (it.best && state.groups[it.groupId]?.items.length > 1) badge = '<span class="badge best">★ベスト</span>';
  else if (it.reasons?.length) badge = `<span class="badge ${del ? 'reason' : ''}">${it.reasons[0]}</span>`;
  return `<div class="cell ${del ? 'del' : 'keep'}" data-id="${it.id}">
    ${it.thumbUrl ? `<img src="${it.thumbUrl}" loading="lazy" alt="">` : '<div class="noimg">?</div>'}
    ${badge}
    ${it.kind === 'video' ? `<span class="dur">▶ ${fmtDur(it.duration)}</span>` : ''}
    <button class="toggle" aria-label="${del ? '残すに変更' : '削除候補に変更'}"><span>${del ? '✕' : '✓'}</span></button>
  </div>`;
}

function setDecision(it, decision) {
  it.decision = decision;
  it.done = false;
  for (const el of document.querySelectorAll(`.cell[data-id="${it.id}"]`)) el.outerHTML = cell(it);
  const head = $(`.group[data-gid="${it.groupId}"] .g-head`);
  if (head) head.innerHTML = groupHead(state.groups[it.groupId]);
  updateSummary();
  saveSession();
}

function updateSummary() {
  const del = state.items.filter((i) => i.decision === 'delete');
  $('#sum-del').textContent = del.length;
  const bytes = del.reduce((s, i) => s + (i.size || 0), 0);
  $('#sum-size').textContent = `（約 ${fmtBytes(bytes)}）`;
  $('#btn-finish').textContent = del.length ? `${del.length} 件の削除手順へ進む →` : '削除候補はありません';
  $('#btn-finish').disabled = !del.length;
}

$('#group-list').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]');
  if (act) {
    const g = state.groups[+act.closest('.group').dataset.gid];
    for (const it of g.items) setDecision(it, act.dataset.act === 'keepall' ? 'keep' : it.auto);
    return;
  }
  const c = e.target.closest('.cell');
  if (!c) return;
  const it = state.items[+c.dataset.id];
  if (e.target.closest('.toggle')) return setDecision(it, it.decision === 'delete' ? 'keep' : 'delete');
  const ids = state.lists[c.closest('[data-list]').dataset.list];
  openViewer(ids, ids.indexOf(it.id));
});

// ---------- 拡大表示 ----------

let viewUrl = null;

function openViewer(ids, index) {
  state.viewer = { ids, index };
  $('#viewer').hidden = false;
  document.body.style.overflow = 'hidden';
  renderViewer();
}

function closeViewer() {
  $('#viewer').hidden = true;
  document.body.style.overflow = '';
  $('#v-video').pause();
  $('#v-video').removeAttribute('src');
  if (viewUrl) URL.revokeObjectURL(viewUrl);
  viewUrl = null;
  state.viewer = null;
}

function renderViewer() {
  const { ids, index } = state.viewer;
  const it = state.items[ids[index]];
  const img = $('#v-img');
  const video = $('#v-video');
  if (viewUrl) URL.revokeObjectURL(viewUrl);
  viewUrl = it.file ? URL.createObjectURL(it.file) : null;
  video.pause();
  if (it.kind === 'video' && viewUrl) {
    img.hidden = true;
    video.hidden = false;
    video.poster = it.thumbUrl || '';
    video.src = viewUrl;
  } else {
    video.hidden = true;
    video.removeAttribute('src');
    img.hidden = false;
    img.onerror = () => { img.onerror = null; img.src = it.thumbUrl || ''; }; // HEIC 非対応ブラウザ等
    img.src = (it.kind === 'photo' && viewUrl) || it.thumbUrl || '';
  }
  $('#v-pos').textContent = `${index + 1} / ${ids.length}`;
  $('#v-time').textContent = it.time ? fmtTime(it.time, true) : '';
  $('#v-info').innerHTML = infoChips(it);
  const del = it.decision === 'delete';
  const t = $('#v-toggle');
  t.className = 'toggle-big ' + (del ? 'del' : 'keep');
  t.textContent = del ? '✕ 削除候補（タップで残す）' : '✓ 残す（タップで削除候補）';
  $('#v-prev').style.visibility = index > 0 ? 'visible' : 'hidden';
  $('#v-next').style.visibility = index < ids.length - 1 ? 'visible' : 'hidden';
}

function infoChips(it) {
  const c = [];
  if (it.best && state.groups[it.groupId]?.items.length > 1) c.push('<span class="good">★ このグループのベスト</span>');
  for (const r of it.reasons || []) c.push(`<span class="bad">${r}</span>`);
  if (!it.failed) {
    if (it.rel != null) c.push(`<span>くっきり度 ${Math.round(it.rel * 100)}%（グループ内比）</span>`);
    else c.push(`<span>くっきり度 ${it.sharp < BLUR_ABS ? '低い' : it.sharp < BLUR_ABS * 4 ? 'ふつう' : '高い'}</span>`);
    if (it.faces?.length) {
      const closed = it.faces.filter((f) => f.closed).length;
      const smile = Math.max(...it.faces.map((f) => f.smile));
      c.push(`<span>顔 ${it.faces.length}</span>`);
      if (closed) c.push(`<span class="bad">目つぶり ${closed}</span>`);
      if (smile > 0.5) c.push('<span class="good">笑顔 😊</span>');
    }
    if (it.kind === 'video') c.push(`<span>${fmtDur(it.duration)}</span>`);
  }
  if (it.size) c.push(`<span>${fmtBytes(it.size)}</span>`);
  return c.join('');
}

function step(d) {
  const v = state.viewer;
  if (!v) return;
  const n = v.index + d;
  if (n < 0 || n >= v.ids.length) return;
  v.index = n;
  renderViewer();
}

$('#v-close').onclick = closeViewer;
$('#v-prev').onclick = () => step(-1);
$('#v-next').onclick = () => step(1);
$('#v-toggle').onclick = () => {
  const it = state.items[state.viewer.ids[state.viewer.index]];
  setDecision(it, it.decision === 'delete' ? 'keep' : 'delete');
  renderViewer();
};
{
  let x0 = null, y0 = null;
  const stage = $('#v-stage');
  stage.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
    else if (dy > 100 && Math.abs(dy) > Math.abs(dx)) closeViewer();
  });
}
document.addEventListener('keydown', (e) => {
  if (!state.viewer) return;
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === 'ArrowRight') step(1);
  if (e.key === 'Escape') closeViewer();
});

// ---------- 削除の手順 ----------

function renderFinish() {
  const targets = state.groups.filter((g) => g.items.some((i) => i.decision === 'delete'));
  $('#finish-list').innerHTML = targets
    .map((g) => {
      const del = g.items.filter((i) => i.decision === 'delete');
      const done = del.every((i) => i.done);
      const t0 = g.items[0].time, t1 = g.items[g.items.length - 1].time;
      const range = t0 ? fmtTime(t0, true) + (t1 && t1 - t0 >= 1000 ? ' 〜 ' + fmtClock(t1) : '') : `${g.items[0].id + 1}件目あたり`;
      const strip = g.items
        .map((i) => `<div class="mini ${i.decision === 'delete' ? 'del' : 'keep'}">
          ${i.thumbUrl ? `<img src="${i.thumbUrl}" loading="lazy" alt="">` : ''}
          ${i.decision === 'delete' && i.time ? `<span class="t">${fmtClock(i.time)}</span>` : ''}</div>`)
        .join('');
      return `<div class="fgroup ${done ? 'done' : ''}" data-gid="${g.id}">
        <div class="f-head"><span class="f-time">${range}</span><span class="g-del">${del.length}件削除</span></div>
        <div class="strip">${strip}</div>
        <button class="done-btn">${done ? '✓ 削除した（タップで戻す）' : '写真アプリで削除したらタップ'}</button></div>`;
    })
    .join('');
  updateFinishProgress();
}

function updateFinishProgress() {
  const del = state.items.filter((i) => i.decision === 'delete');
  const done = del.filter((i) => i.done).length;
  $('#fin-bar').style.width = (del.length ? (done / del.length) * 100 : 0) + '%';
  $('#fin-text').textContent =
    done === del.length ? '🎉 全部終わりました！「最近削除した項目」から完全に削除すると容量が空きます。' : `${done} / ${del.length} 件 削除済み`;
}

$('#finish-list').addEventListener('click', (e) => {
  const b = e.target.closest('.done-btn');
  if (!b) return;
  const box = b.closest('.fgroup');
  const g = state.groups[+box.dataset.gid];
  const del = g.items.filter((i) => i.decision === 'delete');
  const done = !del.every((i) => i.done);
  del.forEach((i) => (i.done = done));
  box.classList.toggle('done', done);
  b.textContent = done ? '✓ 削除した（タップで戻す）' : '写真アプリで削除したらタップ';
  updateFinishProgress();
  saveSession();
});

// ---------- 書式 ----------

function fmtTime(ms, withSec = false) {
  if (ms == null) return '';
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${withSec ? fmtClock(ms) : `${d.getHours()}:${pad(d.getMinutes())}`}`;
}
function fmtClock(ms) {
  const d = new Date(ms);
  return `${d.getHours()}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtDate(ms) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${pad(d.getMinutes())}`;
}
function fmtDur(s) {
  if (!isFinite(s)) return '';
  s = Math.round(s);
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}
function fmtBytes(b) {
  return b >= 1e9 ? (b / 1e9).toFixed(1) + 'GB' : b >= 1e6 ? Math.round(b / 1e6) + 'MB' : Math.round(b / 1e3) + 'KB';
}
function pad(n) {
  return String(n).padStart(2, '0');
}

// ---------- 起動 ----------

mountSettings($('#settings-start'), { withFaces: true });
mountSettings($('#settings-review'), {
  withFaces: false,
  onChange: () => {
    regroup();
    renderReview();
  },
});

$('#file-input').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) runAnalysis(files);
});
$('#btn-cancel').onclick = () => (state.cancel = true);
$('#btn-finish').onclick = () => {
  renderFinish();
  show('finish');
};
$('#btn-back-review').onclick = () => {
  renderReview();
  show('review');
};
$('#btn-new').onclick = async () => {
  if (!confirm('今の整理結果を消して、新しく写真を選びますか？')) return;
  await store.clear();
  state.items = [];
  state.groups = [];
  show('start');
};
$('#btn-home').onclick = () => {
  show('start');
  checkResume();
};

checkResume();
