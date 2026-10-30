// 整理の途中経過を端末内(IndexedDB)に保存する。
// iPhone は写真アプリと行き来するとタブが再読み込みされることがあるため。

const DB = 'bestshot';
const ST = 'kv';
let dbp = null;

function db() {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(ST);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

async function run(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(ST, mode);
    const req = fn(tx.objectStore(ST));
    tx.oncomplete = () => res(req?.result);
    tx.onerror = () => rej(tx.error);
  });
}

export const get = (key) => run('readonly', (s) => s.get(key)).catch(() => null);
export const put = (key, val) => run('readwrite', (s) => s.put(val, key)).catch((e) => console.warn(e));
export const clear = () => run('readwrite', (s) => s.clear()).catch((e) => console.warn(e));
