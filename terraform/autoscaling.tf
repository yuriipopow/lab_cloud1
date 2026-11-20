# Автоматичне горизонтальне масштабування сервісу API (лаб. 2, завдання 1).
# Обґрунтування параметрів — docs/AUTOSCALING.md.

resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.main.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.min_tasks
  max_capacity       = var.max_tasks

  # Мінімум удень і вночі змінюють scheduled actions нижче (бонус 8), тож Terraform
  # не повинен «повертати» min_capacity при кожному apply.
  lifecycle {
    ignore_changes = [min_capacity]
  }
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${var.project_name}-cpu-target-tracking"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }

    target_value = var.cpu_target

    # Після додавання екземпляра — 60 с не додаємо наступний, поки новий
    # не почне приймати трафік і не вплине на середнє завантаження.
    scale_out_cooldown = 60
    # Після вилучення — 180 с не вилучаємо наступний, щоб не «пиляти» туди-сюди.
    scale_in_cooldown = 180

    disable_scale_in = false
  }
}

# ---------- Масштабування за розкладом (лаб. 2, бонус 8). Розрахунок — docs/SCHEDULE.md ----------
# Удень (робочий трафік) тримаємо щонайменше 2 екземпляри: запас на піки і відмовостійкість
# у двох зонах доступності. Уночі — 1. Target tracking за CPU працює поверх цього мінімуму.
# До нуля не масштабуємо: сервіс за ALB без жодного екземпляра віддає 503, а ECS не стартує
# задачу «за першим запитом» (на відміну від Cloud Run / Container Apps).
resource "aws_appautoscaling_scheduled_action" "api_day" {
  count              = var.schedule_enabled ? 1 : 0
  name               = "${var.project_name}-api-day"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  schedule           = var.schedule_day_cron
  timezone           = var.schedule_timezone

  scalable_target_action {
    min_capacity = var.day_min_tasks
    max_capacity = var.max_tasks
  }
}

resource "aws_appautoscaling_scheduled_action" "api_night" {
  count              = var.schedule_enabled ? 1 : 0
  name               = "${var.project_name}-api-night"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  schedule           = var.schedule_night_cron
  timezone           = var.schedule_timezone

  scalable_target_action {
    min_capacity = var.night_min_tasks
    max_capacity = var.max_tasks
  }
}
