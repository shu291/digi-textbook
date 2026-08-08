// PDF 取り込み: pdf.js で各ページを画像化して IndexedDB に保存する
import { Books, Pages, Images, Strokes, dbDelByBook, dbDel, dbGet, dbPut } from './db.js';
import { uid, cleanText } from './util.js';
import { rotateMissRects } from './misslink.js';

const PDFJS_VER = '4.6.82';
const PDFJS_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VER}/build/pdf.min.mjs`;
const PDFJS_WORKER = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VER}/build/pdf.worker.min.mjs`;

const PAGE_LONG = 2000;  // 保存画像の長辺(px)。拡大しても読める解像度
const THUMB_W = 260;     // ページ一覧用サムネの幅
const COVER_W = 520;     // 本棚の表紙用

let pdfjsPromise = null;
export function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS_URL).then(lib => {
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return lib;
    });
  }
  return pdfjsPromise;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((res, rej) =>
    canvas.toBlob(b => (b ? res(b) : rej(new Error('画像の変換に失敗しました'))), type, quality));
}

async function makeScaled(src, w, quality) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = Math.max(1, Math.round(src.height * (w / src.width)));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return canvasToBlob(c, 'image/jpeg', quality);
}

// src(画像/canvas)を回転した新しいcanvasを返す（turns: 1=右90° / 2=180° / 3=左90°）
function rotateOnto(src, sw, sh, turns) {
  const c = document.createElement('canvas');
  if (turns === 2) { c.width = sw; c.height = sh; }
  else { c.width = sh; c.height = sw; }
  const ctx = c.getContext('2d');
  if (turns === 1) { ctx.translate(c.width, 0); ctx.rotate(Math.PI / 2); }
  else if (turns === 2) { ctx.translate(c.width, c.height); ctx.rotate(Math.PI); }
  else { ctx.translate(0, c.height); ctx.rotate(-Math.PI / 2); }
  ctx.drawImage(src, 0, 0);
  return c;
}

// PDFの1ページ目を小さな画像にする（追加時の向きプレビュー用）
export async function makePdfPreview(file, maxLong = 360) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  try {
    const page = await doc.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = maxLong / Math.max(vp1.width, vp1.height);
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const blob = await canvasToBlob(c, 'image/jpeg', 0.8);
    return { url: URL.createObjectURL(blob), pages: doc.numPages };
  } finally {
    doc.destroy();
  }
}

// file: PDF File / meta: {title, subject}
// onProgress(done, total) / isCancelled() => true で中断
export async function importPdf(file, meta, { onProgress, isCancelled } = {}) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const total = doc.numPages;
  const bookId = uid();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  let cover = null;
  let textPages = 0;

  try {
    for (let i = 1; i <= total; i++) {
      if (isCancelled?.()) {
        await removeBookData(bookId);
        doc.destroy();
        return null;
      }
      const page = await doc.getPage(i);
      const vp1 = page.getViewport({ scale: 1 });
      const scale = PAGE_LONG / Math.max(vp1.width, vp1.height);
      const vp = page.getViewport({ scale });
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;

      const blob = await canvasToBlob(canvas, 'image/jpeg', 0.85);
      const thumb = await makeScaled(canvas, THUMB_W, 0.8);
      if (i === 1) cover = await makeScaled(canvas, COVER_W, 0.82);

      // 元からテキストが埋め込まれた PDF ならそれを取り出す（OCR 不要になる）
      let text = '';
      try {
        const tc = await page.getTextContent();
        text = cleanText(tc.items.map(it => it.str).join(' '));
      } catch { /* テキスト層なし */ }
      const hasText = text.length >= 20;
      if (hasText) textPages++;

      await Images.put({ bookId, pageNo: i, blob });
      await Pages.put({
        bookId, pageNo: i,
        w: canvas.width, h: canvas.height,
        thumb, text: hasText ? text : '', textSource: hasText ? 'pdf' : '',
      });
      page.cleanup();
      onProgress?.(i, total);
    }
  } catch (e) {
    await removeBookData(bookId);
    doc.destroy();
    throw e;
  }
  doc.destroy();

  const book = {
    id: bookId,
    title: meta.title,
    subject: meta.subject,
    pageCount: total,
    cover,
    createdAt: Date.now(),
    lastOpenedAt: Date.now(),
    lastPage: 1,
    toc: [],
    bookmarks: [],
    hasTextLayer: textPages > total * 0.5,
  };
  await Books.put(book);
  return book;
}

async function removeBookData(bookId) {
  try {
    await dbDelByBook('images', bookId);
    await dbDelByBook('pages', bookId);
  } catch { /* 掃除失敗は無視 */ }
}

// ============================================================
// 既存の本の後ろに、別のPDFのページを追加する（分割スキャンの続きをつなげる用）
// quarterTurns を指定すると、追加するページを回転しながら取り込む（既存の向きに合わせる用）
// 成功: {added, textPages, pageCount} / 中止: null / 失敗: 追加分を掃除してから throw
export async function appendPdf(book, file, { onProgress, isCancelled, quarterTurns = 0 } = {}) {
  const turns = ((quarterTurns % 4) + 4) % 4;
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const total = doc.numPages;
  const base = book.pageCount;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  let textPages = 0;
  let done = 0;

  try {
    for (let i = 1; i <= total; i++) {
      if (isCancelled?.()) {
        await removeAppended(book.id, base, done);
        doc.destroy();
        return null;
      }
      const page = await doc.getPage(i);
      const vp1 = page.getViewport({ scale: 1 });
      const scale = PAGE_LONG / Math.max(vp1.width, vp1.height);
      const vp = page.getViewport({ scale });
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const src = turns ? rotateOnto(canvas, canvas.width, canvas.height, turns) : canvas;

      const blob = await canvasToBlob(src, 'image/jpeg', 0.85);
      const thumb = await makeScaled(src, THUMB_W, 0.8);
      let text = '';
      try {
        const tc = await page.getTextContent();
        text = cleanText(tc.items.map(it => it.str).join(' '));
      } catch { /* テキスト層なし */ }
      const hasText = text.length >= 20;
      if (hasText) textPages++;

      const pageNo = base + i;
      await Images.put({ bookId: book.id, pageNo, blob });
      await Pages.put({
        bookId: book.id, pageNo,
        w: src.width, h: src.height,
        thumb, text: hasText ? text : '', textSource: hasText ? 'pdf' : '',
      });
      page.cleanup();
      done = i;
      onProgress?.(i, total);
    }
  } catch (e) {
    await removeAppended(book.id, base, done);
    doc.destroy();
    throw e;
  }
  doc.destroy();

  book.pageCount = base + total;
  book.hasTextLayer = !!book.hasTextLayer && textPages > total * 0.5;
  await Books.put(book);
  return { added: total, textPages, pageCount: book.pageCount };
}

// 追加しかけたページを掃除（book.pageCount は未更新なので消すだけで整合が戻る）
async function removeAppended(bookId, base, done) {
  try {
    for (let p = base + 1; p <= base + done + 1; p++) {
      await dbDel('images', [bookId, p]);
      await dbDel('pages', [bookId, p]);
    }
  } catch { /* 掃除失敗は無視 */ }
}

// ============================================================
// ページの並べ替え（入れ替え/移動）。画像・メタ・書き込みのページ番号を付け替え、
// しおり・目次・「つづき」・表紙も追従させる。
// op: {type:'swap', a, b} または {type:'move', from, to}（to=移動後の位置）
export async function reorderPages(book, op, { onProgress } = {}) {
  const n = book.pageCount;
  const map = new Map(); // 旧ページ番号 -> 新ページ番号（変わるものだけ）
  if (op.type === 'swap') {
    if (op.a === op.b) return book;
    map.set(op.a, op.b);
    map.set(op.b, op.a);
  } else {
    const { from, to } = op;
    if (from === to) return book;
    if (from < to) { for (let p = from + 1; p <= to; p++) map.set(p, p - 1); }
    else { for (let p = to; p < from; p++) map.set(p, p + 1); }
    map.set(from, to);
  }
  for (const [a, b] of map) {
    if (a < 1 || a > n || b < 1 || b > n) throw new Error('ページ番号が範囲外です');
  }

  // キー衝突を避けるため、対象ページをいったん一時番号に逃してから新番号へ置く
  const TEMP = 1000000;
  const moves = [...map.entries()];
  const total = moves.length * 2;
  let step = 0;
  for (let i = 0; i < moves.length; i++) {
    await movePageRecords(book.id, moves[i][0], TEMP + i);
    onProgress?.(++step, total);
  }
  for (let i = 0; i < moves.length; i++) {
    await movePageRecords(book.id, TEMP + i, moves[i][1]);
    onProgress?.(++step, total);
  }

  const remap = no => map.get(no) ?? no;
  book.bookmarks = (book.bookmarks || []).map(remap).sort((x, y) => x - y);
  book.toc = (book.toc || []).map(t => ({ ...t, page: remap(t.page) })).sort((x, y) => x.page - y.page);
  book.lastPage = remap(book.lastPage || 1);

  // 1ページ目が入れ替わったら表紙を作り直す
  if ([...map.values()].includes(1)) {
    const imgRec = await Images.get(book.id, 1);
    if (imgRec?.blob) {
      const img = new Image();
      const url = URL.createObjectURL(imgRec.blob);
      try { img.src = url; await img.decode(); } finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
      book.cover = await makeScaled(img, COVER_W, 0.82);
    }
  }
  await Books.put(book);
  return book;
}

async function movePageRecords(bookId, fromNo, toNo) {
  for (const storeName of ['images', 'pages', 'strokes']) {
    const rec = await dbGet(storeName, [bookId, fromNo]);
    if (rec) {
      rec.pageNo = toNo;
      await dbPut(storeName, rec); // 先に置いてから消す（途中で落ちてもデータは失われない）
      await dbDel(storeName, [bookId, fromNo]);
    }
  }
}

// ============================================================
// ページ向きを回転（quarterTurns: 1=右90° / 2=180° / 3=左90°）
// from〜to のページ範囲だけ回すこともできる（省略時は全ページ）。
// 画像・サムネ・表紙・書き込み座標をまとめて回して保存し直す。
// 進行状況は book.rotatePending に記録し、途中で止まっても続きから再開できる。
export async function rotateBook(book, quarterTurns, { from = 1, to = 0, onProgress } = {}) {
  const turns = ((quarterTurns % 4) + 4) % 4;
  if (!turns) return book;
  from = Math.max(1, Math.floor(from));
  to = Math.min(book.pageCount, Math.floor(to) || book.pageCount);
  if (from > to) return book;

  // 同じ指定の途中再開なら続きから。別の指定なら最初から（古い記録は from/to なし=全ページ扱い）
  const p = book.rotatePending;
  const resume = p && p.turns === turns && (p.from ?? 1) === from && (p.to ?? book.pageCount) === to;
  const startAt = resume ? p.done : from - 1; // done = 処理が終わったページ番号
  book.rotatePending = { turns, from, to, done: startAt };
  await Books.put(book);

  for (let i = startAt + 1; i <= to; i++) {
    const imgRec = await Images.get(book.id, i);
    const pageRec = await Pages.get(book.id, i);
    if (imgRec?.blob && pageRec) {
      const img = new Image();
      const url = URL.createObjectURL(imgRec.blob);
      try {
        img.src = url;
        await img.decode();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
      const sw = img.naturalWidth, sh = img.naturalHeight;
      const c = rotateOnto(img, sw, sh, turns);

      const blob = await canvasToBlob(c, 'image/jpeg', 0.85);
      const thumb = await makeScaled(c, THUMB_W, 0.8);
      await Images.put({ bookId: book.id, pageNo: i, blob });
      pageRec.w = c.width;
      pageRec.h = c.height;
      pageRec.thumb = thumb;
      await Pages.put(pageRec);

      // 書き込みも一緒に回す（座標は 0..1 正規化なので式だけで変換できる）
      const sRec = await Strokes.get(book.id, i);
      if (sRec?.list?.length) {
        const ratio = sw / sh; // 90°系では「太さ=ページ幅比」の基準幅が変わるため補正
        for (const s of sRec.list) {
          s.pts = s.pts.map(([x, y]) =>
            turns === 1 ? [1 - y, x] : turns === 2 ? [1 - x, 1 - y] : [y, 1 - x]);
          if (turns !== 2) s.size = s.size * ratio;
        }
        await Strokes.put(sRec);
      }

      // ミスノートの登録範囲も一緒に回す
      try { await rotateMissRects(book.id, pageRec.uid, turns); } catch { /* 連携なしでも続行 */ }

      if (i === 1) book.cover = await makeScaled(c, COVER_W, 0.82);
    }
    book.rotatePending.done = i;
    await Books.put(book);
    onProgress?.(i - from + 1, to - from + 1);
  }

  delete book.rotatePending;
  await Books.put(book);
  return book;
}
