// IndexedDB まわり（教科書・ページ・画像・書き込み・設定の保存）
const DB_NAME = 'digi-textbook';
const DB_VER = 1;
let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) {
        db.createObjectStore('books', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('pages')) {
        const s = db.createObjectStore('pages', { keyPath: ['bookId', 'pageNo'] });
        s.createIndex('byBook', 'bookId');
      }
      if (!db.objectStoreNames.contains('images')) {
        const s = db.createObjectStore('images', { keyPath: ['bookId', 'pageNo'] });
        s.createIndex('byBook', 'bookId');
      }
      if (!db.objectStoreNames.contains('strokes')) {
        const s = db.createObjectStore('strokes', { keyPath: ['bookId', 'pageNo'] });
        s.createIndex('byBook', 'bookId');
      }
      if (!db.objectStoreNames.contains('prefs')) {
        db.createObjectStore('prefs', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqProm(req) {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await openDb();
  return db.transaction(name, mode).objectStore(name);
}

export async function dbGet(name, key) { return reqProm((await store(name)).get(key)); }
export async function dbPut(name, val) { return reqProm((await store(name, 'readwrite')).put(val)); }
export async function dbDel(name, key) { return reqProm((await store(name, 'readwrite')).delete(key)); }
export async function dbAll(name) { return reqProm((await store(name)).getAll()); }
export async function dbAllByBook(name, bookId) {
  return reqProm((await store(name)).index('byBook').getAll(bookId));
}
export async function dbKeysByBook(name, bookId) {
  return reqProm((await store(name)).index('byBook').getAllKeys(bookId));
}

export async function dbDelByBook(name, bookId) {
  const s = await store(name, 'readwrite');
  return new Promise((res, rej) => {
    const cur = s.index('byBook').openKeyCursor(IDBKeyRange.only(bookId));
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) { s.delete(c.primaryKey); c.continue(); } else res();
    };
    cur.onerror = () => rej(cur.error);
  });
}

export const Books = {
  get: id => dbGet('books', id),
  all: () => dbAll('books'),
  put: b => dbPut('books', b),
  async remove(id) {
    await dbDelByBook('images', id);
    await dbDelByBook('pages', id);
    await dbDelByBook('strokes', id);
    await dbDel('books', id);
  },
};

export const Pages = {
  get: (bookId, pageNo) => dbGet('pages', [bookId, pageNo]),
  byBook: bookId => dbAllByBook('pages', bookId), // pageNo 昇順で返る
  put: p => dbPut('pages', p),
};

export const Images = {
  get: (bookId, pageNo) => dbGet('images', [bookId, pageNo]),
  put: r => dbPut('images', r),
};

export const Strokes = {
  get: (bookId, pageNo) => dbGet('strokes', [bookId, pageNo]),
  byBook: bookId => dbAllByBook('strokes', bookId),
  put: r => dbPut('strokes', r),
  del: (bookId, pageNo) => dbDel('strokes', [bookId, pageNo]),
};

export const Prefs = {
  async get(key, fallback = null) {
    const r = await dbGet('prefs', key);
    return r ? r.value : fallback;
  },
  set: (key, value) => dbPut('prefs', { key, value }),
};
