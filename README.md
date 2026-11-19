# Лабораторна робота 1: Розгортання застосунку в AWS

## Публічна адреса застосунку
* **Base URL:** `http://lab-cloud-alb-1619046838.eu-north-1.elb.amazonaws.com`
* **Swagger UI:** `http://lab-cloud-alb-1619046838.eu-north-1.elb.amazonaws.com/docs`
* **Health Check:** `http://lab-cloud-alb-1619046838.eu-north-1.elb.amazonaws.com/health`

---

## Структура

```text
.
├── .github/workflows/deploy.yaml # CI/CD: збірка образу, пуш в ECR з тегом SHA коміту, оновлення ECS
├── app/
│   ├── Dockerfile                # Docker-образ (node:20.12.2-bookworm-slim, non-root)
│   ├── package.json              # Залежності
│   └── src/index.js              # REST API: JWT, Swagger, PostgreSQL (TLS), кеш Redis, graceful shutdown
├── terraform/
│   ├── main.tf, vpc.tf, rds.tf   # Лаба 1: провайдер, ECR, мережа, RDS у приватних підмережах
│   ├── alb.tf, ecs.tf            # Лаба 1: балансувальник, ECS Fargate, секрети в SSM
│   ├── oidc.tf                   # Лаба 1: доступ CI/CD (OIDC-роль або запасний ключ)
│   ├── autoscaling.tf            # Лаба 2: автомасштабування за CPU, 1–4 задачі
│   ├── dashboard.tf              # Лаба 2: панель CloudWatch
│   ├── monitoring.tf             # Лаба 2: сповіщення на пошту (CPU, 5xx)
│   ├── redis.tf                  # Лаба 2: Redis окремим сервісом Fargate
│   └── bootstrap/                # Бюджет зі сповіщенням (окремий state)
├── loadtest/                     # Лаба 2: сценарій навантаження k6 і результати прогонів
├── docs/                         # Лаба 2: документація і знімки; CICD.md — OIDC і секрети
├── compose.yaml                  # Локальний запуск застосунку з БД і Redis
└── README.md
```

## Запуск

Локально (секрети — у `.env`, шаблон `.env.example`):

```bash
docker compose up --build
```

У AWS (змінні — у `terraform/terraform.tfvars`, див. [docs/CICD.md](docs/CICD.md)):

```bash
terraform -chdir=terraform apply
```

Навантажувальний тест:

```bash
./loadtest/run.sh
```
