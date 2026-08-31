# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## このリポジトリについて

スキャンした教科書PDFを読む・書き込む・赤シートで暗記するための PWA「じぶん教科書」。
**ビルドなし・依存パッケージなし・フレームワークなし**の素の静的サイト（HTML + CSS + ES modules）。
`package.json` は無い。npm や bundler を安易に導入しないこと。

公開先: GitHub Pages（`main` ブランチの root） → https://shu291.github.io/digi-textbook/

## 開発コマンド

```bash
# ローカルで動かす（file:// では ES modules も IndexedDB も動かないので必ず HTTP で）
python3 -m http.server 8797 --directory .
# → http://localhost:8797  （sample-textbook.pdf で一通り試せる）
```

- localhost では Service Worker は**登録されない**。SW 込みで確認したいときだけ `http://localhost:8797/?sw`
  （開発中に古いキャッシュが配られる事故を防ぐための意図的な仕様。`js/main.js` の `init()` 参照）
- テストランナー・lint・型チェックは無い。動作確認は手動または Playwright で実機同等に触る
  （過去に確認した項目は README「検証ずみの動作」にある。回帰チェックのチェックリストとして使える）

### リリース前に必ずやること

**アプリのファイル（`index.html` / `style.css` / `js/*` / アイコン）を1つでも変えたら `sw.js` の `VER` を上げる。**
上げないと本番(https)で古いキャッシュが配られ続ける。`js/` にファイルを追加したときは `sw.js` の
`APP_ASSETS` にも追記する（漏れるとオフラインで起動しなくなる）。

コミットメッセージは `vX.Y 機能名 — 一言説明`（日本語）。`VER` のバージョンと揃える。

## アーキテクチャ

### 画面構成

`index.html` 1枚に本棚（`#shelf`）とリーダー（`#reader`）が両方入っていて、`hidden` 属性と
`body.reading` クラスで切り替える。ルーティングは無い（例外: ミスノートからの `#miss=<id>` 直リンク）。

- `js/main.js` — 本棚・PDF取り込み・回転/ページ追加/表紙のフロー・全体検索・設定・バックアップ・OCR進捗バー
- `js/reader.js` — リーダー全部（ページ送り・ズーム・ジェスチャ・ツールバー・サイドパネル・並べ替えUI・ミス登録UI・本文内検索）
- `js/draw.js` — 書き込みエンジン（ストローク・消しゴム・undo/redo・赤シート）。現在編集中の1ページを持つシングルトン
- `js/importer.js` — PDF→画像化、ページ追加、**並べ替え**、**回転**、事故復旧（`repairBook`）
- `js/ocr.js` — Tesseract.js による文字認識と全文検索
- `js/misslink.js` — 別アプリ「ミスノート」との連携（別 IndexedDB を直接読み書き）
- `js/db.js` — IndexedDB ラッパ / `js/util.js` — DOM・文字正規化・モーダル・トースト

**モジュール間の依存は一方向**（main → reader / importer / ocr、reader → draw / importer / ocr）。
逆向きの連絡は `window` の CustomEvent で行う: `shelf-refresh` / `rotate-request` / `miss-refresh`。
reader.js から本棚を更新したいときは import ではなくイベントを投げること。

### データの持ち方

IndexedDB `digi-textbook`（v1）。**全部端末内にしか無い。外部送信は一切しない。**

| store | key | 中身 |
|---|---|---|
| `books` | `id` | メタ・`toc`・`bookmarks`・`cover`・`lastPage`・`*Pending` |
| `pages` | `[bookId, pageNo]` | `w`/`h`・`thumb`・`text`・`textSource`・`uid` |
| `images` | `[bookId, pageNo]` | ページ画像 Blob（長辺2000px JPEG） |
| `strokes` | `[bookId, pageNo]` | `list`（書き込みストローク配列） |
| `prefs` | `key` | 設定 |

`pages` / `images` / `strokes` は**すべて `pageNo` がキーの一部**。だからページ番号が変わる操作
（並べ替え・ページ追加）では、この3ストアを必ず足並みそろえて移動させる（`movePageRecords`）。

### 効いている不変条件（壊すと事故る）

- **書き込み座標は 0..1 の正規化値**。太さ `size` も「ページ幅に対する比」。だから画像解像度・ズーム・
  デバイスに依存しない。90°回転では基準幅が変わるので `size *= sw/sh` の補正が要る
  （`importer.js` の `rotateBook`）。180°では不要。
- **`page.uid`（背番号）は遅延付与**。ミス登録で初めてそのページを参照したときに `reader.js` が振る。
  ミスノートは `pageNo` ではなく `uid` を持つので、並べ替えても正しい問題に飛べる（`resolvePage`）。
- **長い破壊的操作は必ず再開可能にする**。回転は `book.rotatePending`、並べ替えは `book.reorderPending`
  に進捗を記録し、1ステップごとに `Books.put`。途中で閉じても続きから再開できる。
  並べ替えは「一時スロット `pageNo >= 1000000` に浮くのは常に1ページだけ」の玉突き方式で、
  各ステップが冪等（無ければスキップ）。`openBook()` は毎回 `repairBook()` を呼び、
  中断された並べ替えの続行と、取り残された一時スロットの欠番への差し戻しを行う。
- **レコードは「置いてから消す」**（`movePageRecords`）。途中で落ちてもデータが消えない順序。
- 取り込み・追加が失敗/中止したときは、書いた分を自分で掃除してから `null` を返すか throw する。

### リーダーの描画モデル

`#pageRow` の中に **3スロット（prev / cur / next）**があり、各スロットは `<img>`（ページ画像）と
その上に重なる `<canvas>`（書き込み）。ページ送りは row の `translateX` アニメーション。

- 現在ページのスロットだけ `draw.setPage()` で**編集可能**にし、両隣は `draw.drawStatic()` で描くだけ。
- 画像の objectURL は `R.urls` に LRU で最大12件キャッシュ。`setSlot` は非同期なので、
  `slot.pageNo !== pageNo` の追い越しチェックを必ず残すこと。
- `draw.js` の保存は 400ms デバウンス。**ページ移動・リーダーを閉じる前は `await draw.saveNow()`**。
- ポインタ振り分け: Apple Pencil (`pointerType === 'pen'`) を1度でも検知したら `fingerDraw` を自動 OFF に
  して「指=スクロール / ペン=描く」へ切り替える（⋯メニューで戻せる）。

### 赤シート（暗記マーカー）

`tool === 'memo'` の緑ストロークに `hidden` フラグを立て、`sheetMode` 中は不透明な `SHEET_COLOR` の帯として
描く。タップで1本ずつめくれる。`hidden` は「未定義なら隠す」扱い（`s.hidden !== false` で隠れている判定、
トグルは `s.hidden = s.hidden === false`）なので、この真偽の向きを変えないこと。

### 検索とテキスト正規化

- 保存時 `cleanText()`: NFKC 正規化 → CJK 文字間の空白除去（OCRの分かち書き対策）→ 空白圧縮
- 検索時 `foldText()`: 小文字化 + カタカナ→ひらがな。**1文字→1文字の変換だけ**にしてある。
  折り畳んだ文字列上で求めたヒット位置を、そのまま生テキストのスニペット切り出しに使うため。
  文字数が変わる正規化をここに足すとスニペットがズレる。

### 外部ライブラリ（CDN・バージョン固定・実行時ロード）

バンドルしない。必要になったときだけ `<script>` / dynamic import で読む。

- pdf.js `4.6.82` — 取り込み時だけ。以後は保存済み画像を表示するので速い
- Tesseract.js `5.1.1` + tessdata_fast (jpn+eng) — OCR実行時だけ。初回は約10MBをキャッシュ
- `sw.js` は `cdn.jsdelivr.net` と `tessdata.projectnaptha.com` をキャッシュ優先で保持（バージョン固定前提）

### ミスノート連携

同一オリジンの別アプリ `../miss-note/` の IndexedDB `missnote` を `js/misslink.js` から直接読み書きする。

- **画像はコピーしない**。`ref: { app:'digi-textbook', bookId, pageUid, rect }` の参照だけ登録し、
  表示時に元ページから切り出す（`cropRect` / `noteCropUrl`）
- このアプリからは `ref.app === 'digi-textbook'` のノートだけを扱う
- 復習間隔 `INTERVALS = [1,3,7,16,35]` と判定ロジック `judgeMiss()` はミスノート側の実装と揃えてある。
  片方だけ変えないこと
- 本を削除するとき・回転するときは、ミス登録側も追従させる（`deleteMissOfBook` / `rotateMissRects`）

## 書き方の約束

- UI文言・コード内コメント・コミットメッセージは**すべて日本語**。対象は中高生なので、UI文言は
  やさしい言葉で（「ぜんぶかくす」「もどす」など既存の語彙に合わせる）
- CSS は `style.css` 1枚。色は `:root` の CSS 変数で定義し、`prefers-color-scheme: dark` で上書きする。
  新しい色を足すときも変数経由にする
- ユーザーへの通知は `toast()` / `confirmDlg()` / `openModal()`（`js/util.js`）を使う。`alert` は使わない
- HTMLを文字列で組み立てる箇所が多いので、ユーザー入力を混ぜるときは `escapeHtml()` を通す
