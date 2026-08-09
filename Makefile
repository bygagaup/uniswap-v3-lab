.DEFAULT_GOAL := help
SHELL := /bin/bash

DEV_VARS := apps/api/.dev.vars

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

.PHONY: install
install: ## Install workspace dependencies
	pnpm install

$(DEV_VARS):
	@echo 'GRAPH_API_KEY=' > $(DEV_VARS)
	@echo "Created $(DEV_VARS) — put your The Graph gateway key in it, then rerun."
	@exit 1

.PHONY: dev
dev: $(DEV_VARS) ## Run the Worker (:8787) and the SPA (:5173) together
	@trap 'kill 0' EXIT INT TERM; \
	pnpm --filter @poollab/api dev & \
	pnpm --filter @poollab/web dev & \
	wait

.PHONY: dev-api
dev-api: $(DEV_VARS) ## Run only the Worker on :8787
	pnpm --filter @poollab/api dev

.PHONY: dev-web
dev-web: ## Run only the SPA on :5173 (proxies /api to :8787)
	pnpm --filter @poollab/web dev

.PHONY: build
build: ## Build every package
	pnpm build

.PHONY: preview
preview: build $(DEV_VARS) ## Serve the built SPA and API from one Worker on :8787
	pnpm --filter @poollab/api dev

.PHONY: test
test: ## Run the test suite (offline)
	pnpm test

.PHONY: typecheck
typecheck: ## Typecheck every package
	pnpm typecheck

.PHONY: lint
lint: ## Lint and format-check
	pnpm lint

.PHONY: check
check: lint typecheck test ## Everything CI runs

.PHONY: clean
clean: ## Remove build output and caches
	rm -rf apps/*/dist apps/*/dist-types apps/*/dist-tools packages/*/dist packages/*/dist-tools
	find . -name '*.tsbuildinfo' -not -path './node_modules/*' -delete
	rm -rf .wrangler apps/api/.wrangler
