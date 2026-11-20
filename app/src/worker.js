// Обробник черги (лаб. 2, бонус 6). Той самий образ, що й API, команда: node src/worker.js
//
// Цикл: long polling SQS (до 10 повідомлень, чекати до 20 с) -> для кожного повідомлення
// «тривала операція» (WORKER_PROCESS_MS, імітує, наприклад, модерацію чи індексацію запису)
// -> ідемпотентна вставка в БД -> статус задачі в Redis -> DeleteMessage.
//
// Доставка SQS — «щонайменше один раз»: повідомлення видаляється лише після успішної обробки.
// Якщо обробник впаде або не встигне за VisibilityTimeout, повідомлення стане видимим знову
// і прийде повторно. Дубль у БД не з'явиться: requestId — це UNIQUE idempotency_key рядка.
// Після 5 невдалих спроб повідомлення переходить у DLQ (redrive policy у Terraform).
const { ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const { pool, db, initDb, insertNote, redis, redisReady, sqs, getQueueUrl, JOB_TTL_SECONDS, jobKey } = require('./lib');

const PROCESS_MS = parseInt(process.env.WORKER_PROCESS_MS || '150', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const counters = { processed: 0, duplicates: 0, failed: 0, lagMsSum: 0 };
let stopping = false;

async function handle(message, queueUrl) {
  const msg = JSON.parse(message.Body);
  if (PROCESS_MS > 0) await sleep(PROCESS_MS); // тривала операція

  const { note, duplicate } = await insertNote({
    content: msg.content,
    authorId: Number.isInteger(msg.authorId) ? msg.authorId : 1,
    idempotencyKey: msg.requestId,
  });
  if (duplicate) {
    counters.duplicates++;
    console.log(JSON.stringify({ type: 'duplicate', requestId: msg.requestId, noteId: note.id,
      receiveCount: message.Attributes && message.Attributes.ApproximateReceiveCount }));
  }

  if (redisReady()) {
    await redis.set(jobKey(msg.requestId), JSON.stringify({
      status: 'done', noteId: note.id, acceptedAt: msg.acceptedAt, completedAt: Date.now(),
    }), { EX: JOB_TTL_SECONDS });
  }

  // Видаляємо лише після успіху — інакше повідомлення буде доставлене повторно
  await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
  counters.processed++;
  counters.lagMsSum += Date.now() - (msg.acceptedAt || Date.now());
}

async function loop() {
  while (!db.ready) await sleep(500);
  const queueUrl = await getQueueUrl();
  console.log(`Worker started, queue ${queueUrl}, process ${PROCESS_MS} ms/message`);

  while (!stopping) {
    let out;
    try {
      out = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20,              // long polling: менше порожніх запитів і витрат
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }));
    } catch (err) {
      console.error('ReceiveMessage failed:', err.message);
      await sleep(2000);
      continue;
    }
    // Обробляємо послідовно: один обробник = обмежена пропускна здатність,
    // тому при зростанні потоку записів черга росте і спрацьовує масштабування.
    for (const m of out.Messages || []) {
      try {
        await handle(m, queueUrl);
      } catch (err) {
        counters.failed++;
        console.error('Message processing failed, will be redelivered:', err.message);
      }
    }
  }
}

setInterval(() => {
  if (counters.processed || counters.failed || counters.duplicates) {
    console.log(JSON.stringify({
      type: 'worker_stats', processed: counters.processed, duplicates: counters.duplicates, failed: counters.failed,
      avgLagMs: counters.processed ? Math.round(counters.lagMsSum / counters.processed) : 0,
    }));
  }
  Object.assign(counters, { processed: 0, duplicates: 0, failed: 0, lagMsSum: 0 });
}, 60000).unref();

// Graceful shutdown: перестаємо брати нові повідомлення, дочікуємося поточної пачки.
// Необроблені повідомлення з пачки повернуться в чергу після VisibilityTimeout.
process.on('SIGTERM', () => { console.log('SIGTERM received, finishing current batch'); stopping = true; });
process.on('SIGINT', () => { stopping = true; });

initDb();
loop()
  .catch((err) => { console.error('Worker crashed:', err); process.exitCode = 1; })
  .finally(async () => {
    try { await pool.end(); } catch (e) {}
    try { if (redis) await redis.quit(); } catch (e) {}
    console.log('Worker stopped');
    process.exit();
  });
