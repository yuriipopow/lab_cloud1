# Панель моніторингу (лаб. 2, завдання 3): CloudWatch → Dashboards → <project>-dashboard

locals {
  ecs_dims = ["ClusterName", aws_ecs_cluster.main.name, "ServiceName", aws_ecs_service.main.name]
  alb_dim  = ["LoadBalancer", aws_lb.main.arn_suffix]
}

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "${var.project_name}-dashboard"

  dashboard_body = jsonencode({
    start          = "-PT1H"
    periodOverride = "inherit"
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "1. Кількість екземплярів (бажана / фактична)"
          region = var.aws_region
          view   = "timeSeries"
          stat   = "Maximum"
          period = 60
          metrics = [
            concat(["ECS/ContainerInsights", "DesiredTaskCount"], local.ecs_dims, [{ label = "Desired" }]),
            concat(["ECS/ContainerInsights", "RunningTaskCount"], local.ecs_dims, [{ label = "Running" }]),
          ]
          yAxis = { left = { min = 0, max = var.max_tasks + 1 } }
          annotations = {
            horizontal = [{ label = "max", value = var.max_tasks }]
          }
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "2. Завантаження CPU і пам'яті, %"
          region = var.aws_region
          view   = "timeSeries"
          period = 60
          metrics = [
            concat(["AWS/ECS", "CPUUtilization"], local.ecs_dims, [{ stat = "Average", label = "CPU avg" }]),
            concat(["AWS/ECS", "CPUUtilization"], local.ecs_dims, [{ stat = "Maximum", label = "CPU max" }]),
            concat(["AWS/ECS", "MemoryUtilization"], local.ecs_dims, [{ stat = "Average", label = "Memory avg" }]),
          ]
          yAxis = { left = { min = 0, max = 100 } }
          annotations = {
            horizontal = [
              { label = "Ціль масштабування ${var.cpu_target}%", value = var.cpu_target },
              { label = "Поріг сповіщення ${var.cpu_alarm_threshold}%", value = var.cpu_alarm_threshold, color = "#d62728" },
            ]
          }
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 8
        height = 6
        properties = {
          title  = "3. Запити за хвилину"
          region = var.aws_region
          view   = "timeSeries"
          stat   = "Sum"
          period = 60
          metrics = [
            concat(["AWS/ApplicationELB", "RequestCount"], local.alb_dim, [{ label = "Requests / min" }]),
          ]
          yAxis = { left = { min = 0 } }
        }
      },
      {
        type   = "metric"
        x      = 8
        y      = 6
        width  = 8
        height = 6
        properties = {
          title  = "4. Латентність p95, с"
          region = var.aws_region
          view   = "timeSeries"
          stat   = "p95"
          period = 60
          metrics = [
            concat(["AWS/ApplicationELB", "TargetResponseTime"], local.alb_dim, [{ label = "p95" }]),
          ]
          yAxis = { left = { min = 0 } }
          annotations = {
            horizontal = [{ label = "500 мс", value = 0.5 }]
          }
        }
      },
      {
        type   = "metric"
        x      = 16
        y      = 6
        width  = 8
        height = 6
        properties = {
          title  = "5. Відповіді 5xx"
          region = var.aws_region
          view   = "timeSeries"
          stat   = "Sum"
          period = 60
          metrics = [
            concat(["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count"], local.alb_dim, [{ label = "5xx від застосунку" }]),
            concat(["AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count"], local.alb_dim, [{ label = "5xx від ALB" }]),
          ]
          yAxis = { left = { min = 0 } }
        }
      },
      # ---------- Бонус 6: черга і обробник ----------
      {
        type   = "metric"
        x      = 0
        y      = 12
        width  = 8
        height = 6
        properties = {
          title  = "6. Черга: повідомлень і вік найстарішого"
          region = var.aws_region
          view   = "timeSeries"
          period = 60
          metrics = [
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.writes.name, { stat = "Maximum", label = "У черзі" }],
            ["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", aws_sqs_queue.writes.name, { stat = "Maximum", label = "Вік найстарішого, с", yAxis = "right" }],
          ]
          yAxis = { left = { min = 0 }, right = { min = 0 } }
        }
      },
      {
        type   = "metric"
        x      = 8
        y      = 12
        width  = 8
        height = 6
        properties = {
          title  = "7. Обробники черги (бажана / фактична)"
          region = var.aws_region
          view   = "timeSeries"
          stat   = "Maximum"
          period = 60
          metrics = [
            ["ECS/ContainerInsights", "DesiredTaskCount", "ClusterName", aws_ecs_cluster.main.name, "ServiceName", aws_ecs_service.worker.name, { label = "Desired" }],
            ["ECS/ContainerInsights", "RunningTaskCount", "ClusterName", aws_ecs_cluster.main.name, "ServiceName", aws_ecs_service.worker.name, { label = "Running" }],
          ]
          yAxis = { left = { min = 0, max = var.worker_max_tasks + 1 } }
        }
      },
      {
        type   = "metric"
        x      = 16
        y      = 12
        width  = 8
        height = 6
        properties = {
          title  = "8. Записи через чергу за хвилину: надіслано / оброблено"
          region = var.aws_region
          view   = "timeSeries"
          stat   = "Sum"
          period = 60
          metrics = [
            ["AWS/SQS", "NumberOfMessagesSent", "QueueName", aws_sqs_queue.writes.name, { label = "Надіслано (API)" }],
            ["AWS/SQS", "NumberOfMessagesDeleted", "QueueName", aws_sqs_queue.writes.name, { label = "Оброблено (обробник)" }],
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.writes_dlq.name, { stat = "Maximum", label = "У DLQ" }],
          ]
          yAxis = { left = { min = 0 } }
        }
      },
      {
        type   = "alarm"
        x      = 0
        y      = 18
        width  = 24
        height = 2
        properties = {
          title  = "Стан сповіщень"
          alarms = [aws_cloudwatch_metric_alarm.cpu_high.arn, aws_cloudwatch_metric_alarm.alb_5xx.arn]
        }
      },
    ]
  })
}
