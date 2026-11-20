const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const swaggerUi = require('swagger-ui-express');
const { SendMessageCommand } = require('@aws-sdk/client-sqs');
const {
  stats, pool, dbQuery, db, initDb, insertNote,
  redis, redisReady, sqs, getQueueUrl, JOB_TTL_SECONDS, jobKey,
} = require('./lib');

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
const cacheOn = () => CACHE_ENABLED && redisReady();

// ---------- Запис через чергу (лаб. 2, бонус 6) ----------
// WRITE_MODE=sync  — POST /api/notes пише в БД і відповідає 201 з записом;
// WRITE_MODE=queue — кладе повідомлення в SQS і відповідає 202 зі статусом задачі.
const WRITE_MODE = process.env.WRITE_MODE === 'queue' ? 'queue' : 'sync';

// ---------- Ідемпотентність (лаб. 2, бонус 7) ----------
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const idemKey = (key) => `idem:${key}`;

initDb();

const swaggerDocument = {
  openapi: '3.0.0',
  info: { title: 'Cloud Lab API', version: '3.0.0' },
  paths: {
    '/health': { get: { summary: 'Health check', responses: { 200: { description: 'OK' } } } },
    '/api/auth/token': { post: { summary: 'Отримати тестовий JWT', responses: { 200: { description: 'Токен' } } } },
    '/api/notes': {
      get: { summary: 'Останні 20 записів (кешується, якщо CACHE_ENABLED=true)', responses: { 200: { description: 'Список' } } },
      post: {
        summary: 'Створити запис (потрібен JWT). WRITE_MODE=queue — асинхронно через SQS',
        security: [{ bearerAuth: [] }],
        parameters: [{
          name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', maxLength: 255 },
          description: 'Повторний запит з тим самим ключем протягом 24 год повертає збережену відповідь без повторного виконання',
        }],
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: { content: { type: 'string' }, author_id: { type: 'integer' } } } } },
        },
        responses: {
          201: { description: 'Створено (WRITE_MODE=sync)' },
          202: { description: 'Прийнято в обробку (WRITE_MODE=queue); статус — у statusUrl' },
          401: { description: 'Неавторизовано' },
          409: { description: 'Запит із цим Idempotency-Key ще виконується' },
          422: { description: 'Idempotency-Key уже використано з іншим тілом запиту' },
        },
      },
    },
    '/api/requests/{requestId}': {
      get: {
        summary: 'Статус асинхронного запису: pending | done (з noteId)',
        parameters: [{ name: 'requestId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Статус' }, 404: { description: 'Невідомий requestId' } },
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
  if (!db.ready) return res.status(503).json({ status: 'starting' });
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
    if (cacheOn()) {
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

    if (cacheOn()) {
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
      `SELECT n.id, n.content, n.created_at, n.author_id, a.name AS author_name
       FROM notes n LEFT JOIN authors a ON a.id = n.author_id WHERE n.id = $1;`,
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

// ---------- Ідемпотентність запису ----------
// Перший запит із ключем: атомарно (SET NX) займаємо ключ станом "processing",
// виконуємо операцію і зберігаємо {статус, тіло} на 24 год.
// Повтор із тим самим ключем і тим самим тілом -> та сама відповідь без повторного виконання
// (заголовок Idempotent-Replayed: true). Інше тіло -> 422. Ще виконується -> 409.
function idempotency(req, res, next) {
  const key = req.get('Idempotency-Key');
  if (!key) return next();
  if (key.length > 255) return res.status(400).json({ error: 'Idempotency-Key too long' });
  if (!redisReady()) return res.status(503).json({ error: 'Idempotency store unavailable, retry later' });

  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(req.body || {})).digest('hex');
  const rkey = idemKey(key);

  (async () => {
    // "processing" живе 60 с: якщо екземпляр впаде посеред запиту, ключ звільниться сам,
    // і клієнт зможе повторити. Готова відповідь зберігається на 24 год.
    const claimed = await redis.set(rkey, JSON.stringify({ state: 'processing', fingerprint }), {
      NX: true, EX: 60,
    });
    if (!claimed) {
      stats.idemReplays = (stats.idemReplays || 0) + 1;
      const saved = JSON.parse((await redis.get(rkey)) || '{}');
      if (saved.fingerprint && saved.fingerprint !== fingerprint) {
        return res.status(422).json({ error: 'Idempotency-Key was already used with a different request body' });
      }
      if (saved.state !== 'done') {
        return res.set('Retry-After', '1').status(409).json({ error: 'A request with this Idempotency-Key is still in progress' });
      }
      return res.set('Idempotent-Replayed', 'true').status(saved.status).json(saved.body);
    }

    // Перехоплюємо відповідь обробника, щоб зберегти її під ключем
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 500) {
        redis.set(rkey, JSON.stringify({ state: 'done', fingerprint, status: res.statusCode, body }), {
          EX: IDEMPOTENCY_TTL_SECONDS,
        }).catch((e) => console.error('Idempotency save failed:', e.message));
      } else {
        // Помилка сервера: звільняємо ключ, щоб клієнт міг повторити запит
        redis.del(rkey).catch(() => {});
      }
      return originalJson(body);
    };
    req.idempotencyKey = key;
    next();
  })().catch((err) => res.status(500).json({ error: err.message }));
}

app.post('/api/notes', authenticateToken, idempotency, async (req, res) => {
  try {
    const { content, author_id } = req.body || {};
    const authorId = Number.isInteger(author_id) ? author_id : 1;

    if (WRITE_MODE === 'queue') {
      // Асинхронно: кладемо повідомлення в чергу, обробник виконає запис.
      // requestId стає idempotency_key рядка в БД — повторна доставка того самого
      // повідомлення (at-least-once) не створить дубль.
      const requestId = crypto.randomUUID();
      if (redisReady()) {
        await redis.set(jobKey(requestId), JSON.stringify({ status: 'pending', acceptedAt: Date.now() }), { EX: JOB_TTL_SECONDS });
      }
      await sqs.send(new SendMessageCommand({
        QueueUrl: await getQueueUrl(),
        MessageBody: JSON.stringify({ requestId, content, authorId, acceptedAt: Date.now() }),
      }));
      stats.enqueued = (stats.enqueued || 0) + 1;
      const statusUrl = `/api/requests/${requestId}`;
      return res.status(202).location(statusUrl).json({ requestId, status: 'pending', statusUrl });
    }

    const { note } = await insertNote({ content, authorId, idempotencyKey: req.idempotencyKey || null });
    // Навмисно НЕ інвалідуємо кеш списку: застарілість обмежена TTL
    // (див. docs/CACHE.md). Щоб вмикати інвалідацію — CACHE_INVALIDATE_ON_WRITE=true.
    if (redisReady() && process.env.CACHE_INVALIDATE_ON_WRITE === 'true') {
      redis.del(NOTES_LIST_KEY).catch(() => {});
    }
    res.status(201).json(note);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Статус асинхронного запису. Клієнт опитує цей URL з відповіді 202.
app.get('/api/requests/:requestId', async (req, res) => {
  try {
    if (!redisReady()) return res.status(503).json({ error: 'Status store unavailable' });
    const raw = await redis.get(jobKey(req.params.requestId));
    if (!raw) return res.status(404).json({ error: 'Unknown requestId' });
    const job = JSON.parse(raw);
    if (job.status === 'done') res.set('Location', `/api/notes/${job.noteId}`);
    res.json({ requestId: req.params.requestId, ...job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', (req, res) => {
  res.json({ writeMode: WRITE_MODE, cacheEnabled: CACHE_ENABLED, cacheTtl: CACHE_TTL_SECONDS, redisReady: redisReady(), ...stats });
});

// Раз на хвилину пишемо лічильники в журнал у вигляді JSON-рядка,
// щоб у CloudWatch Logs Insights порахувати сумарну частку влучань по всіх екземплярах.
let lastStats = { ...stats };
setInterval(() => {
  const delta = {};
  for (const k of ['cacheHits', 'cacheMisses', 'dbQueries', 'enqueued', 'idemReplays']) {
    delta[k] = (stats[k] || 0) - (lastStats[k] || 0);
  }
  lastStats = { ...stats };
  if (Object.values(delta).some(Boolean)) {
    console.log(JSON.stringify({ type: 'stats', cacheEnabled: CACHE_ENABLED, writeMode: WRITE_MODE, ...delta }));
  }
}, 60000).unref();

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`Server listening on port ${PORT} (write mode: ${WRITE_MODE})`));
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
