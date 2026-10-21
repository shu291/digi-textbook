const DEFAULTS = {
  kbOn: true, kbRise: 0.35, kbFall: 0.12, kbFine: 0.45, kbBrakeRise: 0.3,
  padOn: true, padDead: 0.12, padCurve: 1.6,
  mouseOn: false, mouseRange: 0.22,
  hudOn: true, warnKmh: 0,
};

const GROUPS = [
  { title: 'キーボード（← → ↓ / A D S）', items: [
    ['kbOn', '段階操作を使う', 'check'],
    ['kbRise', '全開になるまで', 'range', 0.1, 1, 0.05, (v) => v + '秒'],
    ['kbFall', 'まっすぐに戻るまで', 'range', 0.03, 0.5, 0.01, (v) => v + '秒'],
    ['kbFine', 'Shift 中の最大切れ角', 'range', 0.1, 1, 0.05, (v) => Math.round(v * 100) + '%'],
    ['kbBrakeRise', 'ブレーキが全開になるまで', 'range', 0.05, 1, 0.05, (v) => v + '秒'],
  ], note: 'ゲーム標準は「押すと即・全開」です。押し続けるほど切れていきます。' },
  { title: 'ゲームパッド', items: [
    ['padOn', '使う', 'check'],
    ['padDead', 'スティックの遊び', 'range', 0, 0.4, 0.01, (v) => Math.round(v * 100) + '%'],
    ['padCurve', '中央付近の細かさ', 'range', 1, 3, 0.1, (v) => '×' + v],
  ], note: '左スティック＝ハンドル、LT/RT または スティック下＝ブレーキ。十字キーはキーボードと同じ段階操作。接続後にどれかのボタンを押すと認識されます。' },
  { title: 'マウス', items: [
    ['mouseOn', '使う（左右の位置＝ハンドル）', 'check'],
    ['mouseRange', '全開になる位置', 'range', 0.08, 0.5, 0.01, (v) => '中央から' + Math.round(v * 100) + '%'],
  ], note: '左クリックを押している間がブレーキです。' },
  { title: '表示', items: [
    ['hudOn', '速度と入力量を画面下に表示', 'check'],
    ['warnKmh', '速度が超えたらビープ音', 'range', 0, 140, 5, (v) => (v ? v + 'km/h' : 'なし')],
  ] },
];

const root = document.getElementById('root');
let cfg = { ...DEFAULTS };

function render() {
  root.textContent = '';
  for (const g of GROUPS) {
    const sec = document.createElement('section');
    const h = document.createElement('h2'); h.textContent = g.title; sec.append(h);
    for (const [key, label, type, min, max, step, fmt] of g.items) {
      const row = document.createElement('label'); row.className = 'row';
      const name = document.createElement('span'); name.textContent = label;
      const input = document.createElement('input'); input.type = type === 'check' ? 'checkbox' : 'range';
      if (type === 'range') { input.min = min; input.max = max; input.step = step; }
      const val = document.createElement('span'); val.className = 'v';
      const show = () => { val.textContent = type === 'range' ? fmt(Number(cfg[key])) : ''; };
      if (type === 'check') input.checked = !!cfg[key]; else input.value = cfg[key];
      show();
      input.addEventListener('input', () => {
        cfg[key] = type === 'check' ? input.checked : Number(input.value);
        show();
        chrome.storage.sync.set({ [key]: cfg[key] });
      });
      row.append(name, type === 'range' ? input : document.createTextNode(''), val);
      if (type === 'check') { row.textContent = ''; row.append(name, input); }
      sec.append(row);
    }
    if (g.note) { const p = document.createElement('p'); p.className = 'note'; p.textContent = g.note; sec.append(p); }
    root.append(sec);
  }
}

chrome.storage.sync.get(DEFAULTS, (v) => { cfg = { ...DEFAULTS, ...v }; render(); });
document.getElementById('reset').addEventListener('click', () => {
  cfg = { ...DEFAULTS };
  chrome.storage.sync.set(DEFAULTS, render);
});
