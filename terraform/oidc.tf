# Окремий користувач виключно для деплою з GitHub Actions
resource "aws_iam_user" "github_deployer" {
  name = "${var.project_name}-github-deployer"
}

resource "aws_iam_access_key" "github_deployer_key" {
  user = aws_iam_user.github_deployer.name
}

resource "aws_iam_user_policy" "github_deployer_policy" {
  name = "${var.project_name}-deploy-policy"
  user = aws_iam_user.github_deployer.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:PutImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload"
        ]
        Resource = aws_ecr_repository.app.arn
      },
      {
        Effect   = "Allow"
        Action   = [
          "ecs:UpdateService",
          "ecs:DescribeServices"
        ]
        Resource = aws_ecs_service.main.id
      }
    ]
  })
}
