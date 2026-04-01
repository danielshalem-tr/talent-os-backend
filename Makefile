# Triolla Talent OS — Developer Workflow
# Usage: make <target>
# Requires: Docker, Docker Compose

.PHONY: up down reset seed logs test backup restore ngrok help

# Default target — show help
help:
	@echo "Triolla Talent OS — Available targets:"
	@echo ""
	@echo "  make up                    Start dev environment (migrates DB automatically)"
	@echo "  make down                  Stop dev environment"
	@echo "  make reset                 Wipe volumes and restart fresh (clean-slate testing)"
	@echo "  make seed                  Seed DB with test data (opt-in)"
	@echo "  make logs                  Follow container logs"
	@echo "  make test                  Run unit tests inside Docker (matches CI environment)"
	@echo "  make backup                Dump DB to ./backups/YYYY-MM-DD_HH-MM.sql.gz"
	@echo "  make restore BACKUP=path   Restore DB from a dump file"
	@echo "  make ngrok                 Start ngrok tunnel for Postmark webhook testing"
	@echo ""

# D-01: Start dev environment, wait for DB healthy, run migrations
up:
	docker compose -f docker-compose.dev.yml up -d
	@echo "Waiting for database to be healthy..."
	@until docker compose -f docker-compose.dev.yml exec -T postgres pg_isready -U triolla -d triolla > /dev/null 2>&1; do \
		sleep 1; \
	done
	@echo "Database ready. Running migrations..."
	docker compose -f docker-compose.dev.yml exec -T api npx prisma migrate deploy
	@echo ""
	@echo "Dev environment is up. API: http://localhost:3000"
	@echo "Run 'make seed' to populate test data."

# D-01: Stop dev environment
down:
	docker compose -f docker-compose.dev.yml down

# D-01 + D-03: Wipe all volumes and restart from scratch
reset:
	docker compose -f docker-compose.dev.yml down -v
	$(MAKE) up

# D-01 + D-03: Seed DB with test data (explicit opt-in, not automatic)
seed:
	docker compose -f docker-compose.dev.yml exec -T api npx prisma db seed

# Follow all container logs
logs:
	docker compose -f docker-compose.dev.yml logs -f

# D-12: Run tests inside Docker container (same environment as Jenkins)
test:
	docker compose -f docker-compose.dev.yml run --rm api npm run test

# D-25: Dump DB from postgres container to ./backups/
backup:
	@mkdir -p backups
	docker compose -f docker-compose.dev.yml exec postgres pg_dump -U triolla triolla | gzip > ./backups/$$(date +%Y-%m-%d_%H-%M).sql.gz
	@echo "Backup saved to ./backups/"

# D-26: Restore DB from a dump file
# Usage: make restore BACKUP=./backups/2024-01-01_12-00.sql.gz
restore:
ifndef BACKUP
	$(error BACKUP is required. Usage: make restore BACKUP=./backups/dump.sql.gz)
endif
	@echo "Restoring database from $(BACKUP)..."
	gunzip -c $(BACKUP) | docker compose -f docker-compose.dev.yml exec -T postgres psql -U triolla triolla
	@echo "Database restored from $(BACKUP)"

# D-29: Postmark webhook tunnel for local development
ngrok:
	./scripts/ngrok-webhook.sh

