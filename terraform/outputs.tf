output "alb_dns_name" {
  description = "Публічна адреса для перевірки на захисті"
  value       = "http://${aws_lb.main.dns_name}"
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "dashboard_url" {
  value = "https://${var.aws_region}.console.aws.amazon.com/cloudwatch/home?region=${var.aws_region}#dashboards/dashboard/${aws_cloudwatch_dashboard.main.dashboard_name}"
}

# Значення для GitHub → Settings → Secrets and variables → Actions → Variables: AWS_ROLE_ARN
output "github_deploy_role_arn" {
  description = "ARN ролі для GitHub Actions (OIDC)"
  value       = var.use_github_oidc ? aws_iam_role.github_deploy[0].arn : null
}

# Лише для запасного варіанта use_github_oidc = false
output "github_deployer_access_key_id" {
  value = var.use_github_oidc ? null : aws_iam_access_key.github_deployer_key[0].id
}

output "github_deployer_secret_access_key" {
  value     = var.use_github_oidc ? null : aws_iam_access_key.github_deployer_key[0].secret
  sensitive = true
}
