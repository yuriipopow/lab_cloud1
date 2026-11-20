// Спільне для API (index.js) і обробника черги (worker.js):
// пул PostgreSQL, клієнт Redis, клієнт SQS, створення схеми й ідемпотентна вставка запису.
const fs = require('fs');
const { Pool } = require('pg');
const { createClient } = require('redis');
const { SQSClient, CreateQueueCommand } = require('@aws-sdk/client-sqs');

const stats = { cacheHits: 0, cacheMisses: 0, dbQueries: 0 };

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
    ? { ca: fs.readFileSync(process.env.DB_SSL_CA || '/opt/certs/rds-global-bundle.pem', 'utf8') }
    : false,
});

async function dbQuery(text, params) {
  stats.dbQueries++;
  return pool.query(text, params);
}

// Повторні спроби: БД може ще стартувати, а кілька екземплярів можуть
// одночасно виконувати CREATE TABLE IF NOT EXISTS (гонка в каталозі PostgreSQL).
const db = { ready: false };
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
      -- Лаб. 2, бонус 6–7: унікальний ключ операції запису. NULL не конфліктують між собою,
      -- тож записи без ключа створюються як раніше.
      ALTER TABLE notes ADD COLUMN IF NOT EXISTS idempotency_key TEXT UNIQUE;
      INSERT INTO authors (id, name, bio)
        SELECT g, 'Автор ' || g, 'Тестовий автор #' || g FROM generate_series(1, 10) g
        ON CONFLICT (id) DO NOTHING;
      SELECT setval('authors_id_seq', GREATEST((SELECT MAX(id) FROM authors), 1));
    `);
    db.ready = true;
    console.log('Database initialized');
  } catch (err) {
    console.error(`Database init error (attempt ${attempt}):`, err.message);
    if (attempt < 10) setTimeout(() => initDb(attempt + 1), 3000);
  }
}

// Ідемпотентна вставка: другий INSERT з тим самим idempotency_key не створює новий рядок,
// а повертає вже наявний. (xmax = 0) — рядок щойно вставлено; інакше спрацював ON CONFLICT.
async function insertNote({ content, authorId, idempotencyKey = null }) {
  const { rows } = await dbQuery(
    `INSERT INTO notes (content, author_id, idempotency_key) VALUES ($1, $2, $3)
     ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
     RETURNING id, content, created_at, author_id, (xmax = 0) AS inserted;`,
    [content || 'Новий запис', authorId, idempotencyKey]
  );
  const { inserted, ...note } = rows[0];
  return { note, duplicate: !inserted };
}

// Redis — спільний для всіх екземплярів: кеш списку, ключі ідемпотентності, статуси задач.
let redis = null;
if (process.env.REDIS_URL) {
  redis = createClient({
    url: process.env.REDIS_URL,
    socket: { connectTimeout: 2000, reconnectStrategy: (n) => Math.min(n * 200, 2000) },
  });
  redis.on('error', (err) => console.error('Redis error:', err.message));
  redis.connect().then(() => console.log('Redis connected')).catch(() => {});
}
const redisReady = () => !!(redis && redis.isReady);

// SQS: у хмарі — URL черги з Terraform і права з ролі задачі ECS;
// локально — ElasticMQ (SQS-сумісний), черга створюється при старті.
const sqs = new SQSClient({
  region: process.env.AWS_REGION || 'eu-north-1',
  ...(process.env.SQS_ENDPOINT ? { endpoint: process.env.SQS_ENDPOINT } : {}),
});
let queueUrl = process.env.SQS_QUEUE_URL || null;
async function getQueueUrl() {
  if (queueUrl) return queueUrl;
  const out = await sqs.send(new CreateQueueCommand({
    QueueName: process.env.SQS_QUEUE_NAME || 'notes-writes',
    Attributes: { VisibilityTimeout: '60' },
  }));
  queueUrl = out.QueueUrl;
  return queueUrl;
}

const JOB_TTL_SECONDS = 24 * 60 * 60;
const jobKey = (requestId) => `job:${requestId}`;

module.exports = {
  stats, pool, dbQuery, db, initDb, insertNote,
  redis, redisReady, sqs, getQueueUrl, JOB_TTL_SECONDS, jobKey,
};
