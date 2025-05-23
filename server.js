// server.js
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import PQueue from 'p-queue';
import { v4 as uuidv4 } from 'uuid';
import EventEmitter from 'events';
import path from 'path';
import { fileURLToPath } from 'url';
import ytdlExec from 'youtube-dl-exec';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 50, standardHeaders: true }));

const queue = new PQueue({ concurrency: 2 });
const jobs  = new Map();

const okURL = (u) => /^https?:\/\//i.test(u);

/* 1. /api/formats → JSON daftar kualitas */
app.get('/api/formats', async (req, res) => {
  const { url } = req.query;
  if (!okURL(url)) return res.status(400).json({ error: 'url tidak valid' });

  try {
    const info = await ytdlExec(url, { dumpSingleJson: true });
    const formats = info.formats
      .filter((f) => f.vcodec !== 'none' && f.acodec !== 'none')
      .map((f) => ({
        id: f.format_id,
        res: f.resolution || `${f.width}x${f.height}`,
        fps: f.fps,
        ext: f.ext,
        size: ((f.filesize || f.filesize_approx || 0) / 1048576).toFixed(1)
      }));

    res.json({ title: info.title, formats });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Gagal mengambil format video' });
  }
});

/* 2. /api/progress/:id → SSE progress */
app.get('/api/progress/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.sendStatus(404);

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  const send = (data) => res.write(`data:${JSON.stringify(data)}\n\n`);
  job.on('progress', send).on('done', send);

  req.on('close', () => {
    job.off('progress', send);
    job.off('done', send);
  });
});

/* 3. /api/download → stream MP4/MP3 */
app.get('/api/download', (req, res) => {
  const { url, fmt, audio } = req.query;
  if (!okURL(url)) return res.status(400).json({ error: 'url tidak valid' });

  const id = req.query.id || uuidv4();
  const emitter = new EventEmitter();
  jobs.set(id, emitter);

  queue.add(() => doDownload({ url, fmt, audio, res, emitter, id }))
    .catch((e) => console.error('queue error', e));
});

/* Fungsi unduh utama */
function doDownload({ url, fmt, audio, res, emitter, id }) {
  return new Promise(async (resolve, reject) => {
    const { spawn } = await import('child_process');

    const args = [
      url,
      '--no-playlist',
      '--progress',
      '-o', '-', // stdout
    ];

    if (audio === '1') {
      args.push('--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0');
    } else if (fmt) {
      args.push('-f', fmt.includes('+') ? fmt : `${fmt}+bestaudio/best`);
    }

    const proc = spawn('youtube-dl', args); // Gunakan CLI langsung

    let filename = audio === '1' ? 'audio.mp3' : 'video.mp4';

    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      const m = s.match(/Destination: (.+)/);
      if (m) filename = path.basename(m[1]);

      const p = s.match(/(\d{1,3}\.\d)%/);
      if (p) emitter.emit('progress', { pct: parseFloat(p[1]) });
    });

    res.set({
      'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
      'Content-Type': audio === '1' ? 'audio/mpeg' : 'application/octet-stream'
    });

    proc.stdout.pipe(res);
    proc.stderr.pipe(process.stderr);

    proc.on('error', (e) => {
      jobs.delete(id);
      reject(e);
    });

    proc.on('close', () => {
      emitter.emit('done', { done: true });
      jobs.delete(id);
      resolve();
    });
  });
}

/* Jalankan server */
app.listen(PORT, () => {
  console.log(`🚀 API on :${PORT}`);
});
