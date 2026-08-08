// 共通ユーティリティ（DOM・文字処理・モーダル・トースト）
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(1) : String(Math.round(n))) + ' ' + u[i];
}

export function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export const SUBJECTS = [
  { id: 'eigo', name: '英語', color: '#3567d6' },
  { id: 'sugaku', name: '数学', color: '#2f9e63' },
  { id: 'kokugo', name: '国語', color: '#d0563b' },
  { id: 'rika', name: '理科', color: '#8a5bd6' },
  { id: 'shakai', name: '社会', color: '#d09a2b' },
  { id: 'sonota', name: 'その他', color: '#6b7686' },
];
export const subjectOf = id => SUBJECTS.find(s => s.id === id) || SUBJECTS[SUBJECTS.length - 1];

// ---- テキスト正規化 ----
// 保存時: NFKC + 日本語文字間の余計な空白除去 + 空白圧縮（OCR の分かち書き対策）
const CJK = '[\\u3000-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff]';
const CJK_SPACE_RE = new RegExp(`(${CJK})[ \\t]+(?=${CJK})`, 'g');
export function cleanText(s) {
  let t = String(s || '').normalize('NFKC');
  let prev;
  do { prev = t; t = t.replace(CJK_SPACE_RE, '$1'); } while (t !== prev);
  return t.replace(/[\s　]+/g, ' ').trim();
}
// 検索時: 小文字化 + カタカナ→ひらがな（1文字→1文字なので位置がズレない）
export function foldText(s) {
  return String(s || '').toLowerCase()
    .replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

// ---- トースト ----
let toastTimer = null;
export function toast(msg, ms = 2400) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => { t.hidden = true; }, 250);
  }, ms);
}

// ---- モーダル ----
export function openModal(html, opts = {}) {
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-back"></div><div class="modal-box" role="dialog">${html}</div>`;
  root.hidden = false;
  document.body.classList.add('modal-open');
  if (!opts.sticky) root.firstElementChild.addEventListener('click', () => closeModal());
  return root.lastElementChild;
}

export function closeModal() {
  const root = $('#modalRoot');
  if (!root) return;
  root.hidden = true;
  root.innerHTML = '';
  document.body.classList.remove('modal-open');
}

export function confirmDlg(msgHtml, { ok = 'OK', cancel = 'キャンセル', danger = false } = {}) {
  return new Promise(res => {
    const box = openModal(
      `<div class="modal-msg">${msgHtml}</div>
       <div class="modal-btns">
         <button class="btn ghost" data-x>${escapeHtml(cancel)}</button>
         <button class="btn ${danger ? 'danger' : 'prime'}" data-ok>${escapeHtml(ok)}</button>
       </div>`,
      { sticky: true });
    box.querySelector('[data-x]').onclick = () => { closeModal(); res(false); };
    box.querySelector('[data-ok]').onclick = () => { closeModal(); res(true); };
  });
}
