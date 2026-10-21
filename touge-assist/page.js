/* ページ本体の世界(MAIN)で動く小さな部品。
   「全国トップの走りを見る」の最中にだけ、再生の速さを変えられるようにする。
   自分で走っているときは何もしない（記録は変わらない）。 */
(() => {
  if (window.__tgPatched) return;
  window.__tgPatched = true;

  let scale = 1;
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
    if (e.source !== window || !d || d.__tg !== 'scale' || typeof d.v !== 'number') return;
    scale = Math.max(0.0005, Math.min(1, d.v));
  });

  window.requestAnimationFrame = (cb) =>
    raf((t) => {
      if (last === null) { last = t; virt = t; }
      const real = t - last;
      last = t;
      virt += watching() ? real * scale : real;
      cb(virt);
    });
})();
