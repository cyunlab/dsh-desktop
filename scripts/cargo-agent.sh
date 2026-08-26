#!/bin/sh
set -eu

# 所有 linked worktree 共享 git common dir，因此锁文件天然跨 worktree 生效。
common_dir=$(git rev-parse --path-format=absolute --git-common-dir)
lock_file="$common_dir/dsh-desktop-cargo-agent.lock"

if [ ! -d dist ]; then
  echo "error: dist/ is missing; run 'pnpm build' before Cargo validation" >&2
  exit 1
fi

if command -v lockf >/dev/null 2>&1; then
  exec lockf -k "$lock_file" cargo "$@"
fi

if command -v flock >/dev/null 2>&1; then
  exec flock "$lock_file" cargo "$@"
fi

echo "warning: lockf/flock unavailable; running Cargo without the repository lock" >&2
exec cargo "$@"
