// 書き込みエンジン: ストローク管理・描画・消しゴム・undo/redo・赤シート
// 座標は全て「ページに対する割合 (0..1)」で保存する。画像の解像度が変わってもズレない。
import { Strokes } from './db.js';
import { uid, debounce } from './util.js';

export const PEN_COLORS = ['#20242b', '#d03b3b', '#2a6bd6'];
export const MARKER_COLORS = ['#f2cf3a', '#7ec3f0', '#f0a0c5'];
export const MEMO_COLOR = '#3fae5a';   // 暗記マーカー（緑）
export const SHEET_COLOR = '#d84a3a';  // 赤シートで隠したときの色
export const SIZES = {
  pen: [0.0018, 0.0032, 0.0058],
  marker: [0.014, 0.022, 0.034],
};

export const drawState = {
  tool: 'hand', // hand | pen | marker | memo | eraser
  penColor: PEN_COLORS[0], penSize: 1,
  markerColor: MARKER_COLORS[0], markerSize: 1,
  memoSize: 1,
  sheetMode: false,
  fingerDraw: true,  // 指でも描くか（Apple Pencil 検出で自動 OFF）
  penSeen: false,
};

let cur = null;  // { bookId, pageNo, list, ctx, w, h, undo, redo }
let live = null; // 描画中: { stroke } / 消しゴム中: { erasing:true }
let onChange = null;
export function setOnChange(cb) { onChange = cb; }
function changed() { onChange?.(); }

export const isDrawingTool = () => ['pen', 'marker', 'memo', 'eraser'].includes(drawState.tool);

export function setPage(bookId, pageNo, list, ctx, w, h) {
  cur = { bookId, pageNo, list, ctx, w, h, undo: [], redo: [] };
  if (drawState.sheetMode) for (const s of list) if (s.tool === 'memo') s.hidden = true;
  redraw();
  changed();
}
export function clearPage() { cur = null; live = null; }
export function currentList() { return cur ? cur.list : []; }

function sizeOf(tool) {
  if (tool === 'pen') return SIZES.pen[drawState.penSize];
  if (tool === 'memo') return SIZES.marker[drawState.memoSize];
  return SIZES.marker[drawState.markerSize];
}

// ---- 描画 ----
function strokePath(ctx, s, w, h) {
  const pts = s.pts;
  ctx.beginPath();
  if (pts.length === 1) {
    ctx.moveTo(pts[0][0] * w, pts[0][1] * h);
    ctx.lineTo(pts[0][0] * w + 0.1, pts[0][1] * h);
  } else {
    ctx.moveTo(pts[0][0] * w, pts[0][1] * h);
    for (let i = 1; i < pts.length - 1; i++) {
      const x = pts[i][0] * w, y = pts[i][1] * h;
      const nx = pts[i + 1][0] * w, ny = pts[i + 1][1] * h;
      ctx.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last[0] * w, last[1] * h);
  }
  ctx.stroke();
}

function drawOneStroke(ctx, s, w, h, sheetMode) {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1.2, s.size * w);
  if (s.tool === 'pen') {
    ctx.strokeStyle = s.color;
  } else if (s.tool === 'memo' && sheetMode && s.hidden !== false) {
    // 赤シートで隠れている状態: 下が見えない濃い色で塗る
    ctx.strokeStyle = SHEET_COLOR;
  } else {
    // マーカー類は半透明の乗算で「蛍光ペン」らしく
    ctx.strokeStyle = s.tool === 'memo' ? MEMO_COLOR : s.color;
    ctx.globalAlpha = 0.42;
    ctx.globalCompositeOperation = 'multiply';
  }
  strokePath(ctx, s, w, h);
  ctx.restore();
}

export function drawStatic(ctx, list, w, h, sheetMode) {
  ctx.clearRect(0, 0, w, h);
  for (const s of list) drawOneStroke(ctx, s, w, h, sheetMode);
}

export function redraw() {
  if (!cur) return;
  drawStatic(cur.ctx, cur.list, cur.w, cur.h, drawState.sheetMode);
}

let rafPending = false;
function scheduleRedraw() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; redraw(); });
}

// ---- ストローク入力（reader からページ正規化座標で呼ばれる）----
export function beginStroke(nx, ny) {
  if (!cur) return false;
  const t = drawState.tool;
  if (t === 'eraser') {
    live = { erasing: true };
    eraseAt(nx, ny);
    return true;
  }
  if (t !== 'pen' && t !== 'marker' && t !== 'memo') return false;
  const s = {
    id: uid(), tool: t,
    color: t === 'pen' ? drawState.penColor : t === 'marker' ? drawState.markerColor : MEMO_COLOR,
    size: sizeOf(t),
    pts: [[nx, ny]],
  };
  cur.list.push(s);
  live = { stroke: s };
  scheduleRedraw();
  return true;
}

export function moveStroke(nx, ny) {
  if (!live || !cur) return;
  if (live.erasing) { eraseAt(nx, ny); return; }
  const pts = live.stroke.pts;
  const [lx, ly] = pts[pts.length - 1];
  if (Math.hypot(nx - lx, ny - ly) < 0.0012) return; // 細かすぎる点は間引く
  pts.push([nx, ny]);
  scheduleRedraw();
}

export function endStroke(cancel = false) {
  if (!live || !cur) { live = null; return; }
  if (live.erasing) { live = null; saveSoon(); changed(); return; }
  const s = live.stroke;
  live = null;
  if (cancel) {
    cur.list = cur.list.filter(x => x !== s);
    scheduleRedraw();
    return;
  }
  pushUndo({ type: 'add', stroke: s });
  scheduleRedraw();
  saveSoon();
}

export const isMidStroke = () => !!live;

// ---- 消しゴム（ストローク単位）----
function distToStroke(s, nx, ny, aspect) {
  // aspect = h/w。正規化座標の y 距離を実距離に直すための係数
  const pts = s.pts;
  let min = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const dx = pts[i][0] - nx;
    const dy = (pts[i][1] - ny) * aspect;
    const d = Math.hypot(dx, dy);
    if (d < min) min = d;
    if (i > 0) {
      // 線分との距離も見る（点がまばらな高速ストローク対策）
      const ax = pts[i - 1][0], ay = pts[i - 1][1] * aspect;
      const bx = pts[i][0], by = pts[i][1] * aspect;
      const py = ny * aspect;
      const vx = bx - ax, vy = by - ay;
      const len2 = vx * vx + vy * vy;
      if (len2 > 0) {
        let t = ((nx - ax) * vx + (py - ay) * vy) / len2;
        t = Math.max(0, Math.min(1, t));
        const d2 = Math.hypot(ax + vx * t - nx, ay + vy * t - py);
        if (d2 < min) min = d2;
      }
    }
  }
  return min;
}

function hitStroke(s, nx, ny, margin) {
  if (!cur) return false;
  const aspect = cur.h / cur.w;
  return distToStroke(s, nx, ny, aspect) <= (s.size / 2 + margin);
}

export function eraseAt(nx, ny) {
  if (!cur) return;
  for (let i = cur.list.length - 1; i >= 0; i--) {
    const s = cur.list[i];
    if (hitStroke(s, nx, ny, 0.008)) {
      cur.list.splice(i, 1);
      pushUndo({ type: 'del', stroke: s, index: i });
      scheduleRedraw();
      return;
    }
  }
}

// ---- undo / redo ----
function pushUndo(op) {
  if (!cur) return;
  cur.undo.push(op);
  if (cur.undo.length > 100) cur.undo.shift();
  cur.redo.length = 0;
  changed();
}
export const canUndo = () => !!cur && cur.undo.length > 0;
export const canRedo = () => !!cur && cur.redo.length > 0;

export function undo() {
  if (!canUndo()) return;
  const op = cur.undo.pop();
  if (op.type === 'add') cur.list = cur.list.filter(s => s !== op.stroke);
  else cur.list.splice(Math.min(op.index, cur.list.length), 0, op.stroke);
  cur.redo.push(op);
  scheduleRedraw(); saveSoon(); changed();
}

export function redo() {
  if (!canRedo()) return;
  const op = cur.redo.pop();
  if (op.type === 'add') cur.list.push(op.stroke);
  else cur.list = cur.list.filter(s => s !== op.stroke);
  cur.undo.push(op);
  scheduleRedraw(); saveSoon(); changed();
}

// ---- 保存 ----
async function persist() {
  if (!cur) return;
  const { bookId, pageNo, list } = cur;
  const clean = list.map(({ hidden, ...s }) => s); // 開閉状態は保存しない
  if (clean.length) await Strokes.put({ bookId, pageNo, list: clean });
  else await Strokes.del(bookId, pageNo);
}
const saveSoon = debounce(persist, 400);
export async function saveNow() { await persist(); }

// ---- 赤シート ----
export function setSheetMode(on) {
  drawState.sheetMode = on;
  if (cur) for (const s of cur.list) if (s.tool === 'memo') s.hidden = true; // 入るたび全部隠す
  scheduleRedraw();
  changed();
}

export function setAllHidden(hidden) {
  if (!cur) return;
  for (const s of cur.list) if (s.tool === 'memo') s.hidden = hidden;
  scheduleRedraw();
  changed();
}

// タップで隠す/表示を切り替え。何かに当たったら true
export function sheetTap(nx, ny) {
  if (!cur || !drawState.sheetMode) return false;
  for (let i = cur.list.length - 1; i >= 0; i--) {
    const s = cur.list[i];
    if (s.tool !== 'memo') continue;
    if (hitStroke(s, nx, ny, 0.012)) {
      s.hidden = s.hidden === false;
      scheduleRedraw();
      changed();
      return true;
    }
  }
  return false;
}

export function sheetStats() {
  const list = cur ? cur.list.filter(s => s.tool === 'memo') : [];
  return { total: list.length, hidden: list.filter(s => s.hidden !== false).length };
}
