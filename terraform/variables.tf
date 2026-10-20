variable "aws_region" {
  type        = string
  default     = "eu-north-1"
}

variable "project_name" {
  type        = string
  default     = "cloud-lab"
}

variable "db_password" {
  type        = string
  sensitive   = true
}

variable "alert_email" {
  type        = string
}

variable "github_repo" {
  type        = string
}
