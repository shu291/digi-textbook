/* ページ本体の世界(MAIN)で動く小さな部品。
   ・「全国トップの走りを見る」の最中は、再生の速さを変えられる。
   ・自分で走るときの「練習スロー」は、ポップアップで許可したときだけ有効。
     スローを使うと、そのページを開き直すまで、ランキングへの送信と自己ベストの保存を止める
     （スローで出したタイムは本当の記録ではないため）。 */
(() => {
  if (window.__tgPatched) return;
  window.__tgPatched = true;

  let scale = 1;
  let practiceAllowed = false;
  let practiceUsed = false;
  let last = null;
  let virt = 0;
  const raf = window.requestAnimationFrame.bind(window);

  const watching = () => {
    const bar = document.getElementById('wBar');
    const exit = document.getElementById('wExit');
    return !!(bar && bar.classList.contains('on') && exit && !exit.hidden);
  };

  addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d) return;
    if (d.__tg === 'scale' && typeof d.v === 'number') scale = Math.max(0.0005, Math.min(1, d.v));
    if (d.__tg === 'practice') practiceAllowed = !!d.on;
  });

  window.requestAnimationFrame = (cb) =>
    raf((t) => {
      if (last === null) { last = t; virt = t; }
      const real = t - last;
      last = t;
      let k = 1;
      if (watching()) k = scale;
      else if (practiceAllowed && scale < 1) {
        k = scale;
        if (!practiceUsed) { practiceUsed = true; window.postMessage({ __tg: 'practiceUsed' }, '*'); }
      }
      virt += real * k;
      cb(virt);
    });

  /* 練習スローを使ったあとは、記録をどこにも残さない */
  const origFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (practiceUsed && /\/api\/touge\/(submit|ghost)/.test(url) && init && /post/i.test(init.method || '')) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'practice' }), { status: 400, headers: { 'content-type': 'application/json' } }));
      }
    } catch (_) {}
    return origFetch(input, init);
  };
  const origSet = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    if (practiceUsed && this === window.localStorage && (k === 'touge_ghost' || k === 'touge_rk_best' || k === 'touge_ghost_up')) return;
    return origSet.call(this, k, v);
  };
})();
