output "alb_dns_name" {
  description = "Публічна адреса для перевірки на захисті"
  value       = "http://${aws_lb.main.dns_name}"
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "github_deployer_access_key_id" {
  value       = aws_iam_access_key.github_deployer_key.id
  description = "Access Key ID для GitHub Secrets"
}

output "github_deployer_secret_access_key" {
  value       = aws_iam_access_key.github_deployer_key.secret
  sensitive   = true
  description = "Secret Access Key для GitHub Secrets"
}
