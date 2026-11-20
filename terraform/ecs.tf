resource "aws_ecs_cluster" "main" {
  name = "${var.project_name}-cluster"

  # Лог-група Container Insights має існувати до кластера, інакше AWS створить
  # її сам і вона залишиться після terraform destroy.
  depends_on = [time_sleep.container_insights_drain]

  # Потрібно для метрик RunningTaskCount / DesiredTaskCount у ECS/ContainerInsights
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_iam_role" "ecs_execution_role" {
  name = "${var.project_name}-ecs-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ---------- Секрети: SSM Parameter Store (SecureString, шифрування KMS) ----------
# Значення приходять з terraform.tfvars (у .gitignore). У task definition потрапляє
# лише ARN параметра; ECS agent розшифровує його ролю виконання при старті контейнера.
resource "aws_ssm_parameter" "db_password" {
  name  = "/${var.project_name}/db_password"
  type  = "SecureString"
  value = var.db_password
}

resource "aws_ssm_parameter" "jwt_secret" {
  name  = "/${var.project_name}/jwt_secret"
  type  = "SecureString"
  value = var.jwt_secret
}

# Найменші привілеї: роль виконання читає лише ці два параметри
resource "aws_iam_role_policy" "ecs_execution_ssm" {
  name = "${var.project_name}-read-app-secrets"
  role = aws_iam_role.ecs_execution_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssm:GetParameters"]
      Resource = [aws_ssm_parameter.db_password.arn, aws_ssm_parameter.jwt_secret.arn]
    }]
  })
}

# Змінні середовища, спільні для API і обробника черги
locals {
  app_common_env = [
    { name = "DB_HOST", value = aws_db_instance.postgres.address },
    { name = "DB_PORT", value = "5432" },
    { name = "DB_NAME", value = "appdb" },
    { name = "DB_USER", value = "dbadmin" },
    { name = "DB_SSL", value = "true" },
    { name = "REDIS_URL", value = "redis://${aws_service_discovery_service.redis.name}.${aws_service_discovery_private_dns_namespace.main.name}:6379" },
    { name = "AWS_REGION", value = var.aws_region },
    { name = "SQS_QUEUE_URL", value = aws_sqs_queue.writes.url },
  ]
}

resource "aws_ecs_task_definition" "app" {
  family                   = "${var.project_name}-task"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.ecs_execution_role.arn
  # Роль самого застосунку (не плутати з execution role, яка тягне образ і секрети):
  # дає право класти повідомлення в чергу SQS. Ключів у контейнері немає.
  task_role_arn = aws_iam_role.api_task.arn

  container_definitions = jsonencode([{
    name      = "api"
    image     = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
    essential = true
    portMappings = [{
      containerPort = 3000
      hostPort      = 3000
    }]
    # Скільки ECS чекає після SIGTERM до SIGKILL (graceful shutdown)
    stopTimeout = 30
    environment = concat(local.app_common_env, [
      { name = "PORT", value = "3000" },
      { name = "CACHE_ENABLED", value = tostring(var.cache_enabled) },
      { name = "CACHE_TTL_SECONDS", value = tostring(var.cache_ttl_seconds) },
      # Бонус 6: sync — запис у БД одразу (201); queue — через SQS (202)
      { name = "WRITE_MODE", value = var.write_mode },
    ])
    secrets = [
      { name = "DB_PASSWORD", valueFrom = aws_ssm_parameter.db_password.arn },
      { name = "JWT_SECRET", valueFrom = aws_ssm_parameter.jwt_secret.arn }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.ecs.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "ecs"
      }
    }
  }])
}

resource "aws_ecs_service" "main" {
  name            = "${var.project_name}-service"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.min_tasks
  launch_type     = "FARGATE"

  # Новий екземпляр не вважається «поганим», поки застосунок стартує
  health_check_grace_period_seconds = 30

  network_configuration {
    subnets          = [aws_subnet.public_1.id, aws_subnet.public_2.id]
    security_groups  = [aws_security_group.ecs_sg.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "api"
    container_port   = 3000
  }

  # desired_count керує Application Auto Scaling; без цього кожен terraform apply
  # скидав би кількість екземплярів назад до min_tasks.
  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener.http]
}
