// OCR（Tesseract.js）と全文検索
import { Pages, Images } from './db.js';
import { cleanText, foldText } from './util.js';

const TESS_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const LANG_PATH = 'https://tessdata.projectnaptha.com/4.0.0_fast'; // 軽量版の学習データ

let tessLoading = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (!tessLoading) {
    tessLoading = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = TESS_URL;
      s.onload = res;
      s.onerror = () => { tessLoading = null; rej(new Error('OCRエンジンの読み込みに失敗しました（初回はネット接続が必要です）')); };
      document.head.appendChild(s);
    });
  }
  return tessLoading;
}

// 実行中ジョブ（同時に1冊だけ）
export const ocrJob = {
  running: false, bookId: null, bookTitle: '',
  done: 0, total: 0, cancelRequested: false,
  onUpdate: null,
};
function notify() { ocrJob.onUpdate?.(ocrJob); }
export function cancelOcr() { if (ocrJob.running) ocrJob.cancelRequested = true; }

// force=true で認識済みページもやり直す
export async function startOcr(book, { force = false } = {}) {
  if (ocrJob.running) throw new Error('別の文字認識が実行中です。終わってから実行してください。');
  await loadTesseract();
  const pages = (await Pages.byBook(book.id)).filter(p => force || !p.text);
  Object.assign(ocrJob, {
    running: true, bookId: book.id, bookTitle: book.title,
    done: 0, total: pages.length, cancelRequested: false,
  });
  notify();
  if (!pages.length) { ocrJob.running = false; notify(); return { done: 0, total: 0 }; }

  const worker = await Tesseract.createWorker(['jpn', 'eng'], 1, { langPath: LANG_PATH, gzip: true });
  let ok = 0;
  try {
    for (const p of pages) {
      if (ocrJob.cancelRequested) break;
      const img = await Images.get(book.id, p.pageNo);
      if (img?.blob) {
        const { data } = await worker.recognize(img.blob);
        p.text = cleanText(data.text);
        p.textSource = 'ocr';
        await Pages.put(p);
        ok++;
      }
      ocrJob.done++;
      notify();
    }
  } finally {
    await worker.terminate().catch(() => {});
    ocrJob.running = false;
    notify();
  }
  return { done: ok, total: pages.length, cancelled: ocrJob.cancelRequested };
}

export async function ocrStatus(bookId) {
  const pages = await Pages.byBook(bookId);
  return { withText: pages.filter(p => p.text).length, total: pages.length };
}

function makeSnippet(text, idx, len) {
  const s = Math.max(0, idx - 26);
  const e = Math.min(text.length, idx + len + 26);
  return {
    pre: (s > 0 ? '…' : '') + text.slice(s, idx),
    match: text.slice(idx, idx + len),
    post: text.slice(idx + len, e) + (e < text.length ? '…' : ''),
  };
}

// 1冊内を検索 → [{pageNo, count, snippets:[{pre,match,post}]}]
export async function searchBook(book, query, limitPerPage = 2) {
  const q = foldText(cleanText(query));
  if (!q) return [];
  const pages = await Pages.byBook(book.id);
  const hits = [];
  for (const p of pages) {
    if (!p.text) continue;
    const folded = foldText(p.text);
    const positions = [];
    let i = folded.indexOf(q);
    while (i !== -1) { positions.push(i); i = folded.indexOf(q, i + q.length); }
    if (positions.length) {
      hits.push({
        pageNo: p.pageNo,
        count: positions.length,
        snippets: positions.slice(0, limitPerPage).map(idx => makeSnippet(p.text, idx, q.length)),
      });
    }
  }
  return hits;
}

// 全部の本から検索 → [{book, hits}]
export async function searchAll(books, query) {
  const out = [];
  for (const b of books) {
    const hits = await searchBook(b, query);
    if (hits.length) out.push({ book: b, hits });
  }
  return out;
}
