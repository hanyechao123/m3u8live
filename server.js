const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);
const ROOT = process.cwd();
const MAX_BODY_SIZE = 1024 * 64;
const RUNNING_JOB_TTL_MS = 6 * 60 * 60 * 1000;
const FINISHED_JOB_TTL_MS = 2 * 60 * 60 * 1000;
const JOB_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const jobs = new Map();

function nowIso() {
  return new Date().toISOString();
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim();
  }
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '-';
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text) {
  const body = String(text || '');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.ico') return 'image/x-icon';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

function safeJoin(base, target) {
  const normalized = path.normalize(path.join(base, target));
  if (!normalized.startsWith(base)) return null;
  return normalized;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isValidM3u8Url(input) {
  try {
    const u = new URL(input);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return u.href.toLowerCase().includes('.m3u8');
  } catch (_) {
    return false;
  }
}

function ensureFfmpeg() {
  const out = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  return out.status === 0;
}

function buildFfmpegArgs(sourceUrl, outputFile, profile) {
  const p = profile === 'balanced' ? 'balanced' : 'fast';
  if (p === 'balanced') {
    return [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-i', sourceUrl,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '24',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      outputFile,
    ];
  }
  return [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', sourceUrl,
    '-vf', 'scale=-2:480',
    '-r', '24',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '30',
    '-c:a', 'aac',
    '-b:a', '96k',
    '-ac', '2',
    '-movflags', '+faststart',
    outputFile,
  ];
}

async function createJob(sourceUrl, profile) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'm3u8live-'));
  const makeId = () =>
    crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
  const outputFile = path.join(tempDir, `${makeId()}.mp4`);
  const jobId = makeId();
  const ffArgs = buildFfmpegArgs(sourceUrl, outputFile, profile);
  const job = {
    id: jobId,
    sourceUrl,
    profile: profile === 'balanced' ? 'balanced' : 'fast',
    status: 'running',
    error: '',
    outputFile,
    tempDir,
    createdAt: Date.now(),
    lastAccessAt: Date.now(),
    finishedAt: 0,
  };
  jobs.set(jobId, job);

  const proc = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  proc.on('error', (err) => {
    job.status = 'error';
    job.error = err.message || String(err);
    job.finishedAt = Date.now();
  });
  proc.on('close', (code) => {
    if (code === 0) {
      job.status = 'done';
    } else {
      job.status = 'error';
      job.error = stderr || `ffmpeg exited with ${code}`;
    }
    job.finishedAt = Date.now();
    job.lastAccessAt = Date.now();
  });

  return jobId;
}

async function cleanupJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  jobs.delete(jobId);
  const { outputFile, tempDir } = job;
  try { await fs.promises.unlink(outputFile); } catch (_) {}
  try { await fs.promises.rmdir(tempDir); } catch (_) {}
}

function routeConvertStatus(pathname) {
  const m = pathname.match(/^\/api\/convert\/([^/]+)\/status$/);
  return m ? m[1] : null;
}

function routeConvertDownload(pathname) {
  const m = pathname.match(/^\/api\/convert\/([^/]+)\/download$/);
  return m ? m[1] : null;
}

function getJobPublic(job) {
  return {
    id: job.id,
    status: job.status,
    error: job.error,
    profile: job.profile,
    createdAt: job.createdAt,
    lastAccessAt: job.lastAccessAt,
    finishedAt: job.finishedAt,
  };
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch (_) {
    return false;
  }
}

const ffmpegReady = ensureFfmpeg();

async function sweepExpiredJobs() {
  const now = Date.now();
  for (const [jobId, job] of jobs.entries()) {
    const refTime = job.lastAccessAt || job.createdAt || now;
    if (job.status === 'running') {
      if (now - refTime > RUNNING_JOB_TTL_MS) {
        await cleanupJob(jobId);
      }
      continue;
    }
    if (now - refTime > FINISHED_JOB_TTL_MS) {
      await cleanupJob(jobId);
    }
  }
}

setInterval(() => {
  sweepExpiredJobs().catch((err) => {
    console.error('job sweep failed:', err);
  });
}, JOB_SWEEP_INTERVAL_MS).unref();

const server = http.createServer(async (req, res) => {
  const reqStart = Date.now();
  const pathnameForLog = (() => {
    try {
      return new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
    } catch (_) {
      return req.url || '-';
    }
  })();
  const shouldLogApi = pathnameForLog.startsWith('/api/');
  if (shouldLogApi) {
    console.log(`[${nowIso()}] -> ${req.method} ${pathnameForLog} ip=${getClientIp(req)}`);
    res.on('finish', () => {
      const cost = Date.now() - reqStart;
      console.log(`[${nowIso()}] <- ${req.method} ${pathnameForLog} ${res.statusCode} ${cost}ms`);
    });
  }

  try {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsed.pathname;

    if (req.method === 'POST' && pathname === '/api/convert') {
      if (!ffmpegReady) {
        sendText(res, 500, 'ffmpeg 未安装。请先安装 ffmpeg 后重启 `node server.js`。');
        return;
      }
      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        sendText(res, 400, e.message || '请求解析失败');
        return;
      }

      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch (_) {
        sendText(res, 400, '请求体必须是 JSON');
        return;
      }

      const sourceUrl = String(payload.url || '').trim();
      const profile = String(payload.profile || 'fast').trim();
      if (!isValidM3u8Url(sourceUrl)) {
        sendText(res, 400, '请输入有效的 m3u8 链接（http/https 且包含 .m3u8）');
        return;
      }
      try {
        const jobId = await createJob(sourceUrl, profile);
        sendJson(res, 200, { jobId });
      } catch (e) {
        sendText(res, 500, `ffmpeg 转码失败: ${e.message || e}`);
      }
      return;
    }

    const statusJobId = routeConvertStatus(pathname);
    if (req.method === 'GET' && statusJobId) {
      const job = jobs.get(statusJobId);
      if (!job) {
        sendJson(res, 404, { error: '任务不存在或已过期' });
        return;
      }
      job.lastAccessAt = Date.now();
      sendJson(res, 200, getJobPublic(job));
      return;
    }

    const downloadJobId = routeConvertDownload(pathname);
    if (req.method === 'GET' && downloadJobId) {
      const job = jobs.get(downloadJobId);
      if (!job) {
        sendText(res, 404, '任务不存在或已过期');
        return;
      }
      job.lastAccessAt = Date.now();
      if (job.status === 'error') {
        sendText(res, 500, `转码失败: ${job.error}`);
        return;
      }
      if (job.status !== 'done') {
        sendText(res, 409, '任务尚未完成');
        return;
      }
      if (!fileExists(job.outputFile)) {
        sendText(res, 500, '输出文件不存在');
        await cleanupJob(downloadJobId);
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename="m3u8_to_mp4_${Date.now()}.mp4"`,
      });
      const stream = fs.createReadStream(job.outputFile);
      stream.on('error', async () => {
        await cleanupJob(downloadJobId);
        if (!res.headersSent) sendText(res, 500, '读取输出文件失败');
        else res.destroy();
      });
      stream.on('close', async () => {
        await cleanupJob(downloadJobId);
      });
      stream.pipe(res);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }

    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = decodeURIComponent(filePath);
    const absolutePath = safeJoin(ROOT, filePath);
    if (!absolutePath) {
      sendJson(res, 400, { error: 'Bad Request' });
      return;
    }

    let stat;
    try {
      stat = await fs.promises.stat(absolutePath);
    } catch (_) {
      sendJson(res, 404, { error: 'Not Found' });
      return;
    }
    if (!stat.isFile()) {
      sendJson(res, 404, { error: 'Not Found' });
      return;
    }

    res.writeHead(200, { 'Content-Type': mimeType(absolutePath) });
    fs.createReadStream(absolutePath).pipe(res);
  } catch (e) {
    sendText(res, 500, `Server error: ${e.message || e}`);
  }
});

server.listen(PORT, HOST, () => {
  const ffmpegMsg = ffmpegReady ? 'ffmpeg: OK' : 'ffmpeg: MISSING';
  console.log(`Server running at http://${HOST}:${PORT} (${ffmpegMsg})`);
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other service or run: PORT=8090 node server.js`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
