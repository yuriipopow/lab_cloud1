#!/usr/bin/env bash
# Запуск навантажувального тесту однією командою:
#   ./loadtest/run.sh                               # адреса береться з terraform output
#   ./loadtest/run.sh http://<alb-dns> 60           # явна адреса і кількість VU
#   LABEL=no-cache ./loadtest/run.sh                # назва файлу звіту в loadtest/results/
set -euo pipefail
cd "$(dirname "$0")/.."

BASE_URL="${1:-$(terraform -chdir=terraform output -raw alb_dns_name)}"
VUS="${2:-${VUS:-60}}"
LABEL="${LABEL:-run-$(date +%Y%m%d-%H%M%S)}"

mkdir -p loadtest/results
echo "Target: $BASE_URL  VUs: $VUS  label: $LABEL"
exec k6 run -e BASE_URL="$BASE_URL" -e VUS="$VUS" -e LABEL="$LABEL" loadtest/script.js
