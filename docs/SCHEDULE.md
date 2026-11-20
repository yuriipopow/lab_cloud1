# Масштабування за розкладом (бонус 8)

Код: `aws_appautoscaling_scheduled_action.api_day` / `api_night` у [`terraform/autoscaling.tf`](../terraform/autoscaling.tf), змінні `schedule_*`, `day_min_tasks`, `night_min_tasks` у [`terraform/variables.tf`](../terraform/variables.tf).

## Параметри

| | Час (Europe/Kyiv) | Мінімум екземплярів API | Максимум |
|---|---|---|---|
| День | 08:00 → `cron(0 8 * * ? *)` | **2** | 4 |
| Ніч | 22:00 → `cron(0 22 * * ? *)` | **1** | 4 |

Scheduled action змінює лише межі (`min_capacity`), а target tracking за CPU (`docs/AUTOSCALING.md`) і далі додає екземпляри понад мінімум, коли росте навантаження. У Terraform для `aws_appautoscaling_target.api` додано `lifecycle { ignore_changes = [min_capacity] }`, щоб `terraform apply` не «повертав» мінімум, який щойно встановив розклад.

**Чому вдень 2, а не 1.** Один екземпляр — це одна зона доступності і жодного запасу. Якщо він впаде або перезапускатиметься під час деплою, сервіс деградує до появи нового (~1–2 хв). Також за ~3–5 хв, поки спрацює масштабування (`docs/AUTOSCALING.md`), два екземпляри переживуть сплеск без перевантаження. Уночі трафік малий, і ризик простою на ці хвилини прийнятний.

**Чому не 0.** ECS дозволяє `desired_count = 0`, але за ALB без жодного екземпляра всі запити отримають `503`: ECS не запускає задачу «за першим запитом», на відміну від Cloud Run чи Azure Container Apps. Масштабування до нуля в ECS має сенс лише для фонових обробників, наприклад обробника черги, а не для API. Тому холодний старт тут не вимірювався.

## Розрахунок місячної економії

Ціни AWS Fargate, `eu-north-1` (Стокгольм), On-Demand, з AWS Pricing API (2026-11-20):

| Складова | Ціна |
|---|---|
| vCPU | $0,0445 за vCPU-годину |
| Пам'ять | $0,0049 за ГБ-годину |
| Публічна IPv4-адреса задачі (`assign_public_ip = true`) | $0,005 за годину |
| **Одна задача API (0,25 vCPU, 0,5 ГБ) + IPv4** | 0,25 × 0,0445 + 0,5 × 0,0049 + 0,005 = **$0,018575 за годину** |

Місяць ≈ 730 год ≈ 30,4 доби. «День» = 14 год (08–22), «ніч» = 10 год.

| Варіант | Задачо-годин на місяць | Вартість на місяць |
|---|---|---|
| Завжди 1 екземпляр (без резерву вдень) | 730 | $13,56 |
| **Завжди 2** (той самий резерв удень, але й уночі) | 1 460 | **$27,12** |
| **За розкладом**: 2 удень, 1 уночі | (14 × 2 + 10 × 1) × 30,4 ≈ 1 156 | **$21,47** |

**Економія розкладу відносно «завжди 2»: ≈ 304 задачо-години, тобто $5,65 на місяць (−20,8 %).** Для одного маленького сервісу сума невелика, але частка та сама для будь-якого розміру: на 10 сервісах по 1 vCPU це вже ~$200 на місяць. Порівняно з «завжди 1» розклад коштує на $7,91 на місяць більше. Це ціна резерву і другої зони доступності в робочі години.

У розрахунок не входить те, що однакове для всіх варіантів: ALB, RDS, Redis, обробник черги. Також не враховано екземпляри, які target tracking додає під навантаженням, бо вони однакові для всіх варіантів.

## Перевірка

Розклад у хмарі:

```bash
aws application-autoscaling describe-scheduled-actions --service-namespace ecs \
  --query 'ScheduledActions[].[ScheduledActionName,Schedule,Timezone,ScalableTargetAction]'
```

```text
lab-cloud-api-night   cron(0 22 * * ? *)   Europe/Kyiv   min 1   max 4
lab-cloud-api-day     cron(0 8 * * ? *)    Europe/Kyiv   min 2   max 4
```

**Перевірка спрацювання** (2026-11-20). Щоб не чекати до 08:00, розклад тимчасово перевизначено на найближчі хвилини, а потім повернуто:

```bash
terraform -chdir=terraform apply -var 'schedule_day_cron=cron(40 3 * * ? *)' -var 'schedule_night_cron=cron(46 3 * * ? *)'
```

Мінімум і кількість екземплярів API (опитування кожні 20 с, час київський):

```text
03:37:03  min=1  desired/running=1/1
03:40:14  min=2  desired/running=2/1     ← «день»: мінімум 2, ECS запускає другий екземпляр
03:40:56  min=2  desired/running=2/2
03:46:35  min=1  desired/running=2/2     ← «ніч»: мінімум 1
03:46:57  min=1  desired/running=1/1     ← target tracking вилучив зайвий екземпляр
```

Журнал Application Auto Scaling (`aws application-autoscaling describe-scaling-activities`):

```text
03:40:11  Setting min capacity to 2 and max capacity to 4   scheduled action name lab-cloud-api-day was triggered
03:40:11  Setting desired count to 2.                       minimum capacity was set to 2
03:46:17  Setting min capacity to 1 and max capacity to 4   scheduled action name lab-cloud-api-night was triggered
03:46:47  Setting desired count to 1.                       … AlarmLow in state ALARM triggered policy lab-cloud-cpu-target-tracking
```

Видно, як дві політики працюють разом. Scheduled action лише змінює межі: при підвищенні мінімуму кількість одразу піднімається до нього, а при зниженні нічого не вилучає. Вилучає зайвий екземпляр target tracking за CPU. Тут це сталося вже через 30 с, бо `AlarmLow` після нічного простою й так був у стані ALARM, а за звичайних умов це займає до 15 хв. Після перевірки розклад повернуто до 08:00/22:00, і `terraform plan` показує «No changes».
