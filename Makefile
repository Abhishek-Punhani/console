# KubeStellar Console — developer workflow targets
#
# Usage:
#   make dev       Start frontend, backend, and kc-agent (auto-installs kc-agent)
#   make update    Pull latest, build everything, restart
#   make build     Build frontend + Go binaries
#   make restart   Restart all processes via startup-oauth.sh
#   make help      Show available targets

.PHONY: help build restart update pull lint dev

SHELL := /bin/bash

## help: Show this help message
help:
	@echo "Usage: make <target>"
	@echo ""
	@sed -n 's/^## //p' $(MAKEFILE_LIST) | column -t -s ':' | sed 's/^/  /'

## pull: Pull latest changes from main
pull:
	git pull --rebase origin main

## build: Build frontend and Go binaries
build:
	cd web && npm install --prefer-offline && npm run build
	mkdir -p bin
	go build -o bin/kc-agent ./cmd/kc-agent
	go build -o bin/console ./cmd/console
	@# Update Homebrew kc-agent if installed
	@if command -v kc-agent >/dev/null 2>&1; then cp bin/kc-agent $$(which kc-agent) 2>/dev/null || true; fi

## restart: Restart all processes (kc-agent, backend, frontend)
restart:
	bash startup-oauth.sh

## update: Pull, build, and restart (full update cycle)
update: pull build restart

## lint: Run frontend linter
lint:
	cd web && npm run lint

## dev: Start frontend, backend, and kc-agent for local development (no OAuth required)
## dev: Auto-installs kc-agent if missing (Homebrew on macOS, builds from source on Linux)
dev:
	@set -e; \
	if ! command -v kc-agent >/dev/null 2>&1 && [ ! -x ./bin/kc-agent ]; then \
		echo "kc-agent not found — installing..."; \
		if [ "$$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then \
			brew tap kubestellar/tap && brew install --head kc-agent; \
		else \
			echo "Building kc-agent from source (requires Go 1.24+)..."; \
			mkdir -p bin && GOWORK=off go build -o bin/kc-agent ./cmd/kc-agent; \
		fi; \
	fi; \
	KC_AGENT=$$(command -v kc-agent 2>/dev/null || echo ./bin/kc-agent); \
	if [ ! -x "$$KC_AGENT" ]; then \
		echo "Error: kc-agent not found at $$KC_AGENT. Install it manually or check the build output above."; \
		exit 1; \
	fi; \
	for p in 8080 5174 8585; do \
		PID=$$(lsof -ti :$$p 2>/dev/null || true); \
		if [ -n "$$PID" ]; then \
			echo "Port $$p in use (PID $$PID) — killing..."; \
			kill -9 $$PID 2>/dev/null || true; \
			sleep 1; \
		fi; \
	done; \
	trap 'kill 0' INT TERM EXIT; \
	echo "Starting kc-agent ($$KC_AGENT)..."; \
	$$KC_AGENT & \
	echo "Starting backend (dev mode)..."; \
	( source ~/.config/kubestellar-console/env 2>/dev/null || true; \
	  DEV_MODE=true FRONTEND_URL=http://localhost:5174 GOWORK=off \
	  go run ./cmd/console/main.go --dev ) & \
	echo "Starting frontend..."; \
	( cd web && npm run dev ) & \
	echo ""; \
	echo "=== KubeStellar Console (dev mode) ==="; \
	echo "  Frontend: http://localhost:5174  (Vite HMR)"; \
	echo "  Backend:  http://localhost:8080"; \
	echo "  Agent:    http://localhost:8585"; \
	echo ""; \
	echo "Press Ctrl+C to stop all processes"; \
	wait
