.PHONY: setup lint test load bench audit ci

setup:
	npm ci

# Strict TypeScript (noUncheckedIndexedAccess, exactOptionalPropertyTypes), no emit.
lint:
	npm run lint

# Unit tests plus real WebSocket clients against a server on a random local port.
test:
	npm test

# 200 clients in one process each make 20 edits to one document (args: clients, edits per client).
load:
	npm run load -- 200 20

bench:
	@echo "M3: k6 run with 10,000 concurrent sockets and edit latency p99 across several server nodes"

# Known vulnerabilities in npm dependencies (high and critical fail).
audit:
	npm audit --audit-level=high

ci: setup lint test
