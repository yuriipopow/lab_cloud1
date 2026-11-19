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
