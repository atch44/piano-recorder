// Video blobs are too big for localStorage, so they live in IndexedDB keyed by take id.
const DB = 'piano-recorder';
const STORE = 'videos';

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req.result); };
    t.onerror = t.onabort = () => { db.close(); reject(t.error); };
  });
}

export const putVideo = (id, blob) => run('readwrite', (s) => s.put(blob, id));
export const getVideo = (id) => run('readonly', (s) => s.get(id));
export const delVideo = (id) => run('readwrite', (s) => s.delete(id));
