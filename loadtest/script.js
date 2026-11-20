// Сценарій навантаження «мало записів, багато читань» (лаб. 2, завдання 2).
//
// Один віртуальний користувач (VU) у циклі:
//   1 запис  — POST /api/notes (201; у режимі черги 202 + опитування статусу до POLL_MAX разів)
//   9 читань — 4× список, 3× запис за id (включно зі щойно створеним), 2× дані автора
//
// Фази: наростання 0→N за RAMP_UP, стале навантаження N протягом STEADY, спад N→0 за RAMP_DOWN.
// Запуск:  ./loadtest/run.sh http://<alb-dns>  [VUS]
import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const VUS = parseInt(__ENV.VUS || '100', 10); // N підібрано: при 100 CPU ~82 %, спрацьовує масштабування
const THINK = parseFloat(__ENV.THINK || '0.3'); // пауза між запитами, с

export const options = {
  scenarios: {
    read_heavy: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: __ENV.RAMP_UP || '3m', target: VUS },   // наростання
        { duration: __ENV.STEADY || '5m', target: VUS },    // стале навантаження
        { duration: __ENV.RAMP_DOWN || '2m', target: 0 },   // спад
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const cacheHits = new Counter('cache_hits');
const cacheMisses = new Counter('cache_misses');
// Бонус 6 (WRITE_MODE=queue): POST повертає 202, запис виконує обробник черги.
// write_completion_ms — час від прийняття запиту API до виконання обробником (за серверними мітками).
const writeCompletion = new Trend('write_completion_ms', true);
const asyncNotReady = new Counter('async_not_ready');
const POLL_MAX = parseInt(__ENV.POLL_MAX || '3', 10);

export function setup() {
  const res = http.post(`${BASE_URL}/api/auth/token`);
  check(res, { 'token 200': (r) => r.status === 200 });
  return { token: res.json('token') };
}

function think() {
  sleep(THINK * (0.5 + Math.random())); // 0.5–1.5 × THINK
}

function getList() {
  const r = http.get(`${BASE_URL}/api/notes`, { tags: { name: 'GET /api/notes' } });
  check(r, { 'list 200': (x) => x.status === 200 });
  const xc = r.headers['X-Cache'];
  if (xc === 'HIT') cacheHits.add(1);
  else if (xc === 'MISS') cacheMisses.add(1);
  return r;
}

function getNote(id) {
  const r = http.get(`${BASE_URL}/api/notes/${id}`, { tags: { name: 'GET /api/notes/:id' } });
  check(r, { 'note 200': (x) => x.status === 200 });
}

function getAuthor(id) {
  const r = http.get(`${BASE_URL}/api/authors/${id}`, { tags: { name: 'GET /api/authors/:id' } });
  check(r, { 'author 200': (x) => x.status === 200 });
}

export default function (data) {
  const authorId = 1 + Math.floor(Math.random() * 10);
  let newId;
  let statusUrl = null;

  group('write', () => {
    const r = http.post(
      `${BASE_URL}/api/notes`,
      JSON.stringify({ content: `k6 VU ${__VU} iter ${__ITER}`, author_id: authorId }),
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${data.token}`,
          'Idempotency-Key': `k6-${__VU}-${__ITER}-${Date.now()}-${Math.random()}`,
        },
        tags: { name: 'POST /api/notes' },
      }
    );
    check(r, { 'create 201/202': (x) => x.status === 201 || x.status === 202 });
    if (r.status === 201) newId = r.json('id');
    if (r.status === 202) statusUrl = r.json('statusUrl');
  });
  think();

  // Асинхронний запис: клієнт опитує статус (до POLL_MAX разів), а не чекає на з'єднанні
  if (statusUrl) {
    for (let i = 0; i < POLL_MAX && !newId; i++) {
      const s = http.get(`${BASE_URL}${statusUrl}`, { tags: { name: 'GET /api/requests/:id' } });
      check(s, { 'status 200': (x) => x.status === 200 });
      if (s.status === 200 && s.json('status') === 'done') {
        newId = s.json('noteId');
        writeCompletion.add(s.json('completedAt') - s.json('acceptedAt'));
      } else {
        think();
      }
    }
    if (!newId) asyncNotReady.add(1);
  }

  group('read', () => {
    const list = getList(); think();
    if (newId) { getNote(newId); think(); }           // щойно створений
    let ids = [];
    try { ids = list.json().map((n) => n.id); } catch (e) {}
    const pick = () => (ids.length ? ids[Math.floor(Math.random() * ids.length)] : newId || 1);
    getNote(pick()); think();
    getAuthor(authorId); think();
    getList(); think();
    getNote(pick()); think();
    getList(); think();
    getAuthor(1 + Math.floor(Math.random() * 10)); think();
    getList(); think();
  });
}

// Підсумковий звіт: текст у консоль + JSON у loadtest/results/
export function handleSummary(data) {
  const m = data.metrics;
  const d = m.http_req_duration.values;
  const hits = m.cache_hits ? m.cache_hits.values.count : 0;
  const misses = m.cache_misses ? m.cache_misses.values.count : 0;
  const report = {
    base_url: BASE_URL,
    vus: VUS,
    requests: m.http_reqs.values.count,
    rps: +m.http_reqs.values.rate.toFixed(1),
    error_rate_pct: +(m.http_req_failed.values.rate * 100).toFixed(3),
    p50_ms: +d.med.toFixed(1),
    p95_ms: +d['p(95)'].toFixed(1),
    p99_ms: +d['p(99)'].toFixed(1),
    max_ms: +d.max.toFixed(1),
    iterations: m.iterations.values.count,
    cache_hit_ratio_pct: hits + misses ? +((hits / (hits + misses)) * 100).toFixed(1) : null,
  };
  if (m.write_completion_ms) {
    const w = m.write_completion_ms.values;
    report.async_write_completion_ms = { p50: +w.med.toFixed(0), p95: +w['p(95)'].toFixed(0), max: +w.max.toFixed(0) };
    report.async_not_ready_after_polls = m.async_not_ready ? m.async_not_ready.values.count : 0;
  }
  const name = __ENV.LABEL || 'run';
  const md =
    `| Показник | Значення |\n|---|---|\n` +
    `| Віртуальних користувачів (N) | ${report.vus} |\n` +
    `| Запитів усього | ${report.requests} |\n` +
    `| Запитів за секунду (середнє) | ${report.rps} |\n` +
    `| Частка помилок | ${report.error_rate_pct} % |\n` +
    `| p50 | ${report.p50_ms} мс |\n| p95 | ${report.p95_ms} мс |\n| p99 | ${report.p99_ms} мс |\n` +
    `| Частка влучань у кеш (GET /api/notes) | ${report.cache_hit_ratio_pct ?? '—'} % |\n` +
    (report.async_write_completion_ms
      ? `| Асинхронний запис: від 202 до виконання, p50 / p95 / max | ${report.async_write_completion_ms.p50} / ${report.async_write_completion_ms.p95} / ${report.async_write_completion_ms.max} мс |\n` +
        `| Записів, не готових після ${POLL_MAX} опитувань | ${report.async_not_ready_after_polls} |\n`
      : '');
  return {
    stdout: `\n${md}\n${JSON.stringify(report, null, 2)}\n`,
    [`loadtest/results/${name}.json`]: JSON.stringify(report, null, 2),
    [`loadtest/results/${name}.md`]: md,
  };
}
