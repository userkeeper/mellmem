// server.js — Express backend (v2: user uploads + Telegram auth + leaderboard)
import express from 'express';
import multer from 'multer';
import pkg from 'pg';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { spawn } from 'child_process';
import { randomUUID, createHmac } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import cors from 'cors';

const { Pool } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const {
  PORT = 3000,
  DATABASE_URL,
  ADMIN_PASSWORD = 'changeme',
  JWT_SECRET = 'dev-secret-change-me',
  BOT_TOKEN,
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME,
  R2_PUBLIC_URL,
} = process.env;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      slug VARCHAR(64) PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS users (
      tg_id BIGINT PRIMARY KEY,
      username VARCHAR(64),
      first_name VARCHAR(128),
      photo_url TEXT,
      uploads_count INTEGER DEFAULT 0,
      total_downloads_received INTEGER DEFAULT 0,
      is_banned BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW(),
      last_seen TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS footage (
      id SERIAL PRIMARY KEY,
      title VARCHAR(256) NOT NULL,
      category_slug VARCHAR(64) REFERENCES categories(slug) ON DELETE SET NULL,
      tags TEXT[] DEFAULT '{}',
      video_key VARCHAR(256) NOT NULL,
      preview_key VARCHAR(256),
      duration NUMERIC(6,2),
      size_bytes BIGINT,
      source_url TEXT,
      downloads INTEGER DEFAULT 0,
      uploader_tg_id BIGINT REFERENCES users(tg_id) ON DELETE SET NULL,
      status VARCHAR(16) DEFAULT 'approved',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_footage_category ON footage(category_slug);
    CREATE INDEX IF NOT EXISTS idx_footage_tags ON footage USING GIN(tags);
    CREATE INDEX IF NOT EXISTS idx_footage_status ON footage(status);
    CREATE INDEX IF NOT EXISTS idx_footage_uploader ON footage(uploader_tg_id);

    CREATE TABLE IF NOT EXISTS downloads_log (
      id SERIAL PRIMARY KEY,
      footage_id INTEGER REFERENCES footage(id) ON DELETE CASCADE,
      user_tg_id BIGINT,
      ip VARCHAR(64),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  const { rows } = await pool.query('SELECT COUNT(*) FROM categories');
  if (parseInt(rows[0].count) === 0) {
    const defaults = [
      ['reactions', 'Реакции'], ['orel', 'Орёл'], ['casino', 'Казино'],
      ['screams', 'Крики'], ['laughs', 'Смех'], ['other', 'Прочее']
    ];
    for (const [slug, name] of defaults) {
      await pool.query('INSERT INTO categories (slug, name) VALUES ($1, $2)', [slug, name]);
    }
  }
  console.log('✓ Database ready');
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY }
});

async function uploadToR2(key, body, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME, Key: key, Body: body, ContentType: contentType
  }));
}

async function deleteFromR2(key) {
  if (!key) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
  } catch (e) { console.warn('R2 delete failed:', key, e.message); }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args);
    let stderr = '';
    p.stderr.on('data', d => stderr += d.toString());
    p.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg: ' + stderr.slice(-500))));
    p.on('error', reject);
  });
}

function ffprobeDuration(file) {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', file]);
    let out = '';
    p.stdout.on('data', d => out += d.toString());
    p.on('close', () => resolve(parseFloat(out.trim()) || null));
    p.on('error', () => resolve(null));
  });
}

// ========= TELEGRAM initData VALIDATION =========
function validateTelegramInitData(initData) {
  if (!BOT_TOKEN || !initData) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const dataCheckArr = [];
    for (const [k, v] of [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      dataCheckArr.push(`${k}=${v}`);
    }
    const dataCheckString = dataCheckArr.join('\n');

    const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calcHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (calcHash !== hash) return null;

    const authDate = parseInt(params.get('auth_date'));
    if (Date.now() / 1000 - authDate > 86400) return null;

    const userJson = params.get('user');
    if (!userJson) return null;
    return JSON.parse(userJson);
  } catch (e) {
    return null;
  }
}

async function upsertUser(tgUser) {
  await pool.query(`
    INSERT INTO users (tg_id, username, first_name, photo_url, last_seen)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (tg_id) DO UPDATE
    SET username = EXCLUDED.username,
        first_name = EXCLUDED.first_name,
        photo_url = EXCLUDED.photo_url,
        last_seen = NOW()
  `, [tgUser.id, tgUser.username || null, tgUser.first_name || null, tgUser.photo_url || null]);
}

async function requireTgUser(req, res, next) {
  const initData = req.headers['x-tg-init-data'];
  const user = validateTelegramInitData(initData);
  if (!user) return res.status(401).json({ error: 'invalid telegram auth' });
  const { rows } = await pool.query('SELECT is_banned FROM users WHERE tg_id = $1', [user.id]);
  if (rows[0]?.is_banned) return res.status(403).json({ error: 'user banned' });
  await upsertUser(user);
  req.tgUser = user;
  next();
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token) return res.status(401).json({ error: 'no token' });
  try { jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'invalid token' }); }
}

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'wrong password' });
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token });
});

app.get('/api/admin/check', requireAdmin, (req, res) => res.json({ ok: true }));

// ========= PUBLIC =========
app.get('/api/footage', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT f.id, f.title, f.category_slug, f.tags, f.duration, f.downloads,
           f.video_key, f.preview_key, f.source_url, f.created_at, f.status,
           c.name AS category_name,
           u.tg_id AS uploader_id, u.username AS uploader_username, u.first_name AS uploader_name
    FROM footage f
    LEFT JOIN categories c ON c.slug = f.category_slug
    LEFT JOIN users u ON u.tg_id = f.uploader_tg_id
    WHERE f.status = 'approved'
    ORDER BY f.created_at DESC
  `);
  res.json(rows.map(r => ({
    id: r.id, title: r.title, category_slug: r.category_slug, category_name: r.category_name,
    tags: r.tags || [], duration: r.duration ? parseFloat(r.duration) : null,
    downloads: r.downloads,
    video_url: `${R2_PUBLIC_URL}/${r.video_key}`,
    preview_url: r.preview_key ? `${R2_PUBLIC_URL}/${r.preview_key}` : null,
    source_url: r.source_url, created_at: r.created_at,
    uploader: r.uploader_id ? {
      id: r.uploader_id, username: r.uploader_username, name: r.uploader_name
    } : null
  })));
});

app.get('/api/categories', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT c.slug, c.name, COUNT(f.id) FILTER (WHERE f.status = 'approved')::int AS count
    FROM categories c LEFT JOIN footage f ON f.category_slug = c.slug
    GROUP BY c.slug, c.name ORDER BY c.name
  `);
  res.json(rows);
});

app.get('/api/leaderboard', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT u.tg_id, u.username, u.first_name, u.photo_url, u.uploads_count,
           COALESCE(SUM(f.downloads), 0)::int AS total_downloads
    FROM users u
    LEFT JOIN footage f ON f.uploader_tg_id = u.tg_id AND f.status = 'approved'
    WHERE u.uploads_count > 0
    GROUP BY u.tg_id, u.username, u.first_name, u.photo_url, u.uploads_count
    ORDER BY total_downloads DESC, u.uploads_count DESC LIMIT 50
  `);
  res.json(rows);
});

app.post('/api/download/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const user = validateTelegramInitData(req.headers['x-tg-init-data']);
  const { rows } = await pool.query(
    `UPDATE footage SET downloads = downloads + 1
     WHERE id = $1 AND status = 'approved'
     RETURNING video_key, title, downloads, uploader_tg_id`, [id]
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  const row = rows[0];
  if (row.uploader_tg_id) {
    await pool.query(
      'UPDATE users SET total_downloads_received = total_downloads_received + 1 WHERE tg_id = $1',
      [row.uploader_tg_id]
    ).catch(() => {});
  }
  await pool.query('INSERT INTO downloads_log (footage_id, user_tg_id, ip) VALUES ($1, $2, $3)',
    [id, user?.id || null, req.ip]).catch(() => {});
  const safeName = row.title.replace(/[^\w\sа-яА-Я-]/gi, '').replace(/\s+/g, '_').slice(0, 60) || 'footage';
  res.json({
    url: `${R2_PUBLIC_URL}/${row.video_key}`,
    filename: `${safeName}.mp4`, downloads: row.downloads
  });
});

// ========= USER UPLOAD =========
const userUpload = multer({ dest: '/tmp', limits: { fileSize: 30 * 1024 * 1024 } });

async function checkUploadLimit(tgId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM footage
     WHERE uploader_tg_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`, [tgId]);
  return rows[0].cnt < 5;
}

app.post('/api/user/upload', requireTgUser, userUpload.single('video'), async (req, res) => {
  const tmpPath = req.file?.path;
  if (!tmpPath) return res.status(400).json({ error: 'no file' });
  let tmpPreview = null;
  try {
    if (!(await checkUploadLimit(req.tgUser.id))) {
      fs.unlinkSync(tmpPath);
      return res.status(429).json({ error: 'лимит 5 загрузок в час' });
    }
    const { title, category_slug, tags, source_url } = req.body;
    if (!title || title.trim().length < 2) {
      fs.unlinkSync(tmpPath);
      return res.status(400).json({ error: 'название обязательно' });
    }
    const tagsArr = JSON.parse(tags || '[]').slice(0, 10);
    const uid = randomUUID();
    const videoKey = `videos/${uid}.mp4`;
    const previewKey = `previews/${uid}.jpg`;
    tmpPreview = `/tmp/${uid}.jpg`;

    await runFfmpeg(['-ss', '0.5', '-i', tmpPath, '-vframes', '1',
      '-vf', 'scale=360:-2', '-q:v', '3', '-y', tmpPreview]);

    const duration = await ffprobeDuration(tmpPath);
    if (duration && duration > 60) {
      fs.unlinkSync(tmpPath); fs.unlinkSync(tmpPreview);
      return res.status(400).json({ error: 'макс длина 60 секунд' });
    }

    await uploadToR2(videoKey, fs.readFileSync(tmpPath), 'video/mp4');
    await uploadToR2(previewKey, fs.readFileSync(tmpPreview), 'image/jpeg');

    const { rows } = await pool.query(`
      INSERT INTO footage (title, category_slug, tags, video_key, preview_key,
                           duration, size_bytes, source_url, uploader_tg_id, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
      RETURNING id
    `, [title.trim().slice(0, 256), category_slug || null, tagsArr, videoKey, previewKey,
        duration, req.file.size, source_url || null, req.tgUser.id]);

    await pool.query('UPDATE users SET uploads_count = uploads_count + 1 WHERE tg_id = $1',
      [req.tgUser.id]);

    fs.unlinkSync(tmpPath); fs.unlinkSync(tmpPreview);
    res.json({
      id: rows[0].id, status: 'pending',
      message: 'Футаж отправлен на модерацию. Появится в каталоге после проверки.'
    });
  } catch (e) {
    console.error('User upload error:', e);
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    if (tmpPreview && fs.existsSync(tmpPreview)) fs.unlinkSync(tmpPreview);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/user/me', requireTgUser, async (req, res) => {
  const { rows: [u] } = await pool.query(
    `SELECT tg_id, username, first_name, photo_url, uploads_count, total_downloads_received
     FROM users WHERE tg_id = $1`, [req.tgUser.id]);
  const { rows: myFootage } = await pool.query(`
    SELECT id, title, status, downloads, preview_key, created_at
    FROM footage WHERE uploader_tg_id = $1 ORDER BY created_at DESC
  `, [req.tgUser.id]);
  res.json({
    user: u,
    footage: myFootage.map(f => ({
      ...f,
      preview_url: f.preview_key ? `${R2_PUBLIC_URL}/${f.preview_key}` : null
    }))
  });
});

// ========= ADMIN =========
const adminUpload = multer({ dest: '/tmp', limits: { fileSize: 100 * 1024 * 1024 } });

app.post('/api/admin/upload', requireAdmin, adminUpload.single('video'), async (req, res) => {
  const tmpPath = req.file?.path;
  if (!tmpPath) return res.status(400).json({ error: 'no file' });
  let tmpPreview = null;
  try {
    const { title, category_slug, tags, source_url } = req.body;
    const tagsArr = JSON.parse(tags || '[]');
    const uid = randomUUID();
    const videoKey = `videos/${uid}.mp4`;
    const previewKey = `previews/${uid}.jpg`;
    tmpPreview = `/tmp/${uid}.jpg`;

    await runFfmpeg(['-ss', '0.5', '-i', tmpPath, '-vframes', '1',
      '-vf', 'scale=360:-2', '-q:v', '3', '-y', tmpPreview]);
    const duration = await ffprobeDuration(tmpPath);
    await uploadToR2(videoKey, fs.readFileSync(tmpPath), 'video/mp4');
    await uploadToR2(previewKey, fs.readFileSync(tmpPreview), 'image/jpeg');

    const { rows } = await pool.query(`
      INSERT INTO footage (title, category_slug, tags, video_key, preview_key,
                           duration, size_bytes, source_url, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'approved')
      RETURNING id
    `, [title, category_slug || null, tagsArr, videoKey, previewKey,
        duration, req.file.size, source_url || null]);

    fs.unlinkSync(tmpPath); fs.unlinkSync(tmpPreview);
    res.json({ id: rows[0].id, duration });
  } catch (e) {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    if (tmpPreview && fs.existsSync(tmpPreview)) fs.unlinkSync(tmpPreview);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/pending', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT f.*, u.username AS uploader_username, u.first_name AS uploader_name,
           c.name AS category_name
    FROM footage f
    LEFT JOIN users u ON u.tg_id = f.uploader_tg_id
    LEFT JOIN categories c ON c.slug = f.category_slug
    WHERE f.status = 'pending' ORDER BY f.created_at ASC
  `);
  res.json(rows.map(r => ({
    ...r,
    video_url: `${R2_PUBLIC_URL}/${r.video_key}`,
    preview_url: r.preview_key ? `${R2_PUBLIC_URL}/${r.preview_key}` : null
  })));
});

app.post('/api/admin/moderate/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const { action } = req.body;
  if (action === 'approve') {
    await pool.query(`UPDATE footage SET status = 'approved' WHERE id = $1`, [id]);
    res.json({ ok: true });
  } else if (action === 'reject') {
    const { rows } = await pool.query(
      `UPDATE footage SET status = 'rejected' WHERE id = $1
       RETURNING video_key, preview_key, uploader_tg_id`, [id]);
    if (rows.length) {
      await deleteFromR2(rows[0].video_key);
      await deleteFromR2(rows[0].preview_key);
      if (rows[0].uploader_tg_id) {
        await pool.query(
          'UPDATE users SET uploads_count = GREATEST(uploads_count - 1, 0) WHERE tg_id = $1',
          [rows[0].uploader_tg_id]);
      }
    }
    res.json({ ok: true });
  } else res.status(400).json({ error: 'action must be approve|reject' });
});

app.delete('/api/admin/footage/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const { rows } = await pool.query(
    'DELETE FROM footage WHERE id = $1 RETURNING video_key, preview_key', [id]);
  if (rows.length) {
    await deleteFromR2(rows[0].video_key);
    await deleteFromR2(rows[0].preview_key);
  }
  res.json({ ok: true });
});

app.post('/api/admin/categories', requireAdmin, async (req, res) => {
  const { slug, name } = req.body;
  await pool.query(
    'INSERT INTO categories (slug, name) VALUES ($1, $2) ON CONFLICT (slug) DO UPDATE SET name = $2',
    [slug, name]);
  res.json({ ok: true });
});

app.delete('/api/admin/categories/:slug', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM categories WHERE slug = $1', [req.params.slug]);
  res.json({ ok: true });
});

app.post('/api/admin/ban-user/:tg_id', requireAdmin, async (req, res) => {
  await pool.query('UPDATE users SET is_banned = TRUE WHERE tg_id = $1', [req.params.tg_id]);
  res.json({ ok: true });
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM footage WHERE status = 'approved')::int AS total_footage,
      (SELECT COUNT(*) FROM footage WHERE status = 'pending')::int AS pending_count,
      (SELECT COALESCE(SUM(downloads), 0) FROM footage)::int AS total_downloads,
      (SELECT COUNT(*) FROM users)::int AS total_users,
      (SELECT COUNT(*) FROM downloads_log WHERE created_at > NOW() - INTERVAL '24 hours')::int AS downloads_24h
  `);
  res.json(rows[0]);
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server on http://localhost:${PORT}`));
}).catch(err => { console.error('Init failed:', err); process.exit(1); });
