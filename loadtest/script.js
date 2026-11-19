// Сценарій навантаження «мало записів, багато читань» (лаб. 2, завдання 2).
//
// Один віртуальний користувач (VU) у циклі:
//   1 запис  — POST /api/notes
//   9 читань — 4× список, 3× запис за id (включно зі щойно створеним), 2× дані автора
//
// Фази: наростання 0→N за RAMP_UP, стале навантаження N протягом STEADY, спад N→0 за RAMP_DOWN.
// Запуск:  ./loadtest/run.sh http://<alb-dns>  [VUS]
import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const VUS = parseInt(__ENV.VUS || '60', 10);
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

  group('write', () => {
    const r = http.post(
      `${BASE_URL}/api/notes`,
      JSON.stringify({ content: `k6 VU ${__VU} iter ${__ITER}`, author_id: authorId }),
      {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.token}` },
        tags: { name: 'POST /api/notes' },
      }
    );
    check(r, { 'create 201': (x) => x.status === 201 });
    newId = r.status === 201 ? r.json('id') : null;
  });
  think();

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
  const name = __ENV.LABEL || 'run';
  const md =
    `| Показник | Значення |\n|---|---|\n` +
    `| Віртуальних користувачів (N) | ${report.vus} |\n` +
    `| Запитів усього | ${report.requests} |\n` +
    `| Запитів за секунду (середнє) | ${report.rps} |\n` +
    `| Частка помилок | ${report.error_rate_pct} % |\n` +
    `| p50 | ${report.p50_ms} мс |\n| p95 | ${report.p95_ms} мс |\n| p99 | ${report.p99_ms} мс |\n` +
    `| Частка влучань у кеш (GET /api/notes) | ${report.cache_hit_ratio_pct ?? '—'} % |\n`;
  return {
    stdout: `\n${md}\n${JSON.stringify(report, null, 2)}\n`,
    [`loadtest/results/${name}.json`]: JSON.stringify(report, null, 2),
    [`loadtest/results/${name}.md`]: md,
  };
}
