// ページの書き出し: 書きこみ込みのPDFを作って、共有シート（Goodnotes など）へ渡す
import { Images, Strokes } from './db.js';
import { drawStatic } from './draw.js';

const MAX_LONG = 2000; // 書き出し画像の長辺(px)

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした')); };
    img.src = url;
  });
}

// 1ページ分: ページ画像 + 書きこみ を合成した JPEG を返す
async function renderPage(bookId, pageNo) {
  const rec = await Images.get(bookId, pageNo);
  if (!rec?.blob) throw new Error(`${pageNo}ページの画像が見つかりません`);
  const img = await loadImage(rec.blob);
  const k = Math.min(1, MAX_LONG / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const st = await Strokes.get(bookId, pageNo);
  if (st?.list?.length) {
    // 書きこみは別レイヤーに描いてから重ねる（マーカーの乗算が白地で正しく効くように）
    const layer = document.createElement('canvas');
    layer.width = w; layer.height = h;
    drawStatic(layer.getContext('2d'), st.list, w, h, false);
    ctx.drawImage(layer, 0, 0);
  }
  const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.9));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  cv.width = cv.height = 0;
  return { bytes, w, h };
}

// JPEG を並べただけの最小PDFを作る（外部ライブラリなし）
function buildPdf(pages) {
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let len = 0;
  const push = d => { const u = typeof d === 'string' ? enc.encode(d) : d; parts.push(u); len += u.length; };
  const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n`); push(body); push('\nendobj\n'); };

  push('%PDF-1.4\n');
  const n = pages.length;
  // 1=Catalog 2=Pages  以降 ページごとに 3つ（Page / Image / Contents）
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  pages.forEach((p, i) => {
    const pg = 3 + i * 3, im = pg + 1, ct = pg + 2;
    // 長辺を 842pt（A4相当）に収める
    const s = 842 / Math.max(p.w, p.h);
    const pw = +(p.w * s).toFixed(2), ph = +(p.h * s).toFixed(2);
    obj(pg, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${ct} 0 R >>`);
    offsets[im] = len;
    push(`${im} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>\nstream\n`);
    push(p.bytes);
    push('\nendstream\nendobj\n');
    const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
    obj(ct, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  const total = 3 + n * 3;
  const xref = len;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let i = 1; i < total; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return new Blob(parts, { type: 'application/pdf' });
}

// from..to ページ（含む）を書きこみ込みのPDFにする
export async function makePdf(bookId, from, to, onProgress) {
  const pages = [];
  for (let p = from; p <= to; p++) {
    pages.push(await renderPage(bookId, p));
    onProgress?.(p - from + 1, to - from + 1);
  }
  return buildPdf(pages);
}

export const canShareFiles = file =>
  typeof navigator.share === 'function' && !!navigator.canShare?.({ files: [file] });
