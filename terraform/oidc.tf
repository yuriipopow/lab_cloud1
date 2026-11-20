# Доступ GitHub Actions до AWS через OIDC (без довговічних ключів).
#
# Як це працює: GitHub видає workflow короткоживучий JWT (OIDC-токен) з полями
# iss = token.actions.githubusercontent.com, aud = sts.amazonaws.com,
# sub = repo:<owner>/<repo>:ref:refs/heads/main. Workflow обмінює його в STS
# (AssumeRoleWithWebIdentity) на тимчасові ключі ролі github_deploy (~1 год).
# Trust policy ролі пускає лише токени з нашого репозиторію і гілки main.
#
# use_github_oidc = false — запасний варіант на випадок, якщо SCP організації
# забороняє створювати OIDC-провайдер: окремий IAM-користувач з access key.

data "aws_caller_identity" "current" {}

# Значення claim `sub`, яким довіряє роль (лише гілка main нашого репозиторію).
# GitHub має два формати: класичний `repo:<owner>/<repo>:...` і незмінний
# `repo:<owner>@<owner_id>/<repo>@<repo_id>:...` (use_immutable_subject). Незмінний
# містить числові ID, тому перейменований або перестворений репозиторій з тим самим
# іменем не отримає доступ. Список у StringEquals означає «будь-яке з значень».
locals {
  github_oidc_subjects = compact([
    "repo:${var.github_repo}:ref:refs/heads/main",
    var.github_oidc_immutable_repo == "" ? "" : "repo:${var.github_oidc_immutable_repo}:ref:refs/heads/main",
  ])
}

locals {
  # Мінімальні права для деплою: push у один репозиторій ECR і перезапуск одного сервісу.
  deploy_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "EcrLogin"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid    = "EcrPush"
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
        Sid      = "EcsDeploy"
        Effect   = "Allow"
        Action   = ["ecs:UpdateService", "ecs:DescribeServices"]
        Resource = [aws_ecs_service.main.id, aws_ecs_service.worker.id]
      }
    ]
  })
}

# ---------- Варіант 1 (основний): OIDC + роль ----------
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.use_github_oidc ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

resource "aws_iam_role" "github_deploy" {
  count = var.use_github_oidc ? 1 : 0
  name  = "${var.project_name}-github-deploy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github[0].arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = local.github_oidc_subjects
        }
      }
    }]
  })

  max_session_duration = 3600
}

resource "aws_iam_role_policy" "github_deploy" {
  count  = var.use_github_oidc ? 1 : 0
  name   = "${var.project_name}-deploy-policy"
  role   = aws_iam_role.github_deploy[0].id
  policy = local.deploy_policy
}

# ---------- Варіант 2 (запасний): IAM-користувач з ключем ----------
resource "aws_iam_user" "github_deployer" {
  count = var.use_github_oidc ? 0 : 1
  name  = "${var.project_name}-github-deployer"
}

resource "aws_iam_access_key" "github_deployer_key" {
  count = var.use_github_oidc ? 0 : 1
  user  = aws_iam_user.github_deployer[0].name
}

resource "aws_iam_user_policy" "github_deployer_policy" {
  count  = var.use_github_oidc ? 0 : 1
  name   = "${var.project_name}-deploy-policy"
  user   = aws_iam_user.github_deployer[0].name
  policy = local.deploy_policy
}
