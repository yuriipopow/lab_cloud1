# Cloud Lab API — лабораторні роботи 1–2 (AWS)

REST API нотаток на Node.js 22 + Express з PostgreSQL, автентифікацією JWT і документацією Swagger. Працює в AWS (`eu-north-1`) на ECS Fargate за Application Load Balancer. База — RDS PostgreSQL у приватних підмережах, кеш і ключі ідемпотентності — Redis. Запис іде асинхронно через чергу SQS і окремий сервіс-обробник. Уся інфраструктура описана в Terraform.

## Публічна адреса

* **Base URL:** `http://lab-cloud-alb-847085021.eu-north-1.elb.amazonaws.com`
* **Swagger UI:** `http://lab-cloud-alb-847085021.eu-north-1.elb.amazonaws.com/docs`
* **Health check:** `http://lab-cloud-alb-847085021.eu-north-1.elb.amazonaws.com/health`

Адреса змінюється після кожного `terraform apply` з нуля. Актуальну показує `terraform -chdir=terraform output alb_dns_name`.

## Ендпоінти

| Метод | Шлях | Опис |
|---|---|---|
| GET | `/health` | перевірка стану для ALB (503, поки база не готова) |
| POST | `/api/auth/token` | отримати тестовий JWT |
| GET | `/api/notes` | 20 останніх записів (кеш Redis, TTL 30 с) |
| POST | `/api/notes` | створити запис; потрібен JWT (без нього 401). Режим черги: `202` + `statusUrl`; заголовок `Idempotency-Key` — повтор без дубля |
| GET | `/api/requests/{requestId}` | статус асинхронного запису: `pending` або `done` з `noteId` |
| GET | `/api/notes/{id}` | запис за id |
| GET | `/api/authors/{id}` | дані автора |
| GET | `/api/stats` | лічильники кешу і запитів до БД |

## Структура

```text
.
├── .github/workflows/deploy.yaml # CI/CD: збірка образу, пуш в ECR з тегом SHA коміту, оновлення ECS
├── app/
│   ├── Dockerfile                # Docker-образ (node:22.23.4-bookworm-slim, non-root)
│   ├── package.json              # Залежності; npm test — тест ідемпотентності
│   ├── src/index.js              # REST API: JWT, Swagger, кеш Redis, Idempotency-Key, запис у чергу, graceful shutdown
│   ├── src/worker.js             # Обробник черги SQS (той самий образ, інша команда)
│   ├── src/lib.js                # Спільне: PostgreSQL (TLS), Redis, SQS, ідемпотентна вставка
│   └── test/                     # Тест ідемпотентності (node:test)
├── terraform/
│   ├── main.tf, vpc.tf, rds.tf   # Лаба 1: провайдер, ECR, мережа, RDS у приватних підмережах
│   ├── alb.tf, ecs.tf            # Лаба 1: балансувальник, ECS Fargate, секрети в SSM Parameter Store
│   ├── oidc.tf                   # Лаба 1: OIDC-провайдер GitHub і роль для CI/CD (без ключів)
│   ├── autoscaling.tf            # Лаба 2: автомасштабування за CPU 60 %, 1–4 задачі; розклад день/ніч
│   ├── dashboard.tf              # Лаба 2: панель CloudWatch
│   ├── monitoring.tf             # Лаба 2: сповіщення на пошту (CPU > 70 %, 5xx)
│   ├── redis.tf                  # Лаба 2: Redis окремим сервісом Fargate
│   ├── queue.tf                  # Бонус: SQS + DLQ, сервіс-обробник, масштабування від довжини черги
│   └── bootstrap/                # Бюджет зі сповіщенням (окремий state, переживає destroy)
├── loadtest/                     # Лаба 2: сценарій навантаження k6 і результати прогонів
├── docs/                         # Лаба 2: AUTOSCALING, LOADTEST, ALERTS, CACHE; бонуси: QUEUE, IDEMPOTENCY, SCHEDULE; знімки (img/)
├── compose.yaml                  # Локальний запуск: API, обробник, PostgreSQL, Redis, ElasticMQ (локальна SQS)
├── .env.example                  # Шаблон локальних секретів
└── README.md
```

## Запуск

Локально (спершу `cp .env.example .env`):

```bash
docker compose up --build
```

В AWS (змінні `db_password`, `jwt_secret`, `alert_email`, `github_repo`, `github_oidc_immutable_repo` — у `terraform/terraform.tfvars`, який у `.gitignore`; після `apply` у GitHub потрібна змінна `AWS_ROLE_ARN` = `terraform -chdir=terraform output -raw github_deploy_role_arn`):

```bash
terraform -chdir=terraform apply
```

Навантажувальний тест:

```bash
./loadtest/run.sh
```

Тест ідемпотентності (локально або проти хмари):

```bash
cd app && BASE_URL=http://localhost:3000 npm test
```

Видалення всіх ресурсів:

```bash
terraform -chdir=terraform destroy
```
