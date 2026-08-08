// ミスノート連携: 同じ shu291.github.io 上のミスノート (../miss-note/) の
// IndexedDB「missnote」を直接読み書きする。
// 問題の画像はコピーせず、「どの本・どのページ・どの範囲か」(ref) だけを登録する。
import { Pages, Images } from './db.js';
import { uid, subjectOf } from './util.js';

export const INTERVALS = [1, 3, 7, 16, 35]; // ミスノートと同じ復習間隔
export const CAUSES = ['計算ミス', '覚えてない', '読み違い', '手が止まった', '詰めが甘い', '時間切れ'];
const DAY = 86400000;
export const startOfDay = (t = Date.now()) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const today = () => startOfDay();
export const daysUntil = t => Math.round((startOfDay(t) - today()) / DAY);

let missDbPromise = null;
function openMissDb() {
  if (missDbPromise) return missDbPromise;
  missDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open('missnote', 1);
    req.onupgradeneeded = () => {
      // ミスノートをまだ一度も開いていない端末でも、同じ構造で作っておく
      const db = req.result;
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('prefs')) db.createObjectStore('prefs', { keyPath: 'k' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return missDbPromise;
}
const reqProm = req => new Promise((res, rej) => {
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});
async function mStore(name, mode = 'readonly') {
  const db = await openMissDb();
  return db.transaction(name, mode).objectStore(name);
}

export async function allMissNotes() { return reqProm((await mStore('notes')).getAll()); }
export async function getMissNote(id) { return reqProm((await mStore('notes')).get(id)); }
export async function putMissNote(n) { return reqProm((await mStore('notes', 'readwrite')).put(n)); }
export async function deleteMissNote(id) { return reqProm((await mStore('notes', 'readwrite')).delete(id)); }

// この教科書アプリ由来の登録だけ（写真から登録したものはミスノート側で見る）
export async function bookMissNotes(bookId = null) {
  const all = await allMissNotes();
  const refs = all.filter(n => n.ref?.app === 'digi-textbook');
  return bookId ? refs.filter(n => n.ref.bookId === bookId) : refs;
}

// 今日やる復習（期限が来ていて未定着のもの）
export async function dueMissNotes() {
  const refs = await bookMissNotes();
  const t = today();
  return refs
    .filter(n => !n.mastered && n.dueAt != null && startOfDay(n.dueAt) <= t)
    .sort((a, b) => a.dueAt - b.dueAt || a.createdAt - b.createdAt);
}

// 教科書の問題をミスノートに登録（rect は 0..1 正規化 [x, y, w, h]）
export async function addMissFromBook(book, pageUid, rect, cause) {
  const note = {
    id: uid(),
    createdAt: Date.now(),
    subject: subjectOf(book.subject).name,
    cause: cause || '未分類',
    unit: '',
    memo: '',
    qImg: null, aImg: null,
    step: 0,
    dueAt: today() + INTERVALS[0] * DAY,
    mastered: false,
    history: [],
    ref: { app: 'digi-textbook', bookId: book.id, bookTitle: book.title, pageUid, rect },
  };
  await putMissNote(note);
  return note;
}

// できた／まちがえた（ミスノートの answer() と同じ規則）
export async function judgeMiss(note, ok) {
  note.history = note.history || [];
  note.history.push({ at: Date.now(), ok });
  if (ok) {
    note.step += 1;
    if (note.step >= INTERVALS.length) { note.mastered = true; note.dueAt = null; }
    else note.dueAt = today() + INTERVALS[Math.min(note.step, INTERVALS.length - 1)] * DAY;
  } else {
    note.mastered = false;
    note.step = Math.max(0, note.step - 2);
    note.dueAt = today() + DAY;
  }
  await putMissNote(note);
  return note;
}

// ページ背番号 (uid) → 現在のページ番号。並べ替えされていても正しく引ける
export async function resolvePage(bookId, pageUid) {
  const pages = await Pages.byBook(bookId);
  const p = pages.find(x => x.uid === pageUid);
  return p ? p.pageNo : null;
}

// ページ画像から範囲を切り抜いて blob URL を返す（画像を複製しない表示用）
export async function cropRect(bookId, pageNo, rect, maxW = 520) {
  const imgRec = await Images.get(bookId, pageNo);
  if (!imgRec?.blob) return '';
  const img = new Image();
  const url = URL.createObjectURL(imgRec.blob);
  try { img.src = url; await img.decode(); } finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
  const [x, y, w, h] = rect;
  const sx = x * img.naturalWidth, sy = y * img.naturalHeight;
  const sw = Math.max(1, w * img.naturalWidth), sh = Math.max(1, h * img.naturalHeight);
  const scale = Math.min(1, maxW / sw);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * scale));
  c.height = Math.max(1, Math.round(sh * scale));
  c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
  return blob ? URL.createObjectURL(blob) : '';
}

const cropCache = new Map(); // noteId -> objectURL
export async function noteCropUrl(note, maxW = 520) {
  if (cropCache.has(note.id)) return cropCache.get(note.id);
  const pageNo = await resolvePage(note.ref.bookId, note.ref.pageUid);
  if (!pageNo) return '';
  const u = await cropRect(note.ref.bookId, pageNo, note.ref.rect, maxW);
  if (u) cropCache.set(note.id, u);
  return u;
}
export function clearCropCache() {
  for (const u of cropCache.values()) URL.revokeObjectURL(u);
  cropCache.clear();
}

// 回転時に登録範囲も一緒に回す（importer.rotateBook から呼ばれる）
export async function rotateMissRects(bookId, pageUid, turns) {
  if (!pageUid) return;
  const notes = (await bookMissNotes(bookId)).filter(n => n.ref.pageUid === pageUid);
  for (const n of notes) {
    const [x, y, w, h] = n.ref.rect;
    const pts = [[x, y], [x + w, y + h]].map(([px, py]) =>
      turns === 1 ? [1 - py, px] : turns === 2 ? [1 - px, 1 - py] : [py, 1 - px]);
    const nx = Math.min(pts[0][0], pts[1][0]);
    const ny = Math.min(pts[0][1], pts[1][1]);
    n.ref.rect = [nx, ny, Math.abs(pts[0][0] - pts[1][0]), Math.abs(pts[0][1] - pts[1][1])];
    await putMissNote(n);
  }
  cropCache.clear();
}

// 本を削除するときに、その本のミス登録も一緒に消す
export async function deleteMissOfBook(bookId) {
  const notes = await bookMissNotes(bookId);
  for (const n of notes) await deleteMissNote(n.id);
  return notes.length;
}
