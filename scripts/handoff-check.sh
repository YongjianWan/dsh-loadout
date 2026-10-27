#!/usr/bin/env bash
# 收工前自动校验：本仓库 + 子项目仓库的 git 工作区状态 + （可选）关键事实一致性。
# 由 agent-scaffold 铺设。背景见 docs/adr/ 中对应的决策记录（如果项目有 ADR）。
#
# 开局只做一件有把握做对的事：扫 git 状态。
# "关键事实一致性"是项目特定的——不同项目关心哪些数字会重复、会漂移不一样，
# 下面没有默认的 check_fact 调用，照着示例注释的格式在这个文件里加，别新建文件、
# 别把它做成通用解析器。
#
# SKIP（规则没命中，可能已过期）默认只警告不算失败；HANDOFF_STRICT=1 时 SKIP 也算 FAIL。
# §3 打印的人工确认清单不参与退出码——脚本管不了语义类的事，只提醒。
# HANDOFF_SKIP=1 时整个硬 gate 直接放行——显式声明"这轮就是要留 WIP 跨会话"，
# 不是默默绕过。
#
# 用法：bash scripts/handoff-check.sh
# 退出码：0 = 全部通过；1 = 有 FAIL 项，处理完再收工。
set -uo pipefail

if [ "${HANDOFF_SKIP:-0}" = "1" ]; then
  echo "⚠️  HANDOFF_SKIP=1：跳过本次收工校验，未提交改动已显式保留到下次。"
  exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
FAIL=0
SKIPPED=()

# 允许同一天的 WIP 累积：只要 N 小时内有过 commit，dirty 也放行（默认 16，
# 可用 HANDOFF_GRACE_HOURS 调）。超过才要求落袋。这比"每次会话都干净"更符合
# 实际工作流。注意：变量名不能叫 SECONDS——那是 bash 内建的"shell 已运行秒数"
# 特殊变量，赋值会把它悄悄覆盖掉。
HOURS="${HANDOFF_GRACE_HOURS:-16}"
GRACE_SECONDS=$((HOURS * 3600))
NOW=$(date +%s)

echo "== 1. 工作区状态（dirty 在 ${HOURS} 小时内有 commit 则放行）=="

check_repo() {
  local repo="$1"
  if git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
    local dirty
    dirty="$(git -C "$repo" status --short 2>/dev/null)"
    if [ -z "$dirty" ]; then
      echo "OK    $repo clean"
      return
    fi

    local last_commit_ts elapsed
    last_commit_ts="$(git -C "$repo" log -1 --format=%ct 2>/dev/null || echo 0)"
    elapsed=$((NOW - last_commit_ts))
    if [ "$elapsed" -le "$GRACE_SECONDS" ]; then
      echo "OK    $repo dirty，但最近一次提交在 $((elapsed / 3600)) 小时前（${HOURS}h 内放行）"
    else
      echo "FAIL  $repo 工作区不干净且最近一次提交是 $((elapsed / 3600)) 小时前："
      echo "$dirty" | sed 's/^/      /'
      echo "      已超过 ${HOURS} 小时没有提交，建议先 commit / stash 再收工。"
      FAIL=1
    fi
  fi
}

# 本仓库
check_repo "."

# 自动发现直接子目录里是独立 git 仓库的（monorepo 子项目常见形态：
# 子目录有自己的 .git，不是本仓库的一部分）。跳过常见的非项目目录。
for d in */; do
  d="${d%/}"
  case "$d" in
    node_modules|.git|scripts|dist|build|venv|.venv) continue ;;
  esac
  if [ -d "$d/.git" ]; then
    check_repo "$d"
  fi
done

echo
echo "== 2. 关键事实一致性（项目特定，按需在此文件里加） =="

check_fact() {
  local label="$1" pattern="$2"
  shift 2
  local -a files=("$@")
  local -a found=() locs=()
  local f v
  for f in "${files[@]}"; do
    [ -f "$f" ] || continue
    v="$(grep -oE "$pattern" "$f" 2>/dev/null | head -1)"
    if [ -n "$v" ]; then
      found+=("$v")
      locs+=("$f: $v")
    fi
  done
  if [ "${#found[@]}" -eq 0 ]; then
    echo "SKIP  $label（没有文件命中，跳过）"
    SKIPPED+=("$label")
    if [ "${HANDOFF_STRICT:-0}" = "1" ]; then
      FAIL=1
    fi
    return
  fi
  local uniq
  uniq="$(printf '%s\n' "${found[@]}" | sort -u | wc -l)"
  if [ "$uniq" -gt 1 ]; then
    echo "FAIL  $label 在治理文档间数字不一致："
    printf '      %s\n' "${locs[@]}"
    FAIL=1
  else
    echo "OK    $label 一致（${found[0]}）"
  fi
}

# 示例（删掉这行注释，照格式加真实检查项）：
# check_fact "测试通过数" '[0-9]+ passed' "AGENTS.md" "SESSION.md"
if [ "${#SKIPPED[@]}" -gt 0 ]; then
  echo
  echo "WARN  以下检查项未命中，可能规则已过期（措辞变了/文件挪了），去 check_fact 调用处确认还有没有意义："
  printf '      - %s\n' "${SKIPPED[@]}"
  echo "      默认不算失败；要强制当失败处理，跑 HANDOFF_STRICT=1 bash scripts/handoff-check.sh"
else
  echo "（未配置任何一致性检查——发现高频漂移的数字/状态时，照上面注释格式在这里加一行）"
fi

echo
echo "== 3. 脚本无法自动检查的事项（请人工确认，不计入退出码）=="
echo "  - SESSION.md 是否又只增不减？「当前状态」一节是否覆盖了本轮做的事？"
echo "  - 本次改动是否在 CHANGELOG.md [Unreleased] 中追加了条目？"
echo "  - 是否有已修复的债务还留在 TECH_DEBT.md / ROADMAP.md 的待处理表里？"
echo "  - 跨文件重复的状态描述（已知陷阱、当前判断）是否还一致？"

echo
if [ "$FAIL" -ne 0 ]; then
  echo "❌ 校验未通过，处理上面标 FAIL 的项再收工。"
  exit 1
else
  echo "✅ 硬性校验全部通过（提醒：这只覆盖 git 状态和配置的数字检查，不代表文档治理没问题——见上面 §3）。"
  exit 0
fi
