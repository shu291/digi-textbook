// リーダー: ページ表示・めくり・ズーム・ジェスチャ・しおり・目次・パネル・検索
import { Books, Pages, Images, Strokes, Prefs } from './db.js';
import * as draw from './draw.js';
import { drawState, PEN_COLORS, MARKER_COLORS } from './draw.js';
import { $, $$, clamp, escapeHtml, toast, openModal, closeModal, confirmDlg } from './util.js';
import { searchBook, startOcr, ocrJob, ocrStatus } from './ocr.js';
import { reorderPages, repairBook } from './importer.js';
import {
  CAUSES, INTERVALS, addMissFromBook, judgeMiss, bookMissNotes,
  resolvePage, cropRect, deleteMissNote, clearCropCache, daysUntil,
} from './misslink.js';
import { uid } from './util.js';

const CANVAS_LONG = 1600; // 書き込みレイヤーの内部解像度（長辺）

const R = {
  book: null, pageNo: 1, total: 0,
  stageW: 0, stageH: 0,
  view: { scale: 1, tx: 0, ty: 0 },
  slots: [],            // [{root, box, img, canvas}] × 3 = [prev, cur, next]
  curBox: { left: 0, top: 0, w: 0, h: 0 },
  pageMeta: new Map(),  // pageNo -> {w, h, thumb, hasText}
  urls: new Map(),      // pageNo -> objectURL（LRU）
  thumbUrls: new Map(),
  uiVisible: true,
  panelTab: 'toc',
  animating: false,
  open: false,
  reorder: null, // 並べ替えモード: { picked: pageNo|null }
  missMode: false,        // ✗ミス登録モード（ドラッグで範囲を囲む）
  missByPage: new Map(),  // pageNo -> [note]（この本のミス登録）
  judgeTarget: null,      // 判定バーの対象 note
};

const el = {};
let saveBookSoon = null;

export function isOpen() { return R.open; }

// ============================================================ 初期化
export function initReader() {
  Object.assign(el, {
    reader: $('#reader'), stage: $('#stage'), zoomWrap: $('#zoomWrap'), pageRow: $('#pageRow'),
    head: $('#rdHead'), foot: $('#rdFoot'),
    title: $('#rdTitle'), pageInd: $('#rdPageInd'),
    slider: $('#pageSlider'),
    backBtn: $('#backBtn'), searchBtn: $('#rdSearchBtn'), bookmarkBtn: $('#bookmarkBtn'),
    panelBtn: $('#panelBtn'), menuBtn: $('#rdMenuBtn'),
    searchBar: $('#rdSearchBar'), searchInput: $('#rdSearchInput'),
    subTools: $('#subTools'), sheetHud: $('#sheetHud'),
    panel: $('#sidePanel'), panelBody: $('#panelBody'),
    undoBtn: $('#undoBtn'), redoBtn: $('#redoBtn'), sheetBtn: $('#sheetBtn'),
    missBtn: $('#missBtn'), judgeBar: $('#judgeBar'),
  });

  // 3 スロット生成
  for (let i = 0; i < 3; i++) {
    const root = document.createElement('div');
    root.className = 'slot';
    root.innerHTML = `<div class="page-box"><img alt="" draggable="false"><canvas></canvas></div>`;
    el.pageRow.appendChild(root);
    R.slots.push({
      root,
      box: root.firstElementChild,
      img: root.querySelector('img'),
      canvas: root.querySelector('canvas'),
      pageNo: 0,
    });
  }

  bindGestures();
  bindUi();
  draw.setOnChange(updateDrawHud);

  new ResizeObserver(() => { if (R.open) relayout(); }).observe(el.stage);
}

// ============================================================ 開閉
export async function openBook(bookId, pageNo) {
  const book = await Books.get(bookId);
  if (!book) { toast('教科書が見つかりません'); return; }
  // 並べ替え事故が残っていたら、開く前に自動修復する
  try {
    if (await repairBook(book)) toast('この本のデータを自動修復しました');
  } catch (e) { console.error('repair failed', e); }
  R.book = book;
  R.total = book.pageCount;
  R.pageNo = clamp(pageNo || book.lastPage || 1, 1, R.total);
  R.pageMeta.clear();
  const pages = await Pages.byBook(bookId);
  for (const p of pages) R.pageMeta.set(p.pageNo, { w: p.w, h: p.h, thumb: p.thumb, hasText: !!p.text });

  document.body.classList.add('reading');
  el.reader.hidden = false;
  el.title.textContent = book.title;
  el.slider.max = R.total;
  setTool('hand');
  setSheet(false);
  setMissMode(false);
  hideJudgeBar();
  showUi(true);
  closePanel();
  hideSearchBar();

  await loadMissNotes();
  relayout();
  await gotoPage(R.pageNo, { instant: true });

  book.lastOpenedAt = Date.now();
  await Books.put(book);
  window.dispatchEvent(new CustomEvent('shelf-refresh'));
}

export async function closeReader() {
  if (!R.open && el.reader.hidden) return;
  await draw.saveNow();
  draw.clearPage();
  if (R.book) {
    R.book.lastPage = R.pageNo;
    await Books.put(R.book);
  }
  R.open = false;
  R.book = null;
  hideJudgeBar();
  R.missMode = false;
  el.missBtn?.classList.remove('active');
  R.missByPage.clear();
  document.body.classList.remove('reading');
  el.reader.hidden = true;
  for (const u of R.urls.values()) URL.revokeObjectURL(u);
  R.urls.clear();
  for (const u of R.thumbUrls.values()) URL.revokeObjectURL(u);
  R.thumbUrls.clear();
  window.dispatchEvent(new CustomEvent('shelf-refresh'));
  window.dispatchEvent(new CustomEvent('miss-refresh'));
}

// ============================================================ レイアウト
function relayout() {
  R.stageW = el.stage.clientWidth;
  R.stageH = el.stage.clientHeight;
  resetView(false);
  setRowBase();
  for (const s of R.slots) if (s.pageNo) sizeSlot(s);
  const cur = R.slots[1];
  if (cur.pageNo) updateCurBox();
}

function sizeSlot(slot) {
  const meta = R.pageMeta.get(slot.pageNo);
  if (!meta) return;
  const fit = Math.min(R.stageW / meta.w, R.stageH / meta.h);
  const w = Math.floor(meta.w * fit);
  const h = Math.floor(meta.h * fit);
  slot.box.style.width = w + 'px';
  slot.box.style.height = h + 'px';
}

function updateCurBox() {
  const slot = R.slots[1];
  const w = slot.box.offsetWidth, h = slot.box.offsetHeight;
  R.curBox = { left: (R.stageW - w) / 2, top: (R.stageH - h) / 2, w, h };
}

function setRowBase(dx = 0, transition = false) {
  el.pageRow.style.transition = transition ? 'transform 0.22s ease-out' : 'none';
  el.pageRow.style.transform = `translateX(${-R.stageW + dx}px)`;
}

// ============================================================ ページ画像
async function getUrl(pageNo) {
  if (R.urls.has(pageNo)) {
    const u = R.urls.get(pageNo);
    R.urls.delete(pageNo); R.urls.set(pageNo, u); // LRU 更新
    return u;
  }
  const rec = await Images.get(R.book.id, pageNo);
  if (!rec?.blob) return '';
  const u = URL.createObjectURL(rec.blob);
  R.urls.set(pageNo, u);
  while (R.urls.size > 12) {
    const [oldNo, oldUrl] = R.urls.entries().next().value;
    if (oldNo === pageNo) break;
    URL.revokeObjectURL(oldUrl);
    R.urls.delete(oldNo);
  }
  return u;
}

async function setSlot(slot, pageNo, isCurrent) {
  slot.pageNo = pageNo;
  if (pageNo < 1 || pageNo > R.total) {
    slot.root.style.visibility = 'hidden';
    slot.img.removeAttribute('src');
    slot.box.querySelectorAll('.miss-mark').forEach(m => m.remove());
    return;
  }
  slot.root.style.visibility = '';
  const meta = R.pageMeta.get(pageNo);
  sizeSlot(slot);
  const cScale = CANVAS_LONG / Math.max(meta.w, meta.h);
  slot.canvas.width = Math.round(meta.w * cScale);
  slot.canvas.height = Math.round(meta.h * cScale);

  const url = await getUrl(pageNo);
  if (slot.pageNo !== pageNo) return; // 追い越しロード対策
  slot.img.src = url;

  const rec = await Strokes.get(R.book.id, pageNo);
  if (slot.pageNo !== pageNo) return;
  const list = rec?.list ? structuredClone(rec.list) : [];
  const ctx = slot.canvas.getContext('2d');
  if (isCurrent) {
    draw.setPage(R.book.id, pageNo, list, ctx, slot.canvas.width, slot.canvas.height);
  } else {
    draw.drawStatic(ctx, list, slot.canvas.width, slot.canvas.height, drawState.sheetMode);
  }
  renderMissMarks(slot);
}

// ============================================================ ページ移動
async function gotoPage(n, { instant = false } = {}) {
  n = clamp(n, 1, R.total);
  await draw.saveNow();
  draw.clearPage();
  R.pageNo = n;
  R.open = true;
  resetView(false);
  setRowBase();
  await setSlot(R.slots[1], n, true);
  updateCurBox();
  setSlot(R.slots[0], n - 1, false);
  setSlot(R.slots[2], n + 1, false);
  updateHud();
  saveLastPage();
}

function flipTo(dir) { // dir: +1 / -1
  if (R.animating) return;
  const target = R.pageNo + dir;
  if (target < 1 || target > R.total) { setRowBase(0, true); return; }
  R.animating = true;
  setRowBase(-dir * R.stageW, true);
  const done = async () => {
    el.pageRow.removeEventListener('transitionend', done);
    R.animating = false;
    await gotoPage(target, { instant: true });
  };
  el.pageRow.addEventListener('transitionend', done);
  setTimeout(() => { if (R.animating) done(); }, 350); // transitionend 保険
}

const nextPage = () => flipTo(1);
const prevPage = () => flipTo(-1);

function saveLastPage() {
  if (!saveBookSoon) {
    let t = null;
    saveBookSoon = () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        if (R.book) { R.book.lastPage = R.pageNo; await Books.put(R.book); }
      }, 800);
    };
  }
  saveBookSoon();
}

// ============================================================ ズーム
function applyView() {
  const { scale, tx, ty } = R.view;
  el.zoomWrap.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
}

function resetView(animate) {
  el.zoomWrap.style.transition = animate ? 'transform 0.2s ease-out' : 'none';
  R.view = { scale: 1, tx: 0, ty: 0 };
  applyView();
  if (animate) setTimeout(() => { el.zoomWrap.style.transition = 'none'; }, 220);
}

function clampView() {
  const v = R.view;
  const b = R.curBox;
  const bw = b.w * v.scale, bh = b.h * v.scale;
  if (bw <= R.stageW) v.tx = R.stageW / 2 - (b.left + b.w / 2) * v.scale;
  else v.tx = clamp(v.tx, R.stageW - (b.left + b.w) * v.scale, -b.left * v.scale);
  if (bh <= R.stageH) v.ty = R.stageH / 2 - (b.top + b.h / 2) * v.scale;
  else v.ty = clamp(v.ty, R.stageH - (b.top + b.h) * v.scale, -b.top * v.scale);
}

function zoomAt(sx, sy, newScale, animate = false) {
  const v = R.view;
  newScale = clamp(newScale, 1, 6);
  const cx = (sx - v.tx) / v.scale;
  const cy = (sy - v.ty) / v.scale;
  v.scale = newScale;
  v.tx = sx - cx * newScale;
  v.ty = sy - cy * newScale;
  clampView();
  if (animate) {
    el.zoomWrap.style.transition = 'transform 0.2s ease-out';
    setTimeout(() => { el.zoomWrap.style.transition = 'none'; }, 220);
  }
  applyView();
}

// stage 座標 → ページ正規化座標 (0..1)。ページ外は null
function toPageNorm(e) {
  const rect = el.stage.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  const v = R.view;
  const cx = (sx - v.tx) / v.scale, cy = (sy - v.ty) / v.scale;
  const b = R.curBox;
  const nx = (cx - b.left) / b.w, ny = (cy - b.top) / b.h;
  if (nx < -0.02 || nx > 1.02 || ny < -0.02 || ny > 1.02) return null;
  return { x: clamp(nx, 0, 1), y: clamp(ny, 0, 1) };
}

// ============================================================ ジェスチャ
function bindGestures() {
  const pointers = new Map();
  let gesture = null;   // {type: 'draw'|'press'|'pinch', ...}
  let lastTap = null;   // {t, x, y}
  let tapTimer = null;

  const stage = el.stage;
  stage.addEventListener('contextmenu', e => e.preventDefault());

  stage.addEventListener('pointerdown', e => {
    if (R.animating) return;
    try { stage.setPointerCapture(e.pointerId); } catch { /* 合成イベント等では失敗しても続行 */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });

    // Apple Pencil を初めて検出したら「指=スクロール」に自動切替
    if (e.pointerType === 'pen' && !drawState.penSeen) {
      drawState.penSeen = true;
      if (drawState.fingerDraw) {
        drawState.fingerDraw = false;
        Prefs.set('fingerDraw', false);
        toast('Apple Pencilを検出：指はスクロール専用にしました（⋯メニューで変更できます）');
      }
      Prefs.set('penSeen', true);
    }

    if (pointers.size === 1) {
      // ✗ミス登録モード: ドラッグで範囲を囲む
      if (R.missMode) {
        const mpt = toPageNorm(e);
        if (mpt) {
          gesture = { type: 'missrect', start: mpt, cur: mpt };
          updateMissSel(gesture);
          return;
        }
      }
      const wantsDraw = draw.isDrawingTool() &&
        (e.pointerType === 'pen' || e.pointerType === 'mouse' || (e.pointerType === 'touch' && drawState.fingerDraw));
      const pt = wantsDraw ? toPageNorm(e) : null;
      if (pt && draw.beginStroke(pt.x, pt.y)) {
        gesture = { type: 'draw', id: e.pointerId };
      } else {
        gesture = {
          type: 'press', id: e.pointerId,
          x0: e.clientX, y0: e.clientY, t0: Date.now(),
          moved: false, view0: { ...R.view }, rowDx: 0,
        };
      }
    } else if (pointers.size === 2) {
      if (gesture?.type === 'draw') draw.endStroke(true); // 誤タッチ: 描きかけ破棄
      if (gesture?.type === 'missrect') updateMissSel(null);
      if (gesture?.type === 'press' && gesture.rowDx) setRowBase(0, false);
      const [p1, p2] = [...pointers.values()];
      gesture = {
        type: 'pinch',
        d0: Math.hypot(p1.x - p2.x, p1.y - p2.y),
        view0: { ...R.view },
        c0: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
      };
    }
  });

  stage.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    if (!gesture) return;

    if (gesture.type === 'missrect') {
      const pt = toPageNorm(e);
      if (pt) { gesture.cur = pt; updateMissSel(gesture); }
      return;
    }

    if (gesture.type === 'draw') {
      let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      if (!evs.length) evs = [e]; // 対応外ブラウザや合成イベントでは空になる
      for (const ev of evs) {
        const pt = toPageNorm(ev);
        if (pt) draw.moveStroke(pt.x, pt.y);
      }
      return;
    }

    if (gesture.type === 'pinch' && pointers.size >= 2) {
      const [p1, p2] = [...pointers.values()];
      const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      const c = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      const rect = el.stage.getBoundingClientRect();
      const v0 = gesture.view0;
      const newScale = clamp(v0.scale * (d / gesture.d0), 1, 6);
      const sx = c.x - rect.left, sy = c.y - rect.top;
      const c0x = (gesture.c0.x - rect.left - v0.tx) / v0.scale;
      const c0y = (gesture.c0.y - rect.top - v0.ty) / v0.scale;
      R.view.scale = newScale;
      R.view.tx = sx - c0x * newScale;
      R.view.ty = sy - c0y * newScale;
      clampView();
      applyView();
      return;
    }

    if (gesture.type === 'press') {
      const dx = e.clientX - gesture.x0;
      const dy = e.clientY - gesture.y0;
      if (!gesture.moved && Math.hypot(dx, dy) > 7) gesture.moved = true;
      if (!gesture.moved) return;
      if (R.view.scale > 1.01) {
        R.view.tx = gesture.view0.tx + dx;
        R.view.ty = gesture.view0.ty + dy;
        clampView();
        applyView();
      } else {
        let rowDx = dx;
        if ((R.pageNo <= 1 && dx > 0) || (R.pageNo >= R.total && dx < 0)) rowDx = dx * 0.3;
        gesture.rowDx = rowDx;
        setRowBase(rowDx, false);
      }
    }
  });

  const finish = e => {
    const wasIn = pointers.has(e.pointerId);
    pointers.delete(e.pointerId);
    if (!wasIn || !gesture) return;

    if (gesture.type === 'missrect') {
      const g = gesture;
      gesture = null;
      finishMissRect(g);
      return;
    }
    if (gesture.type === 'draw') {
      draw.endStroke();
      gesture = null;
      return;
    }
    if (gesture.type === 'pinch') {
      if (pointers.size < 2) {
        if (R.view.scale < 1.05) resetView(true);
        gesture = null;
      }
      return;
    }
    if (gesture.type === 'press') {
      const g = gesture;
      gesture = null;
      const dt = Date.now() - g.t0;
      if (!g.moved && dt < 400) { handleTap(e); return; }
      if (R.view.scale <= 1.01 && g.rowDx) {
        const vel = Math.abs(g.rowDx) / Math.max(1, dt);
        if (Math.abs(g.rowDx) > R.stageW * 0.16 || vel > 0.45) flipTo(g.rowDx < 0 ? 1 : -1);
        else setRowBase(0, true);
      }
    }
  };
  stage.addEventListener('pointerup', finish);
  stage.addEventListener('pointercancel', e => {
    pointers.delete(e.pointerId);
    if (gesture?.type === 'draw') draw.endStroke(true);
    if (gesture?.type === 'missrect') updateMissSel(null);
    if (gesture?.type === 'press' && gesture.rowDx) setRowBase(0, true);
    gesture = null;
  });

  function handleTap(e) {
    // 赤シート: 塗った場所のタップで開閉
    if (drawState.sheetMode) {
      const pt = toPageNorm(e);
      if (pt && draw.sheetTap(pt.x, pt.y)) { updateSheetHud(); return; }
    }
    // ミス印のタップで状況を表示
    if (!R.missMode && drawState.tool === 'hand') {
      const pt = toPageNorm(e);
      if (pt) {
        const list = R.missByPage.get(R.pageNo) || [];
        for (let i = list.length - 1; i >= 0; i--) {
          const [mx, my, mw, mh] = list[i].ref.rect;
          if (pt.x >= mx && pt.x <= mx + mw && pt.y >= my && pt.y <= my + mh) {
            openMissInfo(list[i]);
            return;
          }
        }
      }
    }
    const rect = el.stage.getBoundingClientRect();
    const rx = (e.clientX - rect.left) / rect.width;

    // 画面端タップでページ送り（等倍・手のひらツールのとき）
    if (R.view.scale <= 1.01 && drawState.tool === 'hand') {
      if (rx < 0.16) { prevPage(); return; }
      if (rx > 0.84) { nextPage(); return; }
    }

    // 中央: ダブルタップ=ズーム / シングル=バー表示切替
    const now = Date.now();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    if (lastTap && now - lastTap.t < 300 && Math.hypot(sx - lastTap.x, sy - lastTap.y) < 40) {
      clearTimeout(tapTimer);
      lastTap = null;
      if (R.view.scale > 1.01) resetView(true);
      else zoomAt(sx, sy, 2.6, true);
      return;
    }
    lastTap = { t: now, x: sx, y: sy };
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => { lastTap = null; showUi(!R.uiVisible); }, 300);
  }

  // Mac: トラックパッドのピンチ (ctrl+wheel) でズーム、ホイールでパン
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = el.stage.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * 0.012);
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, R.view.scale * factor);
    } else if (R.view.scale > 1.01) {
      R.view.tx -= e.deltaX;
      R.view.ty -= e.deltaY;
      clampView();
      applyView();
    } else {
      wheelAccum += e.deltaX;
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => { wheelAccum = 0; }, 180);
      if (Math.abs(wheelAccum) > 120) {
        const d = wheelAccum > 0 ? 1 : -1;
        wheelAccum = 0;
        flipTo(d);
      }
    }
  }, { passive: false });
  let wheelAccum = 0, wheelTimer = null;

  window.addEventListener('keydown', e => {
    if (!R.open || el.reader.hidden) return;
    const inInput = /INPUT|TEXTAREA/.test(document.activeElement?.tagName || '');
    if (e.key === 'Escape') {
      if (!el.searchBar.hidden) { hideSearchBar(); return; }
      if (!el.panel.hidden) { closePanel(); return; }
      closeReader();
      return;
    }
    if (inInput) return;
    if (e.key === 'ArrowRight') nextPage();
    else if (e.key === 'ArrowLeft') prevPage();
    else if (e.key === 'Home') gotoPage(1, { instant: true });
    else if (e.key === 'End') gotoPage(R.total, { instant: true });
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) draw.redo(); else draw.undo();
    }
  });
}

// ============================================================ UI
function bindUi() {
  el.backBtn.onclick = () => closeReader();
  el.bookmarkBtn.onclick = toggleBookmark;
  el.panelBtn.onclick = () => (el.panel.hidden ? openPanel(R.panelTab) : closePanel());
  el.menuBtn.onclick = openReaderMenu;
  el.searchBtn.onclick = () => (el.searchBar.hidden ? showSearchBar() : hideSearchBar());
  $('#rdSearchClose').onclick = hideSearchBar;

  let searchTimer = null;
  el.searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runReaderSearch, 400);
  });
  el.searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') runReaderSearch(); });

  el.slider.addEventListener('input', () => {
    el.pageInd.textContent = `${el.slider.value} / ${R.total}`;
  });
  el.slider.addEventListener('change', () => gotoPage(+el.slider.value, { instant: true }));

  $$('#rdFoot [data-tool]').forEach(btn => {
    btn.onclick = () => setTool(btn.dataset.tool);
  });
  el.undoBtn.onclick = () => draw.undo();
  el.redoBtn.onclick = () => draw.redo();
  el.sheetBtn.onclick = () => setSheet(!drawState.sheetMode);
  el.missBtn.onclick = () => setMissMode(!R.missMode);
  $('#jbOk').onclick = () => judgeAndClose(true);
  $('#jbNg').onclick = () => judgeAndClose(false);
  $('#jbLater').onclick = hideJudgeBar;

  $('#sheetHideAll').onclick = () => { draw.setAllHidden(true); updateSheetHud(); };
  $('#sheetShowAll').onclick = () => { draw.setAllHidden(false); updateSheetHud(); };

  $$('#panelTabs button').forEach(btn => {
    btn.onclick = () => openPanel(btn.dataset.tab);
  });
  $('#panelClose').onclick = closePanel;
}

function showUi(show) {
  R.uiVisible = show;
  el.head.classList.toggle('hidden-bar', !show);
  el.foot.classList.toggle('hidden-bar', !show);
}

function updateHud() {
  el.pageInd.textContent = `${R.pageNo} / ${R.total}`;
  el.slider.value = R.pageNo;
  el.bookmarkBtn.classList.toggle('active', R.book.bookmarks.includes(R.pageNo));
  updateDrawHud();
  updateSheetHud();
}

function updateDrawHud() {
  el.undoBtn.disabled = !draw.canUndo();
  el.redoBtn.disabled = !draw.canRedo();
}

function updateSheetHud() {
  const on = drawState.sheetMode;
  el.sheetBtn.classList.toggle('active', on);
  el.sheetHud.hidden = !on;
  if (on) {
    const s = draw.sheetStats();
    $('#sheetCount').textContent = s.total
      ? `かくし中 ${s.hidden} / ${s.total}`
      : 'このページに暗記マーカーはありません';
  }
}

// ---- ツール ----
function setTool(tool) {
  drawState.tool = tool;
  if (R.missMode && tool !== 'hand') { R.missMode = false; el.missBtn?.classList.remove('active'); }
  $$('#rdFoot [data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  renderSubTools();
}

function setMissMode(on) {
  R.missMode = on;
  el.missBtn?.classList.toggle('active', on);
  if (on) {
    if (drawState.sheetMode) setSheet(false);
    setTool('hand');
    R.missMode = true; // setTool が解除するので立て直す
    el.missBtn?.classList.add('active');
    toast('まちがえた問題を四角く囲んでね');
  }
}

function renderSubTools() {
  const t = drawState.tool;
  const box = el.subTools;
  if (t === 'hand') { box.hidden = true; return; }
  box.hidden = false;
  let html = '';
  if (t === 'pen') {
    html += chipRow('color', PEN_COLORS, drawState.penColor);
    html += sizeRow(drawState.penSize);
  } else if (t === 'marker') {
    html += chipRow('color', MARKER_COLORS, drawState.markerColor);
    html += sizeRow(drawState.markerSize);
  } else if (t === 'memo') {
    html += `<span class="subtool-hint">緑で塗る → 赤シートONでかくれる</span>`;
    html += sizeRow(drawState.memoSize);
  } else if (t === 'eraser') {
    html += `<span class="subtool-hint">消したい線をなぞってね</span>`;
  }
  box.innerHTML = html;
  $$('[data-color]', box).forEach(b => {
    b.onclick = () => {
      if (drawState.tool === 'pen') drawState.penColor = b.dataset.color;
      else drawState.markerColor = b.dataset.color;
      renderSubTools();
    };
  });
  $$('[data-size]', box).forEach(b => {
    b.onclick = () => {
      const i = +b.dataset.size;
      if (drawState.tool === 'pen') drawState.penSize = i;
      else if (drawState.tool === 'memo') drawState.memoSize = i;
      else drawState.markerSize = i;
      renderSubTools();
    };
  });
}

function chipRow(_, colors, active) {
  return `<span class="chip-row">` + colors.map(c =>
    `<button class="color-chip ${c === active ? 'active' : ''}" data-color="${c}" style="--c:${c}" aria-label="色"></button>`
  ).join('') + `</span>`;
}
function sizeRow(active) {
  return `<span class="chip-row">` + [0, 1, 2].map(i =>
    `<button class="size-chip ${i === active ? 'active' : ''}" data-size="${i}" aria-label="太さ"><span style="width:${6 + i * 5}px;height:${6 + i * 5}px"></span></button>`
  ).join('') + `</span>`;
}

function setSheet(on) {
  draw.setSheetMode(on);
  if (on) setTool('hand'); // タップで開閉しやすいように
  updateSheetHud();
  const cur = R.slots[1];
  // 前後スロットにも反映
  [0, 2].forEach(async i => {
    const s = R.slots[i];
    if (!s.pageNo || s.pageNo < 1 || s.pageNo > R.total) return;
    const rec = await Strokes.get(R.book.id, s.pageNo);
    const list = rec?.list ? structuredClone(rec.list) : [];
    if (on) for (const st of list) if (st.tool === 'memo') st.hidden = true;
    draw.drawStatic(s.canvas.getContext('2d'), list, s.canvas.width, s.canvas.height, on);
  });
  void cur;
}

// ---- しおり ----
async function toggleBookmark() {
  const b = R.book;
  const i = b.bookmarks.indexOf(R.pageNo);
  if (i >= 0) { b.bookmarks.splice(i, 1); toast('しおりを外しました'); }
  else { b.bookmarks.push(R.pageNo); b.bookmarks.sort((x, y) => x - y); toast('しおりをはさみました'); }
  await Books.put(b);
  updateHud();
  if (!el.panel.hidden && R.panelTab === 'bookmarks') renderPanel();
}

// ============================================================ サイドパネル（目次・しおり・ページ一覧）
function openPanel(tab) {
  if (!['toc', 'bookmarks', 'pages'].includes(tab)) tab = 'toc'; // 検索表示のあと等
  R.panelTab = tab;
  el.panel.hidden = false;
  $$('#panelTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  renderPanel();
}
function closePanel() { el.panel.hidden = true; }

function thumbUrl(pageNo) {
  if (R.thumbUrls.has(pageNo)) return R.thumbUrls.get(pageNo);
  const meta = R.pageMeta.get(pageNo);
  if (!meta?.thumb) return '';
  const u = URL.createObjectURL(meta.thumb);
  R.thumbUrls.set(pageNo, u);
  return u;
}

function renderPanel() {
  const tab = R.panelTab;
  const b = R.book;
  let html = '';
  if (tab === 'toc') {
    html += `<button class="btn prime wide" id="tocAdd">＋ このページに章を追加</button>`;
    if (!b.toc.length) {
      html += `<p class="panel-empty">章を登録すると目次からジャンプできます</p>`;
    } else {
      html += `<ul class="toc-list">` + b.toc.map((t, i) =>
        `<li><button class="toc-jump" data-page="${t.page}">
           <span class="toc-title">${escapeHtml(t.title)}</span><span class="toc-page">p.${t.page}</span>
         </button><button class="icon-btn small toc-del" data-i="${i}" aria-label="削除">✕</button></li>`
      ).join('') + `</ul>`;
    }
  } else if (tab === 'bookmarks') {
    if (!b.bookmarks.length) {
      html += `<p class="panel-empty">右上のしおりボタンでページに<br>しおりをはさめます</p>`;
    } else {
      html += `<ul class="bm-list">` + b.bookmarks.map(p =>
        `<li><button class="bm-jump" data-page="${p}">
           <img src="${thumbUrl(p)}" alt=""><span>p.${p}</span>
         </button><button class="icon-btn small bm-del" data-page="${p}" aria-label="外す">✕</button></li>`
      ).join('') + `</ul>`;
    }
  } else if (tab === 'pages') {
    const ro = R.reorder;
    html += `<div class="pg-tools">
      <button class="btn ${ro ? 'prime' : 'ghost'} small-btn" id="pgReorderBtn">${ro ? '完了' : '並べ替え'}</button>
      <span class="pg-hint">${ro
        ? (ro.picked ? `p.${ro.picked} を選択中 → 行き先のページをタップ` : '動かしたいページをタップ')
        : 'タップでそのページへ'}</span>
    </div>`;
    html += `<div class="page-grid">` + Array.from({ length: R.total }, (_, k) => {
      const p = k + 1;
      const marks =
        (b.bookmarks.includes(p) ? '<span class="pg-bm"></span>' : '') +
        (b.toc.some(t => t.page === p) ? '<span class="pg-toc"></span>' : '');
      const picked = ro?.picked === p ? ' picked' : '';
      return `<button class="pg-cell ${p === R.pageNo ? 'current' : ''}${picked}" data-page="${p}">
        <img src="${thumbUrl(p)}" alt="" loading="lazy">${marks}<span class="pg-no">${p}</span>
      </button>`;
    }).join('') + `</div>`;
  }
  el.panelBody.innerHTML = html;

  $('#tocAdd', el.panelBody)?.addEventListener('click', addTocEntry);
  $('#pgReorderBtn', el.panelBody)?.addEventListener('click', () => {
    R.reorder = R.reorder ? null : { picked: null };
    renderPanel();
  });
  $$('.toc-jump, .bm-jump', el.panelBody).forEach(btn => {
    btn.onclick = () => { gotoPage(+btn.dataset.page, { instant: true }); closePanel(); };
  });
  $$('.pg-cell', el.panelBody).forEach(btn => {
    btn.onclick = () => {
      const p = +btn.dataset.page;
      if (!R.reorder) { gotoPage(p, { instant: true }); closePanel(); return; }
      onReorderTap(p);
    };
  });
  $$('.toc-del', el.panelBody).forEach(btn => {
    btn.onclick = async () => {
      b.toc.splice(+btn.dataset.i, 1);
      await Books.put(b);
      renderPanel();
    };
  });
  $$('.bm-del', el.panelBody).forEach(btn => {
    btn.onclick = async () => {
      b.bookmarks = b.bookmarks.filter(p => p !== +btn.dataset.page);
      await Books.put(b);
      renderPanel(); updateHud();
    };
  });
  if (tab === 'pages') {
    $(`.pg-cell.current`, el.panelBody)?.scrollIntoView({ block: 'center' });
  }
}

// ---- ページ並べ替え ----
function onReorderTap(p) {
  const ro = R.reorder;
  if (!ro.picked) { ro.picked = p; renderPanel(); return; }
  if (ro.picked === p) { ro.picked = null; renderPanel(); return; }
  const a = ro.picked, b = p;
  const box = openModal(`
    <h3 class="modal-title">p.${a} をどうする？</h3>
    <div class="menu-list">
      <button class="menu-item" id="roSwap"><span>p.${b} と入れ替える</span><small>p.${a} ⇄ p.${b}</small></button>
      <button class="menu-item" id="roBefore"><span>p.${b} の前に移動</span><small>あいだのページは自動でずれます</small></button>
      <button class="menu-item" id="roAfter"><span>p.${b} の後ろに移動</span></button>
    </div>
    <div class="modal-btns"><button class="btn ghost" data-x>キャンセル</button></div>`, { sticky: true });
  box.querySelector('[data-x]').onclick = closeModal;
  box.querySelector('#roSwap').onclick = () => doReorder({ type: 'swap', a, b });
  box.querySelector('#roBefore').onclick = () => doReorder({ type: 'move', from: a, to: a < b ? b - 1 : b });
  box.querySelector('#roAfter').onclick = () => doReorder({ type: 'move', from: a, to: a < b ? b : b + 1 });
}

async function doReorder(op) {
  if (ocrJob.running && ocrJob.bookId === R.book.id) {
    closeModal();
    toast('文字認識が終わってから並べ替えてね');
    return;
  }
  closeModal();
  const box = openModal(`
    <h3 class="modal-title">並べ替え中…</h3>
    <progress id="reProg" class="wide-prog" max="1" value="0"></progress>`, { sticky: true });
  try {
    await draw.saveNow();
    draw.clearPage();
    R.book.lastPage = R.pageNo; // いま見ているページを追いかける
    await reorderPages(R.book, op, {
      onProgress: (d, t) => {
        const prog = box.querySelector('#reProg');
        if (prog) { prog.max = t; prog.value = d; }
      },
    });
    R.pageNo = clamp(R.book.lastPage || 1, 1, R.total);
    // ページ情報とサムネを読み直す
    const pages = await Pages.byBook(R.book.id);
    R.pageMeta.clear();
    for (const p of pages) {
      if (p.pageNo >= 1 && p.pageNo <= R.total) {
        R.pageMeta.set(p.pageNo, { w: p.w, h: p.h, thumb: p.thumb, hasText: !!p.text });
      }
    }
    for (const u of R.thumbUrls.values()) URL.revokeObjectURL(u);
    R.thumbUrls.clear();
    closeModal();
    await gotoPage(R.pageNo, { instant: true });
    R.reorder = { picked: null }; // モードは続ける（連続で並べ替えられる）
    renderPanel();
    toast('並べ替えました');
    window.dispatchEvent(new CustomEvent('shelf-refresh'));
  } catch (e) {
    console.error(e);
    closeModal();
    openModal(`
      <h3 class="modal-title">並べ替えが途中で止まりました</h3>
      <p class="modal-msg">この本をひらき直すと<b>自動で修復</b>されます。データは消えていません。<br>
        <small>容量不足が原因のこともあります（設定→保存領域を確認してね）<br>${escapeHtml(e?.message || '')}</small></p>
      <div class="modal-btns"><button class="btn prime" data-x>OK</button></div>`)
      .querySelector('[data-x]').onclick = closeModal;
  }
}

function addTocEntry() {
  const box = openModal(`
    <h3 class="modal-title">章を追加</h3>
    <label class="field"><span>章の名前</span><input id="tocTitle" placeholder="例：第3章 光合成" maxlength="40"></label>
    <label class="field"><span>ページ</span><input id="tocPage" type="number" min="1" max="${R.total}" value="${R.pageNo}"></label>
    <div class="modal-btns">
      <button class="btn ghost" data-x>キャンセル</button>
      <button class="btn prime" data-ok>追加</button>
    </div>`, { sticky: true });
  box.querySelector('[data-x]').onclick = closeModal;
  box.querySelector('#tocTitle').focus();
  box.querySelector('[data-ok]').onclick = async () => {
    const title = box.querySelector('#tocTitle').value.trim();
    const page = clamp(+box.querySelector('#tocPage').value || R.pageNo, 1, R.total);
    if (!title) { toast('章の名前を入れてください'); return; }
    R.book.toc.push({ page, title });
    R.book.toc.sort((a, b2) => a.page - b2.page);
    await Books.put(R.book);
    closeModal();
    renderPanel();
    toast('目次に追加しました');
  };
}

// ============================================================ ミスノート連携
async function loadMissNotes() {
  R.missByPage.clear();
  try {
    const [notes, pages] = await Promise.all([bookMissNotes(R.book.id), Pages.byBook(R.book.id)]);
    const byUid = new Map(pages.filter(p => p.uid).map(p => [p.uid, p.pageNo]));
    for (const n of notes) {
      const pageNo = byUid.get(n.ref.pageUid);
      if (!pageNo) continue;
      if (!R.missByPage.has(pageNo)) R.missByPage.set(pageNo, []);
      R.missByPage.get(pageNo).push(n);
    }
  } catch { /* ミスノートDBが開けなくても読書は続行 */ }
}

// ページ上の✗印（登録済みミスの範囲）
function renderMissMarks(slot) {
  slot.box.querySelectorAll('.miss-mark').forEach(m => m.remove());
  const list = R.missByPage.get(slot.pageNo);
  if (!list) return;
  for (const n of list) {
    const [x, y, w, h] = n.ref.rect;
    const d = document.createElement('div');
    d.className = 'miss-mark' + (n.mastered ? ' done' : '');
    d.style.left = (x * 100) + '%';
    d.style.top = (y * 100) + '%';
    d.style.width = (w * 100) + '%';
    d.style.height = (h * 100) + '%';
    d.dataset.note = n.id;
    d.innerHTML = `<span class="mm-badge">${n.mastered ? '✓' : '✗'}</span>`;
    slot.box.appendChild(d);
  }
}

// 囲み中の選択枠
function updateMissSel(g) {
  const box = R.slots[1].box;
  let sel = box.querySelector('.miss-sel');
  if (!g) { sel?.remove(); return; }
  if (!sel) {
    sel = document.createElement('div');
    sel.className = 'miss-sel';
    box.appendChild(sel);
  }
  const x = Math.min(g.start.x, g.cur.x), y = Math.min(g.start.y, g.cur.y);
  const w = Math.abs(g.cur.x - g.start.x), h = Math.abs(g.cur.y - g.start.y);
  sel.style.left = (x * 100) + '%';
  sel.style.top = (y * 100) + '%';
  sel.style.width = (w * 100) + '%';
  sel.style.height = (h * 100) + '%';
}

async function finishMissRect(g) {
  updateMissSel(null);
  const x = Math.min(g.start.x, g.cur.x), y = Math.min(g.start.y, g.cur.y);
  const w = Math.abs(g.cur.x - g.start.x), h = Math.abs(g.cur.y - g.start.y);
  if (w < 0.04 || h < 0.02) { toast('もう少し大きく囲んでね'); return; }
  const rect = [x, y, w, h];
  const pageNo = R.pageNo;
  const url = await cropRect(R.book.id, pageNo, rect, 640);
  let cause = null;
  const box = openModal(`
    <h3 class="modal-title">ミスノートに登録</h3>
    ${url ? `<div class="miss-prev"><img src="${url}" alt="問題の切り抜き"></div>` : ''}
    <div class="field"><span>まちがえた原因（えらばなくてもOK）</span>
      <div class="subject-picker">${CAUSES.map(c =>
        `<button class="subject-opt" data-c="${escapeHtml(c)}" style="--sc:#d0563b">${escapeHtml(c)}</button>`).join('')}</div>
    </div>
    <p class="modal-note">画像はコピーせず「この本のこの場所」として登録します。あした復習に出ます。</p>
    <div class="modal-btns">
      <button class="btn ghost" data-x>やめる</button>
      <button class="btn prime" data-ok>登録する</button>
    </div>`, { sticky: true });
  $$('.subject-opt', box).forEach(b => {
    b.onclick = () => {
      cause = b.dataset.c === cause ? null : b.dataset.c;
      $$('.subject-opt', box).forEach(o => o.classList.toggle('active', o.dataset.c === cause));
    };
  });
  box.querySelector('[data-x]').onclick = () => {
    if (url) URL.revokeObjectURL(url);
    closeModal();
  };
  box.querySelector('[data-ok]').onclick = async () => {
    if (url) URL.revokeObjectURL(url);
    try {
      const page = await Pages.get(R.book.id, pageNo);
      if (!page.uid) { page.uid = uid(); await Pages.put(page); } // ページに背番号を付ける
      const note = await addMissFromBook(R.book, page.uid, rect, cause);
      if (!R.missByPage.has(pageNo)) R.missByPage.set(pageNo, []);
      R.missByPage.get(pageNo).push(note);
      renderMissMarks(R.slots[1]);
      closeModal();
      setMissMode(false);
      toast('ミスノートに登録！あした復習に出るよ');
      window.dispatchEvent(new CustomEvent('miss-refresh'));
    } catch (e2) {
      console.error(e2);
      closeModal();
      toast('登録に失敗しました');
    }
  };
}

const fmtDue = t => {
  const d = daysUntil(t);
  return d <= 0 ? 'きょう' : d === 1 ? 'あした' : `${d}日後`;
};

async function openMissInfo(n) {
  const url = await cropRect(n.ref.bookId, R.pageNo, n.ref.rect, 640);
  const st = n.mastered
    ? '定着ずみ 🎉'
    : `定着ステップ ${n.step} / ${INTERVALS.length} ・ 次の復習: ${n.dueAt ? fmtDue(n.dueAt) : '—'}`;
  const box = openModal(`
    <h3 class="modal-title">登録ずみのミス</h3>
    ${url ? `<div class="miss-prev"><img src="${url}" alt=""></div>` : ''}
    <p class="modal-msg">${escapeHtml(st)}<br>
      <small>原因: ${escapeHtml(n.cause || '未分類')} ・ 登録 ${new Date(n.createdAt).toLocaleDateString('ja-JP')}</small></p>
    <div class="modal-btns">
      <button class="btn ghost" id="miDel">登録をとり消す</button>
      <button class="btn prime" data-x>閉じる</button>
    </div>`);
  const cleanup = () => { if (url) URL.revokeObjectURL(url); };
  box.querySelector('[data-x]').onclick = () => { cleanup(); closeModal(); };
  box.querySelector('#miDel').onclick = async () => {
    cleanup();
    closeModal();
    const ok = await confirmDlg('このミスの登録をとり消す？<br><small>復習の予定からも消えます</small>', { ok: 'とり消す', danger: true });
    if (!ok) return;
    await deleteMissNote(n.id);
    const list = R.missByPage.get(R.pageNo) || [];
    R.missByPage.set(R.pageNo, list.filter(m => m.id !== n.id));
    renderMissMarks(R.slots[1]);
    toast('とり消しました');
    window.dispatchEvent(new CustomEvent('miss-refresh'));
  };
}

// ミス一覧やミスノートから「この問題を解き直す」で呼ばれる
export async function openBookForMiss(note) {
  const pageNo = await resolvePage(note.ref.bookId, note.ref.pageUid);
  if (!pageNo) {
    toast('この問題のページが見つかりません（本が削除されたかも）');
    return;
  }
  await openBook(note.ref.bookId, pageNo);
  R.judgeTarget = note;
  el.judgeBar.hidden = false;
  setTimeout(() => {
    R.slots[1].box.querySelector(`.miss-mark[data-note="${note.id}"]`)?.classList.add('pulse');
  }, 350);
}

function hideJudgeBar() {
  if (el.judgeBar) el.judgeBar.hidden = true;
  R.judgeTarget = null;
  R.slots?.[1]?.box.querySelector('.miss-mark.pulse')?.classList.remove('pulse');
}

async function judgeAndClose(ok) {
  const n = R.judgeTarget;
  if (!n) return;
  await judgeMiss(n, ok);
  hideJudgeBar();
  await loadMissNotes();
  for (const s of R.slots) if (s.pageNo) renderMissMarks(s);
  toast(ok
    ? (n.mastered ? 'ぜんぶクリア！この問題は定着ずみ🎉' : `できた！次は ${fmtDue(n.dueAt)} に出るよ`)
    : 'ドンマイ！あしたまた出すよ');
  window.dispatchEvent(new CustomEvent('miss-refresh'));
}

// ============================================================ リーダー内検索
function showSearchBar() {
  el.searchBar.hidden = false;
  el.searchInput.focus();
}
function hideSearchBar() {
  el.searchBar.hidden = true;
  el.searchInput.value = '';
  if (R.panelTab === 'search') closePanel();
}

async function runReaderSearch() {
  const q = el.searchInput.value.trim();
  if (!q) return;
  const hits = await searchBook(R.book, q);
  R.panelTab = 'search';
  el.panel.hidden = false;
  $$('#panelTabs button').forEach(b => b.classList.remove('active'));

  if (!hits.length) {
    const st = await ocrStatus(R.book.id);
    let extra = '';
    if (st.withText === 0) {
      extra = `<p class="panel-empty">この本はまだ文字データがありません。<br>文字認識（OCR）をすると検索できるようになります。</p>
        <button class="btn prime wide" id="searchOcrBtn">文字認識をはじめる</button>`;
    } else if (st.withText < st.total) {
      extra = `<p class="panel-empty">※ 文字データがあるのは ${st.withText}/${st.total} ページです。<br>⋯メニューから残りも文字認識できます。</p>`;
    }
    el.panelBody.innerHTML = `<p class="panel-empty">「${escapeHtml(q)}」は見つかりませんでした</p>` + extra;
    $('#searchOcrBtn', el.panelBody)?.addEventListener('click', () => runOcrFromReader());
    return;
  }
  el.panelBody.innerHTML =
    `<p class="search-summary">「${escapeHtml(q)}」 ${hits.length}ページでヒット</p>` +
    `<ul class="hit-list">` + hits.map(h =>
      `<li><button class="hit-jump" data-page="${h.pageNo}">
        <span class="hit-page">p.${h.pageNo}<em>${h.count}件</em></span>
        ${h.snippets.map(s =>
          `<span class="hit-snip">${escapeHtml(s.pre)}<mark>${escapeHtml(s.match)}</mark>${escapeHtml(s.post)}</span>`
        ).join('')}
      </button></li>`
    ).join('') + `</ul>`;
  $$('.hit-jump', el.panelBody).forEach(btn => {
    btn.onclick = () => { gotoPage(+btn.dataset.page, { instant: true }); hideSearchBar(); };
  });
}

async function runOcrFromReader(force = false) {
  closeModal();
  closePanel();
  try {
    await startOcr(R.book, { force });
  } catch (e) {
    toast(e.message || '文字認識を開始できませんでした');
  }
}

// ============================================================ ⋯メニュー
async function openReaderMenu() {
  const st = await ocrStatus(R.book.id);
  const ocrLabel = st.withText >= st.total
    ? `文字データあり（全${st.total}ページ）`
    : `文字データ ${st.withText} / ${st.total} ページ`;
  const box = openModal(`
    <h3 class="modal-title">${escapeHtml(R.book.title)}</h3>
    <div class="menu-list">
      <button class="menu-item" id="mOcr" ${ocrJob.running ? 'disabled' : ''}>
        <span>文字認識（OCR）を実行</span><small>${ocrLabel}${ocrJob.running ? '・実行中…' : ''}</small>
      </button>
      <button class="menu-item" id="mRotate">
        <span>ページの向きを回転</span>
        <small>いったん本棚に戻って、全ページをまとめて回します</small>
      </button>
      <button class="menu-item" id="mFinger">
        <span>指で描く：${drawState.fingerDraw ? 'ON' : 'OFF'}</span>
        <small>OFFにするとApple Pencil専用（指はスクロール）</small>
      </button>
      <button class="menu-item" id="mHelp"><span>つかいかた</span><small>操作のヒント</small></button>
    </div>
    <div class="modal-btns"><button class="btn ghost" data-x>閉じる</button></div>`);
  box.querySelector('[data-x]').onclick = closeModal;
  box.querySelector('#mOcr').onclick = async () => {
    if (st.withText > 0) {
      closeModal();
      const redo2 = await confirmDlg(
        `文字データがないページだけ認識しますか？<br><small>「ぜんぶやり直す」は時間がかかります</small>`,
        { ok: '足りない分だけ', cancel: 'ぜんぶやり直す' });
      runOcrFromReader(!redo2);
    } else {
      runOcrFromReader();
    }
  };
  box.querySelector('#mRotate').onclick = async () => {
    closeModal();
    const id = R.book.id;
    await closeReader();
    window.dispatchEvent(new CustomEvent('rotate-request', { detail: id }));
  };
  box.querySelector('#mFinger').onclick = () => {
    drawState.fingerDraw = !drawState.fingerDraw;
    Prefs.set('fingerDraw', drawState.fingerDraw);
    toast(drawState.fingerDraw ? '指でも描けるようにしました' : '指はスクロール専用にしました');
    closeModal();
  };
  box.querySelector('#mHelp').onclick = () => {
    closeModal();
    openModal(`
      <h3 class="modal-title">つかいかた</h3>
      <ul class="help-list">
        <li><b>ページをめくる</b>：左右にスワイプ／画面の端をタップ</li>
        <li><b>拡大</b>：2本指でピンチ／ダブルタップ</li>
        <li><b>書き込む</b>：下のツールバーからペンやマーカーを選ぶ</li>
        <li><b>暗記マーカー</b>（緑）で答えを塗る → <b>赤シート</b>ボタンで隠す → タップでめくれる</li>
        <li><b>検索</b>：虫めがねボタン。スキャンした本は先に「文字認識」を実行してね</li>
        <li><b>バーを隠す</b>：画面の真ん中をタップ</li>
      </ul>
      <div class="modal-btns"><button class="btn prime" data-x>OK</button></div>`)
      .querySelector('[data-x]').onclick = closeModal;
  };
}
