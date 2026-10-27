#!/usr/bin/env bash
# 幂等注册本机 Stop hook。
# 支持 Claude Code（.claude/settings.json）和 Kimi Code CLI（~/.kimi/hooks/stop.ps1 + ~/.kimi-code/config.toml）。
# 用法：bash scripts/install-hooks.sh [claude|kimi|all]
# 默认 all。换新机器 / 重装 skill 后跑一遍即可。
#
# 注意：这个脚本把配置写到本机工具目录（.claude/、~/.kimi/、~/.kimi-code/），
# 这些路径通常不进版本库，因此每个协作者 / 每台机器都要自己跑一遍。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-all}"

install_claude() {
  local settings="$ROOT/.claude/settings.json"
  local handoff_script="$ROOT/scripts/handoff-check.sh"

  if ! command -v jq >/dev/null 2>&1; then
    echo "ERR   Claude Code hook 需要 jq 来安全编辑 JSON，未找到。装完再跑：" >&2
    echo "      winget install jqlang.jq   # Windows" >&2
    echo "      brew install jq            # macOS" >&2
    return 1
  fi

  mkdir -p "$(dirname "$settings")"
  if [ ! -f "$settings" ]; then
    echo "{}" > "$settings"
  fi

  # 两个 hook 各自幂等注册。注意别在第一个已存在时提前 return——
  # 那会导致后加的 hook 在老项目上永远装不上（这个坑踩过）。
  local tmp

  # Stop：每轮跑，只扫 git 状态，必须快
  if grep -q "handoff-check.sh" "$settings" 2>/dev/null; then
    echo "OK    Claude Code: 已注册 handoff-check.sh，跳过（幂等）。"
  else
    local cmd_handoff="bash -c 'out=\"\$(bash \"$handoff_script\" 2>&1)\"; code=\$?; if [ \$code -ne 0 ]; then echo \"\$out\" >&2; exit 2; fi'"
    tmp="$(mktemp)"
    jq --arg cmd "$cmd_handoff" '
      .hooks //= {} |
      .hooks.Stop //= [] |
      .hooks.Stop += [{
        "hooks": [{
          "type": "command",
          "command": $cmd,
          "timeout": 30,
          "statusMessage": "收工前校验：项目 git 状态 + 关键事实一致性"
        }]
      }]
    ' "$settings" > "$tmp" && mv "$tmp" "$settings"
    echo "OK    Claude Code: 已注册 Stop hook → $handoff_script"
  fi

  # SessionEnd：整个会话结束跑一次编译/lint。
  # 不挂 Stop——真实项目编译 30s+，每轮都跑的话 20 轮就是 11 分钟，没人受得了，
  # 受不了的结果是人把整个门禁删掉。代价：SessionEnd 不能阻断，它是收工报告不是硬门禁。
  local gate_script="$ROOT/scripts/gate-build.sh"
  if [ ! -f "$gate_script" ]; then
    echo "SKIP  Claude Code: 没有 scripts/gate-build.sh，跳过基线门禁注册。"
  elif grep -q "gate-build.sh" "$settings" 2>/dev/null; then
    echo "OK    Claude Code: 已注册 gate-build.sh，跳过（幂等）。"
  else
    tmp="$(mktemp)"
    jq --arg cmd "bash \"$gate_script\"" '
      .hooks //= {} |
      .hooks.SessionEnd //= [] |
      .hooks.SessionEnd += [{
        "hooks": [{
          "type": "command",
          "command": $cmd,
          "timeout": 180,
          "statusMessage": "收工基线验证：编译 / lint / 单测"
        }]
      }]
    ' "$settings" > "$tmp" && mv "$tmp" "$settings"
    echo "OK    Claude Code: 已注册 SessionEnd hook → $gate_script"
  fi
}

install_kimi() {
  local hooks_dir="$HOME/.kimi/hooks"
  local config="$HOME/.kimi-code/config.toml"
  local target="$hooks_dir/stop.ps1"
  local template="$ROOT/scripts/templates/kimi-stop.ps1"

  if [ ! -f "$template" ]; then
    echo "ERR   Kimi Code: 模板不存在 $template" >&2
    return 1
  fi

  mkdir -p "$hooks_dir"

  # 如果现有文件与模板不同，先备份
  if [ -f "$target" ]; then
    if ! diff -q "$target" "$template" >/dev/null 2>&1; then
      local backup
      backup="$target.bak.$(date +%Y%m%d%H%M%S)"
      cp "$target" "$backup"
      echo "BACKUP Kimi Code: $target -> $backup"
    fi
  fi

  cp "$template" "$target"
  echo "OK    Kimi Code: 已更新 $target"

  # 确保 config.toml 存在并注册了 Stop hook
  mkdir -p "$(dirname "$config")"
  if [ ! -f "$config" ]; then
    cat > "$config" <<'EOF'
[loop_control]
max_steps_per_turn = 1000
max_retries_per_step = 3
EOF
  fi

  if grep -q 'event = "Stop"' "$config" 2>/dev/null && grep -q "stop.ps1" "$config" 2>/dev/null; then
    echo "OK    Kimi Code: $config 已注册 Stop hook，跳过（幂等）。"
  else
    cat >> "$config" <<'EOF'

[[hooks]]
event = "Stop"
matcher = ""
command = "pwsh -ExecutionPolicy Bypass -File %USERPROFILE%/.kimi/hooks/stop.ps1"
timeout = 5
EOF
    echo "OK    Kimi Code: 已在 $config 注册 Stop hook"
  fi
}

case "$TARGET" in
  claude)
    install_claude
    ;;
  kimi)
    install_kimi
    ;;
  all)
    # 两个都跑，任何一个失败不影响另一个（set -e 下裸调用会在第一个失败时
    # 中止整个脚本，导致后一个工具永远装不上——之前踩过这个坑）。
    STATUS=0
    install_kimi || STATUS=1
    install_claude || STATUS=1
    exit "$STATUS"
    ;;
  *)
    echo "用法：bash scripts/install-hooks.sh [claude|kimi|all]"
    echo "默认 all，同时注册 Claude Code 和 Kimi Code CLI 的 Stop hook。"
    echo "只装 Kimi Code：bash scripts/install-hooks.sh kimi"
    exit 1
    ;;
esac

echo
echo "提示：这些 hook 配置写在本机工具目录里，不进版本库；换机器 / 换协作者，各自跑一遍这个脚本。"
