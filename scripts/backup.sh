#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
docker compose exec -T app /app backup
