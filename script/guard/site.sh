#!/usr/bin/env bash
# 看板数据分支 bench-data 的检出与推送，只给 guard-nightly.yml / guard-bench-commits.yml 用。
#   bash script/guard/site.sh prepare <dir>          把 bench-data 检出到 <dir>（分支不存在时新建空分支）
#   bash script/guard/site.sh push <dir> "<说明>"     提交并推送；与并发写入冲突时重试
set -euo pipefail
cmd=$1 dir=$2
branch=bench-data

if [ "$cmd" = prepare ]; then
  if git ls-remote --exit-code --heads origin "$branch" > /dev/null; then
    git fetch --no-tags origin "+refs/heads/$branch:refs/remotes/origin/$branch"
    git worktree add -B "$branch" "$dir" "origin/$branch"
  else
    git worktree add --orphan -b "$branch" "$dir"
  fi
elif [ "$cmd" = push ]; then
  cd "$dir"
  git add -A
  if git diff --cached --quiet; then echo "看板数据没有变化"; exit 0; fi
  git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" commit -q -m "$3"
  # data/index.json 由 report.ts 合并生成；推送被拒说明有并发写入，此时整体放弃并提示重跑，避免合出错数据
  git push origin "HEAD:$branch" || { echo "::error::bench-data 推送被拒（可能有并发写入），请重跑本任务"; exit 1; }
else
  echo "用法：site.sh prepare <dir> | push <dir> <说明>" >&2
  exit 2
fi
