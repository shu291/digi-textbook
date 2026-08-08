// 本棚・PDF取り込み・全体検索・設定・バックアップ・OCR進捗バー
import { openDb, Books, Pages, Strokes, Prefs } from './db.js';
import { importPdf, appendPdf, rotateBook, makePdfPreview } from './importer.js';
import { startOcr, cancelOcr, ocrJob, searchAll, ocrStatus } from './ocr.js';
import { initReader, openBook, openBookForMiss } from './reader.js';
import { drawState } from './draw.js';
import {
  bookMissNotes, dueMissNotes, getMissNote, deleteMissOfBook, noteCropUrl,
  INTERVALS, daysUntil, today, startOfDay,
} from './misslink.js';
import {
  $, $$, SUBJECTS, subjectOf, escapeHtml, fmtBytes, toast, clamp,
  openModal, closeModal, confirmDlg, downloadBlob,
} from './util.js';

const coverUrls = new Map(); // bookId -> objectURL

// ============================================================ 起動
async function init() {
  await openDb();
  drawState.fingerDraw = await Prefs.get('fingerDraw', true);
  drawState.penSeen = await Prefs.get('penSeen', false);
  initReader();
  bindShelf();
  await renderShelf();
  ocrJob.onUpdate = updateOcrBar;
  window.addEventListener('shelf-refresh', () => renderShelf());
  window.addEventListener('rotate-request', async e => {
    const book = await Books.get(e.detail);
    if (book) rotateFlow(book);
  });
  window.addEventListener('miss-refresh', () => {
    if (currentView === 'miss') renderMissView();
    else refreshMissBadge();
  });
  $$('.view-tabs .vt').forEach(b => { b.onclick = () => switchView(b.dataset.view); });
  refreshMissBadge();

  // ミスノートからのリンク (#miss=id) で該当問題に直行
  if (location.hash.startsWith('#miss=')) {
    const id = decodeURIComponent(location.hash.slice(6));
    history.replaceState(null, '', location.pathname + location.search);
    try {
      const note = await getMissNote(id);
      if (note?.ref) openBookForMiss(note);
    } catch { /* 無効なリンクは無視 */ }
  }
  try { await navigator.storage?.persist?.(); } catch { /* 対応外ブラウザ */ }
  // 本番(https)では常に有効。localhost開発中は ?sw を付けたときだけ
  const swWanted = location.protocol === 'https:' ||
    (['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).has('sw'));
  if ('serviceWorker' in navigator && swWanted) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

// ============================================================ 本棚 / ミス復習 タブ
let currentView = 'shelf';

function switchView(v) {
  currentView = v;
  $$('.view-tabs .vt').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  const missOn = v === 'miss';
  $('#missView').hidden = !missOn;
  $('#searchResults').hidden = true;
  $('#bookGrid').hidden = missOn;
  $('.shelf-search').style.visibility = missOn ? 'hidden' : '';
  if (missOn) renderMissView();
  else if ($('#globalSearch').value.trim()) runGlobalSearch();
}

function updateMissBadge(count) {
  const b = $('#missBadge');
  if (!b) return;
  b.hidden = !count;
  b.textContent = count;
}

async function refreshMissBadge() {
  try { updateMissBadge((await dueMissNotes()).length); } catch { /* 連携なしでも動く */ }
}

const dueLabel = n => {
  if (n.mastered) return '🎉';
  const d = daysUntil(n.dueAt);
  return d < 0 ? `${-d}日おくれ` : d === 0 ? 'きょう' : d === 1 ? 'あした' : `${d}日後`;
};

async function renderMissView() {
  const wrap = $('#missView');
  let all = [];
  try { all = await bookMissNotes(); } catch { /* DBなし */ }
  if (!all.length) {
    wrap.innerHTML = `
      <div class="shelf-empty">
        <h2>まちがえた問題がここに戻ってくる</h2>
        <p>教科書を開いて、まちがえた問題を <b>✗ボタン → 四角く囲んで登録</b>。<br>
        1→3→7→16→35日の間隔で、ここに復習として出てきます。</p>
      </div>`;
    updateMissBadge(0);
    return;
  }
  const t = today();
  const due = [], later = [], done = [];
  for (const n of all) {
    if (n.mastered) done.push(n);
    else if (startOfDay(n.dueAt) <= t) due.push(n);
    else later.push(n);
  }
  due.sort((a, b) => a.dueAt - b.dueAt || a.createdAt - b.createdAt);
  later.sort((a, b) => a.dueAt - b.dueAt);
  done.sort((a, b) => b.createdAt - a.createdAt);

  const card = n => `
    <button class="miss-card ${n.mastered ? 'done' : ''}" data-id="${n.id}">
      <span class="mc-img"><img alt=""></span>
      <span class="mc-body">
        <span class="mc-title">${escapeHtml(n.ref.bookTitle)}</span>
        <span class="mc-meta">
          <span class="mc-dots">${INTERVALS.map((_, i) => `<i class="${i < n.step ? 'on' : ''}"></i>`).join('')}</span>
          ${n.cause && n.cause !== '未分類' ? `<span class="mc-tag">${escapeHtml(n.cause)}</span>` : ''}
          <span class="mc-due">${dueLabel(n)}</span>
        </span>
      </span>
    </button>`;

  wrap.innerHTML = `
    <section class="miss-sec">
      <h2>きょうの復習 <span class="miss-count">${due.length}問</span></h2>
      ${due.length ? due.map(card).join('') : '<p class="miss-empty">きょうの分はぜんぶ終わり！えらい！</p>'}
    </section>
    ${later.length ? `<section class="miss-sec"><h2>これから</h2>${later.map(card).join('')}</section>` : ''}
    ${done.length ? `<section class="miss-sec"><h2>定着ずみ <span class="miss-count">${done.length}問</span></h2>${done.map(card).join('')}</section>` : ''}
    <p class="modal-note" style="text-align:center">タップすると教科書のその問題に飛んで、解き直し→判定ができます</p>`;

  $$('.miss-card', wrap).forEach(c => {
    c.onclick = () => {
      const note = all.find(n => n.id === c.dataset.id);
      if (note) openBookForMiss(note);
    };
  });
  updateMissBadge(due.length);
  // サムネは非同期で流し込む（教科書の画像からその場で切り抜き）
  for (const n of all) {
    const img = wrap.querySelector(`.miss-card[data-id="${n.id}"] img`);
    if (!img) continue;
    noteCropUrl(n).then(u => { if (u && img.isConnected) img.src = u; });
  }
}

// ============================================================ 本棚
async function renderShelf() {
  const grid = $('#bookGrid');
  const books = (await Books.all()).sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));

  for (const [id, u] of [...coverUrls]) {
    if (!books.find(b => b.id === id)) { URL.revokeObjectURL(u); coverUrls.delete(id); }
  }

  if (!books.length) {
    grid.innerHTML = `
      <div class="shelf-empty">
        <svg viewBox="0 0 128 128" width="96" height="96" aria-hidden="true">
          <path d="M22 42 Q42 33 62 42 L62 95 Q42 86 22 95 Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>
          <path d="M106 42 Q86 33 66 42 L66 95 Q86 86 106 95 Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>
          <path d="M88 14 h16 v26 l-8 -8 l-8 8 Z" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linejoin="round"/>
        </svg>
        <h2>スキャンした教科書をここに</h2>
        <p>右下の <b>＋</b> ボタンから教科書のPDFを追加してね。<br>
        データは<b>この端末の中だけ</b>に保存されて、外には送られません。</p>
      </div>`;
    return;
  }

  grid.innerHTML = books.map(b => {
    const sub = subjectOf(b.subject);
    return `
    <article class="book-card" data-id="${b.id}" style="--sc:${sub.color}">
      <button class="book-open" aria-label="${escapeHtml(b.title)} をひらく">
        <span class="book-cover"><img alt=""><span class="book-spine"></span></span>
        <span class="book-title">${escapeHtml(b.title)}</span>
        <span class="book-sub">
          <span class="subject-chip">${sub.name}</span>
          <span>${b.pageCount}p</span>
          ${b.lastPage > 1 ? `<span>つづき p.${b.lastPage}</span>` : ''}
        </span>
      </button>
      <button class="book-menu icon-btn" aria-label="メニュー">
        <svg viewBox="0 0 24 24" width="18" height="18"><circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/></svg>
      </button>
    </article>`;
  }).join('');

  for (const b of books) {
    const img = $(`.book-card[data-id="${b.id}"] img`);
    if (img && b.cover) {
      if (!coverUrls.has(b.id)) coverUrls.set(b.id, URL.createObjectURL(b.cover));
      img.src = coverUrls.get(b.id);
    }
  }
  $$('.book-open', grid).forEach(btn => {
    btn.onclick = async () => {
      const id = btn.closest('.book-card').dataset.id;
      const book = await Books.get(id);
      if (book?.rotatePending) { resumeRotateDialog(book); return; } // 回転が途中の本は先に再開
      openBook(id);
    };
  });
  $$('.book-menu', grid).forEach(btn => {
    btn.onclick = async e => {
      e.stopPropagation();
      const book = await Books.get(btn.closest('.book-card').dataset.id);
      if (book) openBookMenu(book);
    };
  });
}

function bindShelf() {
  $('#addBtn').onclick = () => $('#pdfInput').click();
  $('#pdfInput').onchange = e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) startImportFlow(f);
  };
  $('#settingsBtn').onclick = openSettings;

  const gs = $('#globalSearch');
  let timer = null;
  gs.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(runGlobalSearch, 400); });
  gs.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(timer); runGlobalSearch(); } });
  gs.addEventListener('search', runGlobalSearch); // ✕で消したとき
}

// ============================================================ PDF 取り込み
function startImportFlow(file) {
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    toast('PDFファイルを選んでね');
    return;
  }
  const defTitle = file.name.replace(/\.pdf$/i, '');
  const box = openModal(`
    <h3 class="modal-title">教科書を追加</h3>
    <label class="field"><span>タイトル</span>
      <input id="impTitle" value="${escapeHtml(defTitle)}" maxlength="60">
    </label>
    <div class="field"><span>教科</span>
      <div class="subject-picker">${SUBJECTS.map((s, i) =>
        `<button class="subject-opt ${i === SUBJECTS.length - 1 ? 'active' : ''}" data-id="${s.id}" style="--sc:${s.color}">${s.name}</button>`
      ).join('')}</div>
    </div>
    <p class="modal-note">サイズ: ${fmtBytes(file.size)}。ページを画像にしてこの端末に保存します。</p>
    <div class="modal-btns">
      <button class="btn ghost" data-x>キャンセル</button>
      <button class="btn prime" data-ok>取り込む</button>
    </div>`, { sticky: true });

  let subject = SUBJECTS[SUBJECTS.length - 1].id;
  $$('.subject-opt', box).forEach(btn => {
    btn.onclick = () => {
      subject = btn.dataset.id;
      $$('.subject-opt', box).forEach(b => b.classList.toggle('active', b === btn));
    };
  });
  box.querySelector('[data-x]').onclick = closeModal;
  box.querySelector('[data-ok]').onclick = async () => {
    const title = box.querySelector('#impTitle').value.trim() || defTitle;
    let cancelled = false;
    box.innerHTML = `
      <h3 class="modal-title">取り込み中…</h3>
      <p class="imp-status" id="impStatus">PDFを読み込んでいます</p>
      <progress id="impProg" class="wide-prog" max="1" value="0"></progress>
      <div class="modal-btns"><button class="btn ghost" id="impCancel">中止</button></div>`;
    box.querySelector('#impCancel').onclick = () => {
      cancelled = true;
      box.querySelector('#impStatus').textContent = '中止しています…';
    };
    try {
      const book = await importPdf(file, { title, subject }, {
        onProgress: (done, total) => {
          const prog = box.querySelector('#impProg');
          const st = box.querySelector('#impStatus');
          if (prog) { prog.max = total; prog.value = done; }
          if (st) st.textContent = `${done} / ${total} ページ`;
        },
        isCancelled: () => cancelled,
      });
      closeModal();
      if (book) {
        await renderShelf();
        toast(`「${book.title}」を追加しました（${book.pageCount}ページ）`);
        if (!book.hasTextLayer) {
          const doOcr = await confirmDlg(
            `このPDFには文字データがありません。<br>検索を使うには<b>文字認識（OCR）</b>が必要です。<br><small>今すぐ始めますか？（読みながらでも裏で進みます）</small>`,
            { ok: '今すぐ始める', cancel: 'あとで' });
          if (doOcr) startOcr(book).catch(e => toast(e.message));
        }
      } else {
        toast('取り込みを中止しました');
      }
    } catch (err) {
      console.error(err);
      box.innerHTML = `
        <h3 class="modal-title">取り込めませんでした</h3>
        <p class="modal-msg">このPDFは読み込めなかったよ。<br><small>${escapeHtml(err?.message || String(err))}</small></p>
        <div class="modal-btns"><button class="btn prime" data-x>閉じる</button></div>`;
      box.querySelector('[data-x]').onclick = closeModal;
    }
  };
}

// ============================================================ 本のメニュー
async function openBookMenu(book) {
  if (book.rotatePending) { resumeRotateDialog(book); return; } // 回転が途中なら先に再開
  const st = await ocrStatus(book.id);
  const box = openModal(`
    <h3 class="modal-title">${escapeHtml(book.title)}</h3>
    <div class="menu-list">
      <button class="menu-item" id="bmOpen"><span>ひらく</span></button>
      <button class="menu-item" id="bmAppend">
        <span>あとからページを追加</span>
        <small>続きのスキャンPDFをこの本の後ろにつなげます</small>
      </button>
      <button class="menu-item" id="bmEdit"><span>名前・教科を変える</span></button>
      <button class="menu-item" id="bmOcr" ${ocrJob.running ? 'disabled' : ''}>
        <span>文字認識（OCR）を実行</span>
        <small>文字データ ${st.withText} / ${st.total} ページ${ocrJob.running ? '・実行中…' : ''}</small>
      </button>
      <button class="menu-item" id="bmRotate">
        <span>ページの向きを回転</span>
        <small>全${book.pageCount}ページと書き込みをまとめて回します</small>
      </button>
      <button class="menu-item danger" id="bmDel"><span>削除する</span></button>
    </div>
    <div class="modal-btns"><button class="btn ghost" data-x>閉じる</button></div>`);
  box.querySelector('[data-x]').onclick = closeModal;
  box.querySelector('#bmOpen').onclick = () => { closeModal(); openBook(book.id); };
  box.querySelector('#bmAppend').onclick = () => { closeModal(); appendFlow(book); };
  box.querySelector('#bmEdit').onclick = () => { closeModal(); editBookDialog(book); };
  box.querySelector('#bmRotate').onclick = () => { closeModal(); rotateFlow(book); };
  box.querySelector('#bmOcr').onclick = () => {
    closeModal();
    startOcr(book).catch(e => toast(e.message));
  };
  box.querySelector('#bmDel').onclick = async () => {
    closeModal();
    let missCount = 0;
    try { missCount = (await bookMissNotes(book.id)).length; } catch { /* 連携なし */ }
    const extra = missCount ? `<br><small>ミスノートに登録した ${missCount}問もいっしょに消えます</small>` : '';
    const ok = await confirmDlg(
      `「${escapeHtml(book.title)}」を削除する？<br><small>ページも書き込みもぜんぶ消えて、元に戻せません</small>${extra}`,
      { ok: '削除する', danger: true });
    if (!ok) return;
    await Books.remove(book.id);
    if (missCount) await deleteMissOfBook(book.id);
    await renderShelf();
    refreshMissBadge();
    toast('削除しました');
  };
}

function editBookDialog(book) {
  const box = openModal(`
    <h3 class="modal-title">名前・教科を変える</h3>
    <label class="field"><span>タイトル</span>
      <input id="edTitle" value="${escapeHtml(book.title)}" maxlength="60">
    </label>
    <div class="field"><span>教科</span>
      <div class="subject-picker">${SUBJECTS.map(s =>
        `<button class="subject-opt ${s.id === book.subject ? 'active' : ''}" data-id="${s.id}" style="--sc:${s.color}">${s.name}</button>`
      ).join('')}</div>
    </div>
    <div class="modal-btns">
      <button class="btn ghost" data-x>キャンセル</button>
      <button class="btn prime" data-ok>保存</button>
    </div>`, { sticky: true });
  let subject = book.subject;
  $$('.subject-opt', box).forEach(btn => {
    btn.onclick = () => {
      subject = btn.dataset.id;
      $$('.subject-opt', box).forEach(b => b.classList.toggle('active', b === btn));
    };
  });
  box.querySelector('[data-x]').onclick = closeModal;
  box.querySelector('[data-ok]').onclick = async () => {
    book.title = box.querySelector('#edTitle').value.trim() || book.title;
    book.subject = subject;
    await Books.put(book);
    closeModal();
    await renderShelf();
    toast('保存しました');
  };
}

// ============================================================ あとからページを追加
function appendFlow(book) {
  if (ocrJob.running && ocrJob.bookId === book.id) {
    toast('文字認識が終わってから追加してね');
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/pdf,.pdf';
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      toast('PDFファイルを選んでね');
      return;
    }
    confirmAppend(book, file);
  };
  input.click();
}

function confirmAppend(book, file) {
  let deg = 0;
  let previewUrl = '';
  let closed = false;
  const box = openModal(`
    <h3 class="modal-title">あとからページを追加</h3>
    <div class="rot-stage">
      <img id="appPreview" alt="追加するPDFの1ページ目" hidden>
      <span id="appPrevLoading" class="prev-loading">プレビューを準備中…</span>
    </div>
    <div class="rot-ctrl">
      <button class="btn ghost" id="appRotL">⟲ 左に90°</button>
      <button class="btn ghost" id="appRotR">⟳ 右に90°</button>
    </div>
    <p class="modal-msg" style="margin-top:12px">「${escapeHtml(book.title)}」（いま ${book.pageCount}ページ）の後ろに
      <b>${escapeHtml(file.name)}</b>（${fmtBytes(file.size)}）のページをつなげます。<br>
      <small>プレビューの向きが本と違うときは、上のボタンで合わせてから追加してね。<br>書き込み・しおり・目次はそのまま残ります</small></p>
    <div class="modal-btns">
      <button class="btn ghost" data-x>キャンセル</button>
      <button class="btn prime" data-ok>この向きで追加</button>
    </div>`, { sticky: true });
  const img = box.querySelector('#appPreview');
  makePdfPreview(file).then(res => {
    if (closed) { URL.revokeObjectURL(res.url); return; }
    previewUrl = res.url;
    img.src = previewUrl;
    img.style.transform = `rotate(${deg}deg)`;
    img.hidden = false;
    box.querySelector('#appPrevLoading')?.remove();
  }).catch(() => {
    const l = box.querySelector('#appPrevLoading');
    if (l) l.textContent = 'プレビューを作れませんでした（そのまま追加はできます）';
  });
  const update = () => { img.style.transform = `rotate(${deg}deg)`; };
  box.querySelector('#appRotL').onclick = () => { deg -= 90; update(); };
  box.querySelector('#appRotR').onclick = () => { deg += 90; update(); };
  box.querySelector('[data-x]').onclick = () => {
    closed = true;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    closeModal();
  };
  box.querySelector('[data-ok]').onclick = async () => {
    closed = true;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const quarterTurns = (((deg / 90) % 4) + 4) % 4;
    let cancelled = false;
    box.innerHTML = `
      <h3 class="modal-title">追加中…</h3>
      <p class="imp-status" id="appStatus">PDFを読み込んでいます</p>
      <progress id="appProg" class="wide-prog" max="1" value="0"></progress>
      <div class="modal-btns"><button class="btn ghost" id="appCancel">中止</button></div>`;
    box.querySelector('#appCancel').onclick = () => {
      cancelled = true;
      box.querySelector('#appStatus').textContent = '中止しています…';
    };
    try {
      const res = await appendPdf(book, file, {
        quarterTurns,
        onProgress: (done, total) => {
          const prog = box.querySelector('#appProg');
          const st = box.querySelector('#appStatus');
          if (prog) { prog.max = total; prog.value = done; }
          if (st) st.textContent = `${done} / ${total} ページ`;
        },
        isCancelled: () => cancelled,
      });
      closeModal();
      if (res) {
        await renderShelf();
        toast(`${res.added}ページ追加 → 全${res.pageCount}ページになりました`);
        if (res.textPages < res.added / 2) {
          const doOcr = await confirmDlg(
            `追加したページには文字データがありません。<br>検索も使うなら<b>文字認識（OCR）</b>をどうぞ。<br><small>足りないページだけ認識します（読みながらでも裏で進みます）</small>`,
            { ok: '今すぐ始める', cancel: 'あとで' });
          if (doOcr) startOcr(book).catch(e => toast(e.message));
        }
      } else {
        toast('追加を中止しました（本は元のままです）');
      }
    } catch (err) {
      console.error(err);
      box.innerHTML = `
        <h3 class="modal-title">追加できませんでした</h3>
        <p class="modal-msg">このPDFは読み込めなかったよ。本は元のままです。<br><small>${escapeHtml(err?.message || String(err))}</small></p>
        <div class="modal-btns"><button class="btn prime" data-x>閉じる</button></div>`;
      box.querySelector('[data-x]').onclick = closeModal;
    }
  };
}

// ============================================================ ページの向きを回転
function rotateFlow(book) {
  if (book.rotatePending) { resumeRotateDialog(book); return; }
  if (ocrJob.running && ocrJob.bookId === book.id) {
    toast('文字認識が終わってから回してね');
    return;
  }
  let deg = 0;
  let rangeMode = 'all';
  let previewUrl = '';
  const box = openModal(`
    <h3 class="modal-title">ページの向きを回転</h3>
    <div class="rot-stage"><img id="rotPreview" alt="プレビュー"></div>
    <div class="rot-ctrl">
      <button class="btn ghost" id="rotL">⟲ 左に90°</button>
      <button class="btn ghost" id="rotR">⟳ 右に90°</button>
    </div>
    <div class="field" style="margin:14px 0 0"><span>回すページ</span>
      <div class="subject-picker">
        <button class="subject-opt active" id="rangeAll" style="--sc:#2c4a85">ぜんぶ（1〜${book.pageCount}）</button>
        <button class="subject-opt" id="rangePart" style="--sc:#2c4a85">一部だけ</button>
      </div>
      <div class="rot-range" id="rotRangeRow" hidden>
        <input type="number" class="num-in" id="rotFrom" min="1" max="${book.pageCount}" value="1">
        <span>〜</span>
        <input type="number" class="num-in" id="rotTo" min="1" max="${book.pageCount}" value="${book.pageCount}">
        <span>ページ</span>
      </div>
    </div>
    <p class="modal-note">あとから追加した分だけ向きが違うときは「一部だけ」で<br>そのページ範囲だけ回せます（プレビューは範囲の最初のページ）。</p>
    <div class="modal-btns">
      <button class="btn ghost" data-x>キャンセル</button>
      <button class="btn prime" data-ok disabled>この向きで保存</button>
    </div>`, { sticky: true });

  const img = box.querySelector('#rotPreview');
  const okBtn = box.querySelector('[data-ok]');
  const fromIn = box.querySelector('#rotFrom');
  const toIn = box.querySelector('#rotTo');

  const getRange = () => {
    if (rangeMode === 'all') return { from: 1, to: book.pageCount };
    const f = clamp(Math.floor(+fromIn.value || 1), 1, book.pageCount);
    const t = clamp(Math.floor(+toIn.value || book.pageCount), 1, book.pageCount);
    return f <= t ? { from: f, to: t } : { from: t, to: f };
  };
  const updateBtns = () => {
    img.style.transform = `rotate(${deg}deg)`;
    okBtn.disabled = ((deg % 360) + 360) % 360 === 0;
  };
  const setPreview = async () => {
    const { from } = getRange();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = '';
    if (from === 1 && book.cover) {
      previewUrl = URL.createObjectURL(book.cover);
    } else {
      const p = await Pages.get(book.id, from);
      if (p?.thumb) previewUrl = URL.createObjectURL(p.thumb);
    }
    img.src = previewUrl;
  };
  setPreview();
  updateBtns();

  box.querySelector('#rotL').onclick = () => { deg -= 90; updateBtns(); };
  box.querySelector('#rotR').onclick = () => { deg += 90; updateBtns(); };
  const setRangeMode = mode => {
    rangeMode = mode;
    box.querySelector('#rangeAll').classList.toggle('active', mode === 'all');
    box.querySelector('#rangePart').classList.toggle('active', mode === 'part');
    box.querySelector('#rotRangeRow').hidden = mode === 'all';
    setPreview();
  };
  box.querySelector('#rangeAll').onclick = () => setRangeMode('all');
  box.querySelector('#rangePart').onclick = () => setRangeMode('part');
  fromIn.onchange = setPreview;
  toIn.onchange = setPreview;

  box.querySelector('[data-x]').onclick = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    closeModal();
  };
  okBtn.onclick = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    runRotate(book, (((deg / 90) % 4) + 4) % 4, getRange());
  };
}

function resumeRotateDialog(book) {
  const p = book.rotatePending;
  const from = p.from ?? 1;
  const to = p.to ?? book.pageCount;
  const rangeTxt = (from === 1 && to === book.pageCount) ? '' : `（p.${from}〜p.${to}）`;
  const box = openModal(`
    <h3 class="modal-title">回転が途中で止まっています</h3>
    <p class="modal-msg">「${escapeHtml(book.title)}」の向きの変更${rangeTxt}が ${Math.max(0, p.done - from + 1)} / ${to - from + 1} ページで止まっています。<br><small>先に再開して終わらせてから開いてね</small></p>
    <div class="modal-btns">
      <button class="btn ghost" data-x>あとで</button>
      <button class="btn prime" data-ok>つづきから再開</button>
    </div>`, { sticky: true });
  box.querySelector('[data-x]').onclick = closeModal;
  box.querySelector('[data-ok]').onclick = () => runRotate(book, p.turns, { from, to });
}

async function runRotate(book, turns, range = {}) {
  const box = openModal(`
    <h3 class="modal-title">回転中…</h3>
    <p class="imp-status" id="rotStatus">準備しています</p>
    <progress id="rotProg" class="wide-prog" max="1" value="0"></progress>
    <p class="modal-note">この画面のまま少し待っててね（とじると途中で止まるけど、あとで続きから再開できます）</p>`,
    { sticky: true });
  try {
    await rotateBook(book, turns, {
      ...range,
      onProgress: (done, total) => {
        const prog = box.querySelector('#rotProg');
        const st = box.querySelector('#rotStatus');
        if (prog) { prog.max = total; prog.value = done; }
        if (st) st.textContent = `${done} / ${total} ページ`;
      },
    });
    closeModal();
    await renderShelf();
    toast('回転が終わりました！');
    const st = await ocrStatus(book.id);
    if (!book.hasTextLayer && st.withText > 0) {
      const redo = await confirmDlg(
        `向きが変わったので、文字認識（OCR）をやり直すと検索が正確になります。<br><small>今やっておく？（読みながらでも裏で進みます）</small>`,
        { ok: 'やり直す', cancel: 'あとで' });
      if (redo) startOcr(book, { force: true }).catch(e => toast(e.message));
    }
  } catch (err) {
    console.error(err);
    closeModal();
    await renderShelf();
    openModal(`
      <h3 class="modal-title">途中で止まりました</h3>
      <p class="modal-msg">回転の途中でエラーが起きました。<br>本を開こうとすると「つづきから再開」できます。<br><small>${escapeHtml(err?.message || String(err))}</small></p>
      <div class="modal-btns"><button class="btn prime" data-x>閉じる</button></div>`)
      .querySelector('[data-x]').onclick = closeModal;
  }
}

// ============================================================ 全体検索
async function runGlobalSearch() {
  const q = $('#globalSearch').value.trim();
  const wrap = $('#searchResults');
  const grid = $('#bookGrid');
  if (!q) {
    wrap.hidden = true;
    grid.hidden = false;
    return;
  }
  const books = await Books.all();
  const results = await searchAll(books, q);
  grid.hidden = true;
  wrap.hidden = false;

  if (!results.length) {
    wrap.innerHTML = `
      <p class="panel-empty">「${escapeHtml(q)}」は見つかりませんでした</p>
      <p class="search-note">※ 文字認識（OCR）がまだの教科書は検索にでてきません。<br>本の ⋯ メニューから実行できます。</p>`;
    return;
  }
  wrap.innerHTML = results.map(r => {
    const sub = subjectOf(r.book.subject);
    return `
    <div class="gs-group" style="--sc:${sub.color}">
      <div class="gs-book"><span class="subject-chip">${sub.name}</span>${escapeHtml(r.book.title)}</div>
      <ul class="hit-list">${r.hits.map(h => `
        <li><button class="hit-jump" data-book="${r.book.id}" data-page="${h.pageNo}">
          <span class="hit-page">p.${h.pageNo}<em>${h.count}件</em></span>
          ${h.snippets.map(s =>
            `<span class="hit-snip">${escapeHtml(s.pre)}<mark>${escapeHtml(s.match)}</mark>${escapeHtml(s.post)}</span>`
          ).join('')}
        </button></li>`).join('')}
      </ul>
    </div>`;
  }).join('');
  $$('.hit-jump', wrap).forEach(btn => {
    btn.onclick = () => openBook(btn.dataset.book, +btn.dataset.page);
  });
}

// ============================================================ 設定
async function openSettings() {
  let est = {};
  let persisted = false;
  try { est = await navigator.storage.estimate(); } catch { /* 未対応 */ }
  try { persisted = await navigator.storage.persisted(); } catch { /* 未対応 */ }
  const books = await Books.all();
  const pct = est.quota ? Math.min(100, Math.round((est.usage / est.quota) * 100)) : 0;

  const box = openModal(`
    <h3 class="modal-title">設定</h3>
    <div class="setting-card">
      <div class="setting-row"><b>保存領域</b><span>${fmtBytes(est.usage)} / ${fmtBytes(est.quota)}</span></div>
      <div class="quota-bar"><span style="width:${pct}%"></span></div>
      <div class="setting-row">
        <span>${persisted ? '✅ データは保護されています' : '⚠️ 容量ひっ迫時に消される可能性があります'}</span>
        ${persisted ? '' : '<button class="mini-btn" id="stPersist">保護する</button>'}
      </div>
    </div>
    <label class="setting-card setting-toggle">
      <span><b>指で描く</b><br><small>OFF = Apple Pencil専用（指はスクロール）</small></span>
      <input type="checkbox" id="stFinger" ${drawState.fingerDraw ? 'checked' : ''}>
    </label>
    <div class="setting-card">
      <b>書き込みのバックアップ</b>
      <p><small>書き込み・目次・しおり・文字データをファイルに保存できます（ページ画像はふくまれません。復元は同じPDFを取り込んでから）</small></p>
      <div class="modal-btns left">
        <button class="btn ghost" id="stExport">書き出す</button>
        <button class="btn ghost" id="stImport">読み込む</button>
        <input type="file" id="stImportFile" accept="application/json,.json" hidden>
      </div>
    </div>
    <p class="modal-note">じぶん教科書 v1.5 ・ 教科書 ${books.length}冊<br>データはこの端末の中だけに保存されます</p>
    <div class="modal-btns"><button class="btn prime" data-x>閉じる</button></div>`);
  box.querySelector('[data-x]').onclick = closeModal;
  box.querySelector('#stPersist')?.addEventListener('click', async () => {
    const ok = await navigator.storage.persist();
    toast(ok ? 'データを保護しました' : 'ブラウザに断られました…（使い続けると自動で保護されます）');
  });
  box.querySelector('#stFinger').onchange = e => {
    drawState.fingerDraw = e.target.checked;
    Prefs.set('fingerDraw', drawState.fingerDraw);
  };
  box.querySelector('#stExport').onclick = exportBackup;
  box.querySelector('#stImport').onclick = () => box.querySelector('#stImportFile').click();
  box.querySelector('#stImportFile').onchange = e => {
    const f = e.target.files[0];
    if (f) importBackup(f);
  };
}

async function exportBackup() {
  const books = await Books.all();
  if (!books.length) { toast('まだ教科書がありません'); return; }
  const data = { app: 'digi-textbook', version: 1, exportedAt: new Date().toISOString(), books: [] };
  for (const b of books) {
    const strokes = await Strokes.byBook(b.id);
    const pages = await Pages.byBook(b.id);
    data.books.push({
      title: b.title, subject: b.subject, pageCount: b.pageCount,
      toc: b.toc, bookmarks: b.bookmarks, lastPage: b.lastPage,
      strokes: strokes.map(s => ({ pageNo: s.pageNo, list: s.list })),
      texts: pages.filter(p => p.text).map(p => ({ pageNo: p.pageNo, text: p.text, textSource: p.textSource })),
    });
  }
  const day = new Date().toISOString().slice(0, 10);
  downloadBlob(new Blob([JSON.stringify(data)], { type: 'application/json' }), `jibun-kyokasho-${day}.json`);
  toast('バックアップを書き出しました');
}

async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('ファイルを読めませんでした'); return; }
  if (data?.app !== 'digi-textbook' || !Array.isArray(data.books)) {
    toast('じぶん教科書のバックアップではないみたい');
    return;
  }
  closeModal();
  const ok = await confirmDlg(
    `バックアップを読み込む？<br><small>同じタイトル・同じページ数の本の書き込みが、バックアップの内容で上書きされます</small>`,
    { ok: '読み込む' });
  if (!ok) return;

  const books = await Books.all();
  let restored = 0;
  const skipped = [];
  for (const bb of data.books) {
    const match = books.find(b => b.title === bb.title && b.pageCount === bb.pageCount);
    if (!match) { skipped.push(bb.title); continue; }
    for (const s of bb.strokes || []) {
      await Strokes.put({ bookId: match.id, pageNo: s.pageNo, list: s.list });
    }
    for (const t of bb.texts || []) {
      const p = await Pages.get(match.id, t.pageNo);
      if (p && !p.text) { p.text = t.text; p.textSource = t.textSource || 'ocr'; await Pages.put(p); }
    }
    if (bb.toc?.length) match.toc = bb.toc;
    if (bb.bookmarks?.length) match.bookmarks = bb.bookmarks;
    if (bb.lastPage) match.lastPage = bb.lastPage;
    await Books.put(match);
    restored++;
  }
  await renderShelf();
  let msg = `${restored}冊分を復元しました`;
  if (skipped.length) msg += `。見つからなかった本: ${skipped.join('、')}（先に同じPDFを取り込んでね）`;
  openModal(`
    <h3 class="modal-title">読み込み完了</h3>
    <p class="modal-msg">${escapeHtml(msg)}</p>
    <div class="modal-btns"><button class="btn prime" data-x>OK</button></div>`)
    .querySelector('[data-x]').onclick = closeModal;
}

// ============================================================ OCR 進捗バー
function updateOcrBar(job) {
  const bar = $('#ocrBar');
  if (!job.running) {
    bar.hidden = true;
    bar.dataset.built = '';
    if (job.total > 0) {
      toast(job.cancelRequested && job.done < job.total
        ? `文字認識を中止しました（${job.done}ページまで完了）`
        : `「${job.bookTitle}」の文字認識が終わりました！検索できるよ`);
    }
    return;
  }
  if (!bar.dataset.built) {
    bar.innerHTML = `
      <svg viewBox="0 0 24 24" width="18" height="18" class="spin"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="3" stroke-dasharray="42" stroke-dashoffset="14" stroke-linecap="round"/></svg>
      <div class="ocr-info">
        <span id="ocrLabel"></span>
        <progress id="ocrProg" max="1" value="0"></progress>
      </div>
      <button class="mini-btn" id="ocrCancel">中止</button>`;
    bar.querySelector('#ocrCancel').onclick = () => cancelOcr();
    bar.dataset.built = '1';
  }
  bar.hidden = false;
  bar.querySelector('#ocrLabel').textContent = `「${job.bookTitle}」を文字認識中 ${job.done} / ${job.total}`;
  const prog = bar.querySelector('#ocrProg');
  prog.max = Math.max(1, job.total);
  prog.value = job.done;
}

init();
