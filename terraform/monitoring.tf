resource "aws_cloudwatch_log_group" "ecs" {
  name              = "/ecs/${var.project_name}"
  retention_in_days = 7
}

# Container Insights пише сюди метрики продуктивності (RunningTaskCount тощо).
# Описана в Terraform, щоб terraform destroy її видаляв.
resource "aws_cloudwatch_log_group" "container_insights" {
  name              = "/aws/ecs/containerinsights/${var.project_name}-cluster/performance"
  retention_in_days = 1
}

# Після видалення кластера ECS ще кілька секунд дописує телеметрію задач, що
# зупиняються, і сам заново створює лог-групу. Порядок при destroy:
# кластер -> пауза 90 с -> лог-група, тому після destroy нічого не залишається.
resource "time_sleep" "container_insights_drain" {
  depends_on       = [aws_cloudwatch_log_group.container_insights]
  destroy_duration = "90s"
}

# ---------- Канал доставки сповіщень ----------
resource "aws_sns_topic" "alerts" {
  name = "${var.project_name}-alerts"
}

# Після apply AWS надсилає лист «Subscription Confirmation» — без підтвердження
# листи-сповіщення не доставлятимуться.
resource "aws_sns_topic_subscription" "email_sub" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# ---------- Сповіщення про надмірне навантаження (лаб. 2, завдання 4) ----------
# CPU > 70 % протягом 2 хвилин поспіль. alarm_actions -> лист «ALARM»,
# ok_actions -> лист «OK» при поверненні до норми.
resource "aws_cloudwatch_metric_alarm" "cpu_high" {
  alarm_name          = "${var.project_name}-api-cpu-high"
  alarm_description   = "Середнє завантаження CPU сервісу API > ${var.cpu_alarm_threshold}% протягом 2 хвилин"
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = var.cpu_alarm_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.main.name
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

# Сповіщення з лаб. 1 про помилки 5xx
resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${var.project_name}-high-5xx-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
  }
}
