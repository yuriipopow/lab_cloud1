# Асинхронний запис через чергу (лаб. 2, бонус 6). Опис — docs/QUEUE.md.
#
# API (WRITE_MODE=queue) кладе повідомлення в SQS і відповідає 202 Accepted.
# Окремий сервіс-обробник читає чергу, виконує запис у БД і пише статус у Redis.
# Обробник масштабується від довжини черги на одного обробника.

# ---------- Черги ----------
# Dead-letter queue: сюди потрапляють повідомлення, які не вдалося обробити 5 разів
resource "aws_sqs_queue" "writes_dlq" {
  name                      = "${var.project_name}-writes-dlq"
  message_retention_seconds = 1209600 # 14 днів — час розібратися з «отруйними» повідомленнями
}

resource "aws_sqs_queue" "writes" {
  name = "${var.project_name}-writes"
  # Скільки повідомлення невидиме для інших обробників після отримання.
  # Має бути більшим за час обробки пачки (10 × WORKER_PROCESS_MS + запис у БД).
  visibility_timeout_seconds = 60
  receive_wait_time_seconds  = 20     # long polling за замовчуванням
  message_retention_seconds  = 345600 # 4 дні

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.writes_dlq.arn
    maxReceiveCount     = 5
  })
}

# ---------- Ролі задач (права самого застосунку) ----------
data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# API може лише класти повідомлення в одну чергу
resource "aws_iam_role" "api_task" {
  name               = "${var.project_name}-api-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "api_task_sqs" {
  name = "send-to-writes-queue"
  role = aws_iam_role.api_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:SendMessage", "sqs:GetQueueUrl"]
      Resource = aws_sqs_queue.writes.arn
    }]
  })
}

# Обробник може лише читати й видаляти повідомлення з цієї черги
resource "aws_iam_role" "worker_task" {
  name               = "${var.project_name}-worker-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "worker_task_sqs" {
  name = "consume-writes-queue"
  role = aws_iam_role.worker_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes", "sqs:GetQueueUrl"]
      Resource = aws_sqs_queue.writes.arn
    }]
  })
}

# ---------- Сервіс-обробник ----------
resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.project_name}-worker"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.ecs_execution_role.arn
  task_role_arn            = aws_iam_role.worker_task.arn

  container_definitions = jsonencode([{
    name      = "worker"
    image     = "${aws_ecr_repository.app.repository_url}:${var.image_tag}" # той самий образ, що й API
    essential = true
    command   = ["node", "src/worker.js"]
    # Після SIGTERM обробник дочитує поточну пачку; long polling триває до 20 с
    stopTimeout = 30
    environment = concat(local.app_common_env, [
      # Імітація тривалої операції на одне повідомлення (мс)
      { name = "WORKER_PROCESS_MS", value = tostring(var.worker_process_ms) },
    ])
    secrets = [
      { name = "DB_PASSWORD", valueFrom = aws_ssm_parameter.db_password.arn },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.ecs.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "worker"
      }
    }
  }])
}

# Обробнику потрібні лише вихідні з'єднання (SQS, RDS, Redis), вхідних немає
resource "aws_security_group" "worker_sg" {
  name   = "${var.project_name}-worker-sg"
  vpc_id = aws_vpc.main.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# Доступ обробника до RDS і Redis — у вбудованих правилах db_sg (vpc.tf) і redis_sg (redis.tf):
# «від SG обробника», не від IP. Окремі aws_security_group_rule конфліктували б із вбудованими.

resource "aws_ecs_service" "worker" {
  name            = "${var.project_name}-worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_min_tasks
  launch_type     = "FARGATE"

  network_configuration {
    # Публічні підмережі лише заради виходу в інтернет без NAT (ECR, SQS);
    # вхідних правил у SG немає, тож ззовні обробник недоступний
    subnets          = [aws_subnet.public_1.id, aws_subnet.public_2.id]
    security_groups  = [aws_security_group.worker_sg.id]
    assign_public_ip = true
  }

  lifecycle {
    ignore_changes = [desired_count] # керує Application Auto Scaling
  }
}

# ---------- Масштабування обробника від довжини черги ----------
resource "aws_appautoscaling_target" "worker" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.worker.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.worker_min_tasks
  max_capacity       = var.worker_max_tasks
}

# Target tracking за «backlog per task» = видимих повідомлень / працюючих обробників.
# Ціль worker_backlog_target повідомлень на обробник: при ~6–7 повідомленнях/с на обробник
# 50 повідомлень у черзі — це ~8 с очікування. Більше — додаємо обробників.
resource "aws_appautoscaling_policy" "worker_backlog" {
  name               = "${var.project_name}-worker-backlog"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.worker.service_namespace
  resource_id        = aws_appautoscaling_target.worker.resource_id
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = var.worker_backlog_target
    scale_out_cooldown = 60
    scale_in_cooldown  = 120

    customized_metric_specification {
      metrics {
        id          = "visible"
        label       = "Повідомлень у черзі"
        return_data = false
        metric_stat {
          stat = "Sum"
          metric {
            namespace   = "AWS/SQS"
            metric_name = "ApproximateNumberOfMessagesVisible"
            dimensions {
              name  = "QueueName"
              value = aws_sqs_queue.writes.name
            }
          }
        }
      }
      metrics {
        id          = "workers"
        label       = "Працюючих обробників"
        return_data = false
        metric_stat {
          stat = "Average"
          metric {
            namespace   = "ECS/ContainerInsights"
            metric_name = "RunningTaskCount"
            dimensions {
              name  = "ClusterName"
              value = aws_ecs_cluster.main.name
            }
            dimensions {
              name  = "ServiceName"
              value = aws_ecs_service.worker.name
            }
          }
        }
      }
      metrics {
        id          = "backlog"
        label       = "Повідомлень на одного обробника"
        expression  = "visible / workers"
        return_data = true
      }
    }
  }
}
