// 撮影日時の取得（写真: EXIF / 動画: QuickTime の mvhd）
// 連写は同じ秒に何枚も撮るので、EXIF の SubSecTimeOriginal（1/1000秒）まで読む。

export function isVideo(file) {
  return file.type.startsWith('video/') || /\.(mov|mp4|m4v|hevc)$/i.test(file.name);
}

export async function captureTime(file) {
  try {
    return isVideo(file) ? await videoTime(file) : await imageTime(file);
  } catch {
    return null;
  }
}

async function imageTime(file) {
  const buf = new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer());
  // JPEG の APP1 でも HEIC の Exif アイテムでも "Exif\0\0" の直後が TIFF ヘッダ
  const i = findBytes(buf, [0x45, 0x78, 0x69, 0x66, 0, 0]);
  if (i >= 0) {
    try {
      const t = parseTiff(new DataView(buf.buffer, i + 6, buf.length - i - 6));
      if (t) return t;
    } catch { /* 壊れた EXIF は下のフォールバックへ */ }
  }
  const m = new TextDecoder('latin1').decode(buf).match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  return m ? toMs(m) : null;
}

function parseTiff(dv) {
  const le = dv.getUint16(0) === 0x4949;
  const u16 = (o) => dv.getUint16(o, le);
  const u32 = (o) => dv.getUint32(o, le);
  if (u16(2) !== 42) return null;
  const readIfd = (off) => {
    const tags = {};
    const n = u16(off);
    for (let k = 0; k < n; k++) {
      const e = off + 2 + k * 12;
      tags[u16(e)] = { count: u32(e + 4), valOff: e + 8 };
    }
    return tags;
  };
  const str = (t) => {
    const off = t.count > 4 ? u32(t.valOff) : t.valOff;
    let s = '';
    for (let i = 0; i < t.count; i++) {
      const c = dv.getUint8(off + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  };
  const ifd0 = readIfd(u32(4));
  let date = null;
  let sub = null;
  if (ifd0[0x8769]) {
    const ex = readIfd(u32(ifd0[0x8769].valOff));
    if (ex[0x9003]) date = str(ex[0x9003]); // DateTimeOriginal
    if (ex[0x9291]) sub = str(ex[0x9291]); // SubSecTimeOriginal
  }
  if (!date && ifd0[0x0132]) date = str(ifd0[0x0132]); // DateTime
  const m = date && date.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  let ms = toMs(m);
  if (sub && /^\d+$/.test(sub.trim())) ms += Math.round(parseFloat('0.' + sub.trim()) * 1000);
  return ms;
}

async function videoTime(file) {
  let pos = 0;
  while (pos + 8 <= file.size) {
    const h = new DataView(await file.slice(pos, pos + 16).arrayBuffer());
    let size = h.getUint32(0);
    const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
    let hdr = 8;
    if (size === 1) {
      size = Number(h.getBigUint64(8));
      hdr = 16;
    } else if (size === 0) {
      size = file.size - pos;
    }
    if (size < hdr) break;
    if (type === 'moov') {
      const moov = new Uint8Array(await file.slice(pos + hdr, pos + Math.min(size, 8 * 1024 * 1024)).arrayBuffer());
      const i = findBytes(moov, [0x6d, 0x76, 0x68, 0x64]); // "mvhd"
      if (i < 0) return null;
      const dv = new DataView(moov.buffer, i + 4);
      const secs = dv.getUint8(0) === 1 ? Number(dv.getBigUint64(4)) : dv.getUint32(4);
      return secs ? (secs - 2082844800) * 1000 : null; // 1904年起点 → UNIX 時刻
    }
    pos += size;
  }
  return null;
}

function toMs(m) {
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

function findBytes(buf, pat) {
  outer: for (let i = 0; i <= buf.length - pat.length; i++) {
    for (let j = 0; j < pat.length; j++) if (buf[i + j] !== pat[j]) continue outer;
    return i;
  }
  return -1;
}
