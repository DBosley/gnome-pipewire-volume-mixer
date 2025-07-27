.PHONY: all build test lint fmt clean check fix

all: lint test build

build:
	@echo "Building daemon..."
	@cargo build --release

test:
	@echo "Running tests..."
	@cargo test

lint:
	@echo "Running clippy..."
	@cargo clippy -- -D warnings

fmt:
	@echo "Formatting code..."
	@cargo fmt

check:
	@echo "Checking code..."
	@cargo check

fix:
	@echo "Fixing code issues..."
	@cargo fmt
	@cargo fix --allow-dirty --allow-staged
	@cargo clippy --fix --allow-dirty --allow-staged

clean:
	@echo "Cleaning build artifacts..."
	@cargo clean

# Development helpers
dev-test:
	@cargo test -- --nocapture

dev-build:
	@cargo build

bench:
	@cargo bench