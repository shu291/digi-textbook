// Service Worker: アプリ本体とCDNライブラリをキャッシュしてオフラインでも動くように
// 注意: アプリのファイルを変更したら、このバージョンを上げること（キャッシュが更新される）
const VER = 'v1.7.0';
const APP_CACHE = `digi-textbook-app-${VER}`;
const CDN_CACHE = 'digi-textbook-cdn-v1';

const APP_ASSETS = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './icon.svg',
  './icon-maskable.svg',
  './icon-180.png',
  './js/main.js',
  './js/db.js',
  './js/util.js',
  './js/importer.js',
  './js/ocr.js',
  './js/draw.js',
  './js/reader.js',
  './js/misslink.js',
];

// pdf.js / Tesseract.js / OCR学習データの配信元
const CDN_HOSTS = ['cdn.jsdelivr.net', 'tessdata.projectnaptha.com'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(APP_CACHE).then(c => c.addAll(APP_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => {
      if (k !== APP_CACHE && k !== CDN_CACHE) return caches.delete(k);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // CDN: 一度取れたらキャッシュ優先（バージョン固定なので中身は変わらない）
  if (CDN_HOSTS.includes(url.hostname)) {
    e.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok) {
        const c = await caches.open(CDN_CACHE);
        c.put(req, res.clone());
      }
      return res;
    })());
    return;
  }

  if (url.origin !== location.origin) return;

  // ページ遷移: ネット優先、だめならキャッシュ（オフライン起動）
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        const c = await caches.open(APP_CACHE);
        c.put('./index.html', res.clone());
        return res;
      } catch {
        return (await caches.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  // その他のアプリファイル: キャッシュを返しつつ裏で更新
  e.respondWith((async () => {
    const cached = await caches.match(req);
    const update = fetch(req).then(res => {
      if (res.ok) caches.open(APP_CACHE).then(c => c.put(req, res.clone()));
      return res;
    }).catch(() => null);
    return cached || (await update) || Response.error();
  })());
});
