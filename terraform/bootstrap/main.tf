# Bootstrap-стек: ресурси, які мають жити довше за основну інфраструктуру.
# Окремий state, тому `terraform destroy` в terraform/ бюджет не видаляє.
#
# Бюджет створено першим у акаунті; щоб узяти його під керування Terraform:
#   terraform -chdir=terraform/bootstrap init
#   terraform -chdir=terraform/bootstrap import aws_budgets_budget.zero_spend 863063109242:"Lab Cloud Zero Spend"
#   terraform -chdir=terraform/bootstrap plan   # має показати "No changes"

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.45"
    }
  }
}

provider "aws" {
  region = "eu-north-1"
}

variable "alert_email" {
  type = string
}

resource "aws_budgets_budget" "zero_spend" {
  name         = "Lab Cloud Zero Spend"
  budget_type  = "COST"
  limit_amount = "5.0"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Лист, щойно фактичні витрати перевищать $0.01 — тобто будь-який платний ресурс
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 0.01
    threshold_type             = "ABSOLUTE_VALUE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }
}
