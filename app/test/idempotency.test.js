// Тест ідемпотентності POST /api/notes (лаб. 2, бонус 7).
// Запуск проти локального compose або хмари:
//   BASE_URL=http://localhost:3000 npm test
//   BASE_URL=http://<alb-dns> npm test
// Працює в обох режимах: WRITE_MODE=sync (201) і WRITE_MODE=queue (202 + статус задачі).
//
// «Один запис у базі» перевіряємо через лічильник записів автора (GET /api/authors/:id,
// не кешується): після двох однакових запитів він має зрости рівно на 1.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const AUTHOR_ID = 10; // окремий автор, щоб лічильник змінювали лише ці тести
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let token;
async function getToken() {
  if (!token) token = (await (await fetch(`${BASE_URL}/api/auth/token`, { method: 'POST' })).json()).token;
  return token;
}

async function post(body, key) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${await getToken()}` };
  if (key) headers['Idempotency-Key'] = key;
  const res = await fetch(`${BASE_URL}/api/notes`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, replayed: res.headers.get('idempotent-replayed'), body: await res.json() };
}

async function notesCount() {
  return (await (await fetch(`${BASE_URL}/api/authors/${AUTHOR_ID}`)).json()).notes_count;
}

// У режимі queue чекаємо, поки обробник виконає задачу
async function settle(resp) {
  if (resp.status !== 202) return resp.body.id;
  for (let i = 0; i < 60; i++) {
    const job = await (await fetch(`${BASE_URL}${resp.body.statusUrl}`)).json();
    if (job.status === 'done') return job.noteId;
    await sleep(500);
  }
  throw new Error(`job ${resp.body.requestId} not done in 30 s`);
}

test('два однакові запити з одним Idempotency-Key: один запис у базі, дві однакові відповіді', async () => {
  const key = crypto.randomUUID();
  const body = { content: `idem-test ${key}`, author_id: AUTHOR_ID };
  const before = await notesCount();

  const first = await post(body, key);
  const second = await post(body, key);

  assert.ok([201, 202].includes(first.status), `перший запит: ${first.status}`);
  assert.equal(second.status, first.status, 'однаковий статус');
  assert.deepEqual(second.body, first.body, 'однакове тіло відповіді');
  assert.equal(second.replayed, 'true', 'друга відповідь — збережена (Idempotent-Replayed)');

  await settle(first);
  assert.equal(await notesCount(), before + 1, 'у базі рівно один новий запис');
});

test('той самий ключ з іншим тілом -> 422, нічого не створюється', async () => {
  const key = crypto.randomUUID();
  const first = await post({ content: 'a', author_id: AUTHOR_ID }, key);
  await settle(first);
  const before = await notesCount();
  const other = await post({ content: 'b', author_id: AUTHOR_ID }, key);
  assert.equal(other.status, 422);
  assert.equal(await notesCount(), before);
});

test('одночасні запити з одним ключем: виконується лише один', async () => {
  const key = crypto.randomUUID();
  const body = { content: `idem-concurrent ${key}`, author_id: AUTHOR_ID };
  const before = await notesCount();
  const results = await Promise.all(Array.from({ length: 5 }, () => post(body, key)));
  const ok = results.filter((r) => [201, 202].includes(r.status));
  // Решта — або 409 (ще виконується), або збережена відповідь
  assert.ok(results.every((r) => [201, 202, 409].includes(r.status)), results.map((r) => r.status).join(','));
  assert.ok(ok.length >= 1);
  await settle(ok[0]);
  assert.equal(await notesCount(), before + 1, 'у базі рівно один новий запис');
});

test('контроль: без ключа два запити створюють два записи', async () => {
  const body = { content: 'no-key', author_id: AUTHOR_ID };
  const before = await notesCount();
  const a = await post(body);
  const b = await post(body);
  await settle(a);
  await settle(b);
  assert.equal(await notesCount(), before + 2);
});
