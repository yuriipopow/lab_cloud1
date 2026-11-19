const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const swaggerUi = require('swagger-ui-express');
const { createClient } = require('redis');

const app = express();
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'dev-fallback-secret';

// ---------- Кеш (лаб. 2, завдання 5) ----------
// CACHE_ENABLED=true вмикає cache-aside для списку записів.
// Redis спільний для всіх екземплярів, тому кеш однаковий незалежно від того,
// на який екземпляр ALB надіслав запит.
const CACHE_ENABLED = process.env.CACHE_ENABLED === 'true';
const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS || '30', 10);
const NOTES_LIST_KEY = 'notes:list:v1';

let redis = null;
if (CACHE_ENABLED && process.env.REDIS_URL) {
  redis = createClient({
    url: process.env.REDIS_URL,
    socket: { connectTimeout: 2000, reconnectStrategy: (n) => Math.min(n * 200, 2000) },
  });
  redis.on('error', (err) => console.error('Redis error:', err.message));
  redis.connect().then(() => console.log('Redis connected')).catch(() => {});
}

// Лічильники для docs/CACHE.md: влучання/промахи кешу і кількість запитів до БД
// з цього екземпляра. Окремо дублюються в журнал раз на хвилину,
// щоб можна було сумувати по всіх екземплярах через CloudWatch Logs Insights.
const stats = { cacheHits: 0, cacheMisses: 0, dbQueries: 0 };

async function dbQuery(text, params) {
  stats.dbQueries++;
  return pool.query(text, params);
}

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  max: parseInt(process.env.DB_POOL_SIZE || '10', 10),
  // RDS PostgreSQL 15+ за замовчуванням вимагає TLS (rds.force_ssl = 1).
  // Перевіряємо сертифікат сервера кореневим CA Amazon RDS, вбудованим в образ.
  ssl: process.env.DB_SSL === 'true'
    ? { ca: require('fs').readFileSync(process.env.DB_SSL_CA || '/opt/certs/rds-global-bundle.pem', 'utf8') }
    : false,
});

// Повторні спроби: БД може ще стартувати, а кілька екземплярів можуть
// одночасно виконувати CREATE TABLE IF NOT EXISTS (гонка в каталозі PostgreSQL).
let dbReady = false;

async function initDb(attempt = 1) {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS authors (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        bio TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS notes (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      ALTER TABLE notes ADD COLUMN IF NOT EXISTS author_id INTEGER REFERENCES authors(id);
      INSERT INTO authors (id, name, bio)
        SELECT g, 'Автор ' || g, 'Тестовий автор #' || g FROM generate_series(1, 10) g
        ON CONFLICT (id) DO NOTHING;
      SELECT setval('authors_id_seq', GREATEST((SELECT MAX(id) FROM authors), 1));
    `);
    dbReady = true;
    console.log('Database initialized');
  } catch (err) {
    console.error(`Database init error (attempt ${attempt}):`, err.message);
    if (attempt < 10) setTimeout(() => initDb(attempt + 1), 3000);
  }
}
initDb();

const swaggerDocument = {
  openapi: '3.0.0',
  info: { title: 'Cloud Lab API', version: '2.0.0' },
  paths: {
    '/health': { get: { summary: 'Health check', responses: { 200: { description: 'OK' } } } },
    '/api/auth/token': { post: { summary: 'Отримати тестовий JWT', responses: { 200: { description: 'Токен' } } } },
    '/api/notes': {
      get: { summary: 'Останні 20 записів (кешується, якщо CACHE_ENABLED=true)', responses: { 200: { description: 'Список' } } },
      post: {
        summary: 'Створити запис (потрібен JWT)',
        security: [{ bearerAuth: [] }],
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: { content: { type: 'string' }, author_id: { type: 'integer' } } } } },
        },
        responses: { 201: { description: 'Створено' }, 401: { description: 'Неавторизовано' } },
      },
    },
    '/api/notes/{id}': {
      get: {
        summary: 'Запис за ідентифікатором',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Запис' }, 404: { description: 'Не знайдено' } },
      },
    },
    '/api/authors/{id}': {
      get: {
        summary: 'Дані автора і кількість його записів',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Автор' }, 404: { description: 'Не знайдено' } },
      },
    },
    '/api/stats': { get: { summary: 'Лічильники кешу та БД цього екземпляра', responses: { 200: { description: 'OK' } } } },
  },
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
  },
};
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

let shuttingDown = false;

app.get('/health', (req, res) => {
  // Під час завершення роботи повертаємо 503, щоб ALB швидше перестав слати сюди трафік.
  if (shuttingDown) return res.status(503).json({ status: 'shutting-down' });
  // Поки таблиці не створені, екземпляр не готовий: ALB не надсилатиме сюди трафік
  if (!dbReady) return res.status(503).json({ status: 'starting' });
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token missing' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(401).json({ error: 'Token invalid or expired' });
    req.user = user;
    next();
  });
}

app.post('/api/auth/token', (req, res) => {
  const token = jwt.sign({ sub: 'student' }, JWT_SECRET, { expiresIn: '2h' });
  res.json({ token });
});

const NOTES_LIST_SQL = `
  SELECT n.id, n.content, n.created_at, n.author_id, a.name AS author_name
  FROM notes n LEFT JOIN authors a ON a.id = n.author_id
  ORDER BY n.id DESC LIMIT 20;`;

// Cache-aside: 1) читаємо кеш; 2) якщо є — віддаємо; 3) інакше читаємо БД,
// кладемо в кеш з TTL і віддаємо. Якщо Redis недоступний — працюємо напряму з БД.
app.get('/api/notes', async (req, res) => {
  try {
    if (redis && redis.isReady) {
      try {
        const cached = await redis.get(NOTES_LIST_KEY);
        if (cached) {
          stats.cacheHits++;
          res.set('X-Cache', 'HIT');
          return res.type('application/json').send(cached);
        }
      } catch (e) {
        console.error('Redis GET failed:', e.message);
      }
      stats.cacheMisses++;
    }

    const { rows } = await dbQuery(NOTES_LIST_SQL);
    const body = JSON.stringify(rows);

    if (redis && redis.isReady) {
      redis.set(NOTES_LIST_KEY, body, { EX: CACHE_TTL_SECONDS }).catch((e) => console.error('Redis SET failed:', e.message));
      res.set('X-Cache', 'MISS');
    }
    res.type('application/json').send(body);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/notes/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const { rows } = await dbQuery(
      `SELECT n.*, a.name AS author_name FROM notes n LEFT JOIN authors a ON a.id = n.author_id WHERE n.id = $1;`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/authors/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const { rows } = await dbQuery(
      `SELECT a.*, (SELECT COUNT(*)::int FROM notes WHERE author_id = a.id) AS notes_count
       FROM authors a WHERE a.id = $1;`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notes', authenticateToken, async (req, res) => {
  try {
    const { content, author_id } = req.body || {};
    const authorId = Number.isInteger(author_id) ? author_id : 1;
    const { rows } = await dbQuery(
      'INSERT INTO notes (content, author_id) VALUES ($1, $2) RETURNING *;',
      [content || 'Новий запис', authorId]
    );
    // Навмисно НЕ інвалідуємо кеш списку: застарілість обмежена TTL
    // (див. docs/CACHE.md). Щоб вмикати інвалідацію — CACHE_INVALIDATE_ON_WRITE=true.
    if (redis && redis.isReady && process.env.CACHE_INVALIDATE_ON_WRITE === 'true') {
      redis.del(NOTES_LIST_KEY).catch(() => {});
    }
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', (req, res) => {
  res.json({ cacheEnabled: CACHE_ENABLED, cacheTtl: CACHE_TTL_SECONDS, redisReady: !!(redis && redis.isReady), ...stats });
});

// Раз на хвилину пишемо лічильники в журнал у вигляді JSON-рядка,
// щоб у CloudWatch Logs Insights порахувати сумарну частку влучань по всіх екземплярах.
let lastStats = { ...stats };
setInterval(() => {
  const delta = {
    cacheHits: stats.cacheHits - lastStats.cacheHits,
    cacheMisses: stats.cacheMisses - lastStats.cacheMisses,
    dbQueries: stats.dbQueries - lastStats.dbQueries,
  };
  lastStats = { ...stats };
  if (delta.cacheHits || delta.cacheMisses || delta.dbQueries) {
    console.log(JSON.stringify({ type: 'stats', cacheEnabled: CACHE_ENABLED, ...delta }));
  }
}, 60000).unref();

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
server.keepAliveTimeout = 65000; // більше за idle timeout ALB (60 с), щоб уникнути 502

// Graceful shutdown: ECS надсилає SIGTERM, чекає stopTimeout і тільки потім SIGKILL.
// Перестаємо приймати нові з'єднання, дочікуємося поточних запитів, закриваємо БД і Redis.
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down gracefully`);
  server.close(async () => {
    try { await pool.end(); } catch (e) {}
    try { if (redis) await redis.quit(); } catch (e) {}
    console.log('Shutdown complete');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 25000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
