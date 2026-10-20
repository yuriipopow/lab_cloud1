# Лабораторна робота 1: Розгортання застосунку в AWS

## Публічна адреса застосунку
* **Base URL:** `http://lab-cloud-alb-1619046838.eu-north-1.elb.amazonaws.com`
* **Swagger UI:** `http://lab-cloud-alb-1619046838.eu-north-1.elb.amazonaws.com/docs`
* **Health Check:** `http://lab-cloud-alb-1619046838.eu-north-1.elb.amazonaws.com/health`

---

## Структура проєкту
```text
.
├── .github/workflows/deploy.yml # CI/CD пайплайн з тегуванням хешем коміту
├── app/
│   ├── src/index.js             # REST API (Express, JWT Auth, Swagger, PG client)
│   ├── Dockerfile               # Багатошаровий білд, slim-образ, non-root користувач
│   ├── package.json
│   └── .dockerignore
├── terraform/                   # Опис інфраструктури (IaC)
│   ├── main.tf                  # Провайдер AWS та ECR
│   ├── vpc.tf                   # Ізольована мережа, публічні/приватні підмережі, SG
│   ├── rds.tf                   # Керована PostgreSQL у приватній підмережі
│   ├── alb.tf                   # Application Load Balancer з health check
│   ├── ecs.tf                   # Сервіс ECS Fargate
│   ├── oidc.tf                  # Ролі та права для GitHub Actions
│   ├── monitoring.tf            # CloudWatch Logs, SNS та алерт на 5xx помилки
│   ├── variables.tf
│   └── outputs.tf
├── compose.yaml                 # Локальний запуск застосунку з БД через persistent volume
└── README.md
