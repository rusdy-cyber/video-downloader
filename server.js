/* server.js – fitur:
   • /api/formats      → list kualitas
   • /api/download     → unduh (MP4 / MP3)
   • /api/progress/:id → SSE progress %
*/
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import PQueue from 'p-queue';
import { v4 as uuidv4 } from 'uuid';
import { raw as ytdl } from 'youtube-dl-exec';
import EventEmitter from 'events';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 8080;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ───── middlewares ───── */
app.use(cors());
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50, // 50 req / 15 menit / IP
    standardHeaders: true
  })
);

const queue = new PQueue({ concurrency: 2 }); // ≤2 download paralel
const jobs  = new Map();                      // id → {emitter}

/* ───── helper ───── */
const okURL = (u) => /^https?:\/\//i.test(u);

/* ============ 1. Daftar format ============ */
app.get('/api/formats', async (req, res) => {
  const { url } = req.query;
  if (!okURL(url)) return res.status(400).json({ error: 'url tak valid' });
  try {
    const info = await ytdl(url, { dumpSingleJson: true });
    const formats = info.formats
      .filter((f) => f.vcodec !== 'none' && f.acodec !== 'none')
      .map((f) => ({
        id: f.format_id,
        res: f.resolution || `${f.width}x${f.height}`,
        fps: f.fps,
        ext: f.ext,
        size: ((f.filesize || f.filesize_approx) / 1048576).toFixed(1) // MB
      }));
    res.json({ title: info.title, formats });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'gagal ambil format' });
  }
});

/* ============ 2. Progress SSE ============ */
app.get('/api/progress/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.sendStatus(404);

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  const send = (d) => res.write(`data:${JSON.stringify(d)}\n\n`);
  job.on('progress', send).on('done', send);

  req.on('close', () => {
    job.off('progress', send).off('done', send);
  });
});

/* ============ 3. Download ============ */
app.get('/api/download', async (req, res) => {
  const { url, fmt, audio } = req.query;
  if (!okURL(url)) return res.status(400).json({ error: 'url tak valid' });

  const id      = req.query.id || uuidv4();
  const emitter = new EventEmitter();
  jobs.set(id, emitter);

  // tugas di-enqueue agar maksimal 2 download serentak
  queue.add(() => doDownload({ url, fmt, audio, res, emitter }))
       .catch((e) => console.error('queue error', e));
});

/* ========= fungsi inti unduh ========= */
function doDownload({ url, fmt, audio, res, emitter }) {
  return new Promise((resolve, reject) => {
    const args = {
      output       : '-', // stream
      'no-playlist': true,
      progress     : true
    };

    if (audio === '1') {
      Object.assign(args, {
        extractAudio : true,
        audioFormat  : 'mp3',
        audioQuality : 0
      });
    } else if (fmt) {
      args.format = fmt.includes('+') ? fmt : `${fmt}+bestaudio/best`;
    }

    const proc = ytdl(url, args);
    let filename = audio === '1' ? 'audio.mp3' : 'video.mp4';

    proc.stderr.on('data', (c) => {
      const s = c.toString();
      const m = s.match(/Destination: (.+)/);
      if (m) filename = path.basename(m[1]);

      const p = s.match(/(\d{1,3}\.\d)%/);
      if (p) emitter.emit('progress', { pct: parseFloat(p[1]) });
    });

    res.set({
      'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
      'Content-Type'       : audio === '1' ? 'audio/mpeg'
                                           : 'application/octet-stream'
    });

    proc.stdout.pipe(res);
    proc.stderr.pipe(process.stderr);

    proc.on('error', reject);
    proc.on('close', () => {
      emitter.emit('done', { done: true });
      jobs.delete(id);
      resolve();
    });
  });
}

/* ── (opsional) serve frontend statis ── */
/* app.use(express.static(path.join(__dirname, 'public'))); */

app.listen(PORT, () => console.log(`🚀 API on :${PORT}`));
