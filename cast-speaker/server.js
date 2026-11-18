// Google Home / Nest スピーカー連携サーバー
// スマホ(ブラウザ)から音声ファイルを送る → このサーバーがスピーカーに「このURLを再生して」と指示する(Cast)
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Client, DefaultMediaReceiver } = require('castv2-client');
const { Bonjour } = require('bonjour-service');

const PORT = process.env.PORT || 8080;
const MEDIA_DIR = path.join(__dirname, 'media');
const TOKEN = process.env.TOKEN || ''; // 設定すると操作APIに合言葉が必要になる
const AUDIO_EXT = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.opus': 'audio/ogg' };

fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ---------- スピーカー探索 (mDNS) ----------
const devices = new Map(); // id -> {id,name,host,port,model}
const bonjour = new Bonjour();
const browser = bonjour.find({ type: 'googlecast' }, (s) => {
  const txt = s.txt || {};
  const id = txt.id || s.name;
  const host = (s.addresses || []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || s.host;
  devices.set(id, { id, name: txt.fn || s.name, host, port: s.port, model: txt.md || '' });
});
function rescan() { try { browser.update(); } catch (_) {} }
setInterval(rescan, 15000);

// ---------- 再生セッション ----------
const sessions = new Map(); // deviceId -> {client, player, loop, current}

function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try { s.client.close(); } catch (_) {}
}

function withSession(deviceId, cb) {
  const dev = devices.get(deviceId);
  if (!dev) return cb(new Error('スピーカーが見つかりません。再検索してください'));
  const ex = sessions.get(deviceId);
  if (ex && ex.player) return cb(null, ex);
  const client = new Client();
  let done = false;
  const fail = (e) => { if (!done) { done = true; closeSession(deviceId); cb(e); } };
  client.on('error', (e) => { closeSession(deviceId); fail(e); });
  client.connect({ host: dev.host, port: dev.port }, () => {
    client.launch(DefaultMediaReceiver, (err, player) => {
      if (err) return fail(err);
      const s = { client, player, loop: false, current: null };
      player.on('status', (st) => {
        if (st && st.playerState === 'IDLE' && st.idleReason === 'FINISHED' && s.loop && s.current) {
          player.load(s.current, { autoplay: true }, () => {});
        }
      });
      sessions.set(deviceId, s);
      done = true;
      cb(null, s);
    });
  });
}

// ---------- API ----------
const app = express();
app.use(express.json());

// 音声ファイルはスピーカーが取りに来るので認証なし・Range対応(express.staticが対応)
app.use('/media', express.static(MEDIA_DIR, { acceptRanges: true }));

function auth(req, res, next) {
  if (!TOKEN) return next();
  if (req.get('x-token') === TOKEN) return next();
  res.status(401).json({ error: '合言葉が違います' });
}
app.use('/api', auth);

const upload = multer({
  storage: multer.diskStorage({
    destination: MEDIA_DIR,
    filename: (req, file, cb) => {
      // iOS等の文字化け対策で latin1→utf8 に戻し、危険な文字を除去
      const orig = Buffer.from(file.originalname, 'latin1').toString('utf8');
      const ext = path.extname(orig).toLowerCase();
      const base = path.basename(orig, ext).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80) || 'audio';
      let name = base + ext, i = 1;
      while (fs.existsSync(path.join(MEDIA_DIR, name))) name = `${base}_${i++}${ext}`;
      cb(null, name);
    },
  }),
  fileFilter: (req, file, cb) => {
    const orig = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, !!AUDIO_EXT[path.extname(orig).toLowerCase()]);
  },
  limits: { fileSize: 200 * 1024 * 1024 },
});

function listFiles() {
  return fs.readdirSync(MEDIA_DIR)
    .filter((f) => AUDIO_EXT[path.extname(f).toLowerCase()])
    .map((f) => ({ name: f, size: fs.statSync(path.join(MEDIA_DIR, f)).size, mtime: fs.statSync(path.join(MEDIA_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}
const safeName = (n) => path.basename(String(n || ''));

app.get('/api/devices', (req, res) => res.json([...devices.values()]));
app.post('/api/rescan', (req, res) => { rescan(); res.json({ ok: true }); });
app.get('/api/files', (req, res) => res.json(listFiles()));

app.post('/api/upload', upload.array('files', 20), (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: '音声ファイル(mp3/m4a/wav/aac/ogg/flac)を選んでください' });
  res.json({ files: req.files.map((f) => f.filename) });
});

app.delete('/api/files/:name', (req, res) => {
  const p = path.join(MEDIA_DIR, safeName(req.params.name));
  if (fs.existsSync(p)) fs.unlinkSync(p);
  res.json({ ok: true });
});

function baseUrl(req) {
  return process.env.PUBLIC_URL || `http://${req.get('host')}`;
}

// 再生: {device, file, loop?, volume?}
app.post('/api/play', (req, res) => {
  const { device, file, loop, volume } = req.body || {};
  const name = safeName(file);
  const full = path.join(MEDIA_DIR, name);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'ファイルがありません' });
  const media = {
    contentId: `${baseUrl(req)}/media/${encodeURIComponent(name)}`,
    contentType: AUDIO_EXT[path.extname(name).toLowerCase()],
    streamType: 'BUFFERED',
    metadata: { type: 0, metadataType: 3, title: path.basename(name, path.extname(name)) },
  };
  withSession(device, (err, s) => {
    if (err) return res.status(500).json({ error: err.message });
    s.loop = !!loop;
    s.current = media;
    const go = () => s.player.load(media, { autoplay: true }, (e) => {
      if (e) { closeSession(device); return res.status(500).json({ error: String(e.message || e) }); }
      res.json({ ok: true });
    });
    if (typeof volume === 'number') s.client.setVolume({ level: Math.min(1, Math.max(0, volume)) }, () => go());
    else go();
  });
});

function control(action) {
  return (req, res) => {
    const { device } = req.body || {};
    const s = sessions.get(device);
    if (!s) return res.json({ ok: true, note: '再生中ではありません' });
    const cb = (e) => {
      if (e) { closeSession(device); return res.status(500).json({ error: String(e.message || e) }); }
      res.json({ ok: true });
    };
    if (action === 'stop') { s.loop = false; s.current = null; s.player.stop(cb); closeSession(device); }
    else s.player[action](cb);
  };
}
app.post('/api/pause', control('pause'));
app.post('/api/resume', control('play'));
app.post('/api/stop', (req, res) => {
  const { device } = req.body || {};
  const s = sessions.get(device);
  if (!s) return res.json({ ok: true });
  s.loop = false; s.current = null;
  s.player.stop(() => { closeSession(device); res.json({ ok: true }); });
});

// 音量 {device, level:0..1}
app.post('/api/volume', (req, res) => {
  const { device, level } = req.body || {};
  withSession(device, (err, s) => {
    if (err) return res.status(500).json({ error: err.message });
    s.client.setVolume({ level: Math.min(1, Math.max(0, Number(level))) }, (e) => e ? res.status(500).json({ error: String(e.message || e) }) : res.json({ ok: true }));
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log('スピーカー連携サーバー起動。スマホ(同じWi-Fi)で次のどれかを開いてください:');
  ips.forEach((ip) => console.log(`  http://${ip}:${PORT}`));
});
