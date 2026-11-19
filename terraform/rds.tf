resource "aws_db_subnet_group" "main" {
  name       = "${var.project_name}-db-subnet-group"
  subnet_ids = [aws_subnet.private_1.id, aws_subnet.private_2.id]
}

resource "aws_db_instance" "postgres" {
  identifier             = "${var.project_name}-db"
  allocated_storage      = 20
  engine                 = "postgres"
  engine_version         = "16"
  instance_class         = "db.t4g.micro"
  db_name                = "appdb"
  username               = "dbadmin"
  password               = var.db_password
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db_sg.id]
  publicly_accessible    = false
  skip_final_snapshot    = true
  storage_encrypted      = true

  # Щоденні автоматичні бекапи + point-in-time recovery (вікно 1 день — у межах Free Tier).
  # Multi-AZ вимкнено свідомо: подвоює вартість, для навчального стенда не потрібен.
  backup_retention_period  = 1
  multi_az                 = false
  delete_automated_backups = true
}
