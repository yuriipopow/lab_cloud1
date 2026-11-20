# Спільний Redis для всіх екземплярів API (лаб. 2, завдання 5): кеш списку,
# а також ключі ідемпотентності і статуси асинхронних задач (бонуси 6–7).
# volatile-lru: при нестачі пам'яті витісняються лише ключі з TTL (у нас — усі).
# Замість платного ElastiCache — окремий Fargate-сервіс з образом redis:7-alpine,
# доступний у VPC за DNS-іменем redis.<project>.local (AWS Cloud Map).

resource "aws_service_discovery_private_dns_namespace" "main" {
  name = "${var.project_name}.local"
  vpc  = aws_vpc.main.id
}

resource "aws_service_discovery_service" "redis" {
  name = "redis"

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.main.id
    routing_policy = "MULTIVALUE"
    dns_records {
      ttl  = 10
      type = "A"
    }
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}

resource "aws_security_group" "redis_sg" {
  name   = "${var.project_name}-redis-sg"
  vpc_id = aws_vpc.main.id

  # Доступ до Redis лише з контейнерів API
  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_sg.id, aws_security_group.worker_sg.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_ecs_task_definition" "redis" {
  family                   = "${var.project_name}-redis"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.ecs_execution_role.arn

  container_definitions = jsonencode([{
    name = "redis"
    # Публічна галерея ECR — без лімітів Docker Hub на завантаження
    image     = "public.ecr.aws/docker/library/redis:7-alpine"
    essential = true
    command   = ["redis-server", "--save", "", "--appendonly", "no", "--maxmemory", "128mb", "--maxmemory-policy", "volatile-lru"]
    portMappings = [{
      containerPort = 6379
      hostPort      = 6379
    }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.ecs.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "redis"
      }
    }
  }])
}

resource "aws_ecs_service" "redis" {
  name            = "${var.project_name}-redis"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.redis.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    # Публічні підмережі лише тому, що в VPC немає NAT (для завантаження образу).
    # Ззовні Redis недоступний: SG пускає тільки трафік від API.
    subnets          = [aws_subnet.public_1.id, aws_subnet.public_2.id]
    security_groups  = [aws_security_group.redis_sg.id]
    assign_public_ip = true
  }

  service_registries {
    registry_arn = aws_service_discovery_service.redis.arn
  }
}
