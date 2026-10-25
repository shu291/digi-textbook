// クラウド同期: ミス記録のスナップショットを同期サーバーへ一方向に送る。
// 目的は「Claude が苦手分野を読めるようにする」こと。ページ画像・書き込みは送らない。
// 失敗してもアプリの操作は止めない（dirty のまま残して、次の機会に再送）。
import { Books, Pages, Prefs } from './db.js';
import { allMissNotes } from './misslink.js';

export const DEFAULT_URL = 'https://digi-textbook-sync.netlify.app/api/sync';
const DEBOUNCE_MS = 4000;

export const syncState = { status: 'off', last: null, error: '', pending: false };
let timer = null;
let running = false;
const listeners = new Set();
export const onSyncChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach(fn => { try { fn(syncState); } catch { /* 表示側の失敗は無視 */ } });

export const getKey = () => Prefs.get('syncKey', '');
export async function setKey(key) {
  await Prefs.set('syncKey', (key || '').trim());
  syncState.status = key ? 'idle' : 'off';
  syncState.error = '';
  emit();
}
const getUrl = () => Prefs.get('syncUrl', DEFAULT_URL);

// 目次(toc)から「そのページが属する単元」を引く
function unitOf(toc, pageNo) {
  let hit = '';
  for (const t of toc || []) {
    if (t.page <= pageNo) hit = t.title || t.name || hit; else break;
  }
  return hit;
}

export async function buildSnapshot() {
  const books = await Books.all();
  const notes = await allMissNotes();
  const bookById = new Map(books.map(b => [b.id, b]));
  const pageNoCache = new Map(); // bookId -> Map(uid -> pageNo)
  async function pageNoOf(bookId, uid) {
    if (!pageNoCache.has(bookId)) {
      const m = new Map();
      for (const p of await Pages.byBook(bookId)) if (p.uid) m.set(p.uid, p.pageNo);
      pageNoCache.set(bookId, m);
    }
    return pageNoCache.get(bookId).get(uid) ?? null;
  }
  const out = [];
  for (const n of notes) {
    const rec = {
      id: n.id, createdAt: n.createdAt, subject: n.subject, cause: n.cause,
      unit: n.unit || '', step: n.step, mastered: !!n.mastered, dueAt: n.dueAt ?? null,
      history: (n.history || []).map(h => ({ at: h.at, ok: !!h.ok })),
      source: n.ref?.app === 'digi-textbook' ? 'book' : 'photo',
    };
    if (n.ref?.app === 'digi-textbook') {
      const book = bookById.get(n.ref.bookId);
      const pageNo = await pageNoOf(n.ref.bookId, n.ref.pageUid);
      rec.bookId = n.ref.bookId;
      rec.bookTitle = book?.title || n.ref.bookTitle || '';
      rec.pageNo = pageNo;
      if (!rec.unit && book && pageNo) rec.unit = unitOf(book.toc, pageNo);
    }
    out.push(rec);
  }
  return {
    app: 'digi-textbook', version: 1, at: new Date().toISOString(),
    books: books.map(b => ({
      id: b.id, title: b.title, subject: b.subject, pageCount: b.pageCount,
      toc: (b.toc || []).map(t => ({ title: t.title || t.name || '', page: t.page })),
    })),
    notes: out,
  };
}

export async function pushNow({ keepalive = false } = {}) {
  const key = await getKey();
  if (!key) { syncState.status = 'off'; emit(); return false; }
  if (running) { syncState.pending = true; return false; }
  running = true;
  syncState.status = 'sending'; syncState.error = ''; emit();
  try {
    const snap = await buildSnapshot();
    const res = await fetch(await getUrl(), {
      method: 'PUT',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(snap),
      keepalive: keepalive && JSON.stringify(snap).length < 60000,
    });
    if (!res.ok) throw new Error(res.status === 401 ? '合言葉が違います' : `サーバーエラー(${res.status})`);
    syncState.last = Date.now();
    syncState.status = 'ok';
    await Prefs.set('syncDirty', false);
    await Prefs.set('syncLast', syncState.last);
    return true;
  } catch (e) {
    syncState.status = 'error';
    syncState.error = e.message === 'Failed to fetch' ? 'オフラインのようです（あとで自動で再送します）' : e.message;
    await Prefs.set('syncDirty', true);
    return false;
  } finally {
    running = false;
    emit();
    if (syncState.pending) { syncState.pending = false; schedule(); }
  }
}

function schedule(delay = DEBOUNCE_MS) {
  clearTimeout(timer);
  timer = setTimeout(() => { pushNow(); }, delay);
}

// ?sync=合言葉 付きのURLを開くと、その場で設定される（iPadで長い文字を打たずに済む）
async function takeKeyFromHash() {
  const m = /[#&]sync=([A-Za-z0-9_-]{16,128})/.exec(location.hash);
  if (!m) return false;
  await setKey(m[1]);
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}

export async function initSync() {
  const fresh = await takeKeyFromHash();
  const key = await getKey();
  syncState.status = key ? 'idle' : 'off';
  syncState.last = await Prefs.get('syncLast', null);
  emit();

  // ミス記録が変わったら少し待ってから送る（連続操作をまとめる）
  window.addEventListener('miss-changed', async () => { await Prefs.set('syncDirty', true); schedule(); });
  // 画面を閉じる/隠すときに、未送信があれば急いで送る
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden' && await Prefs.get('syncDirty', false)) pushNow({ keepalive: true });
  });
  // 回線が戻ったら再送
  window.addEventListener('online', async () => { if (await Prefs.get('syncDirty', false)) schedule(500); });
  // 起動時に1回送る（本の追加・削除・目次変更や、ミスノート側の変更も拾うため）
  if (key) schedule(fresh ? 500 : 2500);
  return { fresh };
}
