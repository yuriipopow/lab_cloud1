variable "aws_region" {
  type    = string
  default = "eu-north-1"
}

variable "project_name" {
  type    = string
  default = "cloud-lab"
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "alert_email" {
  type = string
}

variable "github_repo" {
  type = string
}

variable "jwt_secret" {
  type      = string
  sensitive = true
}

# ---------- Лаб. 2 ----------
variable "min_tasks" {
  type    = number
  default = 1
}

variable "max_tasks" {
  type    = number
  default = 4
  validation {
    condition     = var.max_tasks <= 4
    error_message = "За умовами лабораторної максимум — 4 екземпляри."
  }
}

variable "cpu_target" {
  description = "Цільове середнє завантаження CPU для target tracking, %"
  type        = number
  default     = 60
}

variable "cpu_alarm_threshold" {
  type    = number
  default = 70
}

variable "cache_enabled" {
  description = "Увімкнути cache-aside для GET /api/notes"
  type        = bool
  default     = true
}

variable "cache_ttl_seconds" {
  type    = number
  default = 30
}

variable "image_tag" {
  description = "Тег образу в ECR. CI оновлює latest; для відкату — terraform apply -var image_tag=<commit sha>"
  type        = string
  default     = "latest"
}

variable "use_github_oidc" {
  description = "true — GitHub Actions через OIDC-роль; false — запасний IAM-користувач з ключем"
  type        = bool
  default     = true
}

variable "github_oidc_immutable_repo" {
  description = "Незмінний ідентифікатор репозиторію для OIDC sub: <owner>@<owner_id>/<repo>@<repo_id> (gh api repos/<owner>/<repo>/actions/oidc/customization/sub)"
  type        = string
  default     = ""
}

# ---------- Бонус 6: черга ----------
variable "write_mode" {
  description = "sync — POST пише в БД одразу (201); queue — через SQS і обробник (202)"
  type        = string
  default     = "queue"
  validation {
    condition     = contains(["sync", "queue"], var.write_mode)
    error_message = "write_mode: sync або queue."
  }
}

variable "worker_process_ms" {
  description = "Імітація тривалої операції в обробнику, мс на повідомлення"
  type        = number
  default     = 150
}

variable "worker_min_tasks" {
  type    = number
  default = 1
}

variable "worker_max_tasks" {
  type    = number
  default = 4
  validation {
    condition     = var.worker_max_tasks <= 4
    error_message = "За умовами лабораторної максимум — 4 екземпляри."
  }
}

variable "worker_backlog_target" {
  description = "Цільова кількість повідомлень у черзі на одного обробника"
  type        = number
  default     = 50
}

# ---------- Бонус 8: розклад ----------
variable "schedule_enabled" {
  type    = bool
  default = true
}

variable "schedule_timezone" {
  type    = string
  default = "Europe/Kyiv"
}

variable "schedule_day_cron" {
  description = "Початок «дня»: мінімум day_min_tasks (Application Auto Scaling cron, 6 полів)"
  type        = string
  default     = "cron(0 8 * * ? *)"
}

variable "schedule_night_cron" {
  description = "Початок «ночі»: мінімум night_min_tasks"
  type        = string
  default     = "cron(0 22 * * ? *)"
}

variable "day_min_tasks" {
  type    = number
  default = 2
}

variable "night_min_tasks" {
  type    = number
  default = 1
}
