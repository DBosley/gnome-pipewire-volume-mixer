#!/bin/bash
# Install git hooks for the project

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "Installing git hooks..."

# Create hooks directory if it doesn't exist
mkdir -p "$REPO_ROOT/.git/hooks"

# Install pre-commit hook
cat > "$REPO_ROOT/.git/hooks/pre-commit" << 'EOF'
#!/bin/bash
# Pre-commit hook to run code quality checks

echo "Running pre-commit code quality checks..."

# Save current directory
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

# Run extension linting
echo "Running extension linter..."
if ! bun run lint > /dev/null 2>&1; then
    echo "❌ Extension linting failed. Run 'bun run lint' to see errors."
    exit 1
fi

# Run daemon formatting check
echo "Checking daemon formatting..."
cd daemon
if ! cargo fmt -- --check > /dev/null 2>&1; then
    echo "❌ Daemon formatting check failed. Run 'cargo fmt' in the daemon directory."
    exit 1
fi

# Run daemon clippy
echo "Running daemon clippy..."
if ! cargo clippy -- -D warnings > /dev/null 2>&1; then
    echo "❌ Daemon clippy check failed. Run 'cargo clippy' in the daemon directory."
    exit 1
fi

cd "$REPO_ROOT"

# Run tests
echo "Running tests..."
if ! bun test > /dev/null 2>&1; then
    echo "❌ Extension tests failed. Run 'bun test' to see errors."
    exit 1
fi

cd daemon
if ! cargo test > /dev/null 2>&1; then
    echo "❌ Daemon tests failed. Run 'cargo test' in the daemon directory."
    exit 1
fi

echo "✅ All pre-commit checks passed!"
exit 0
EOF

chmod +x "$REPO_ROOT/.git/hooks/pre-commit"

echo "✅ Git hooks installed successfully!"
echo ""
echo "The pre-commit hook will run code quality checks before each commit."
echo "To skip the hook temporarily, use: git commit --no-verify"