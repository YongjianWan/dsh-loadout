#!/usr/bin/env bash
# SessionEnd 基线门禁 —— 会话结束时跑一次编译/lint，告诉你留下的代码是绿是红。
# 由 agent-scaffold 铺设，install-hooks.sh 注册。
#
# 挂载点为什么是 SessionEnd（别往回改）：
#   PostToolUse  ❌ 每改一个文件跑一次。真实项目编译 30s+，改 5 个文件 = 2.5 分钟纯等待
#   Stop         ❌ 每轮对话跑一次。20 轮 = 11 分钟。没人有功夫整天跑这个
#   SessionEnd   ✅ 一个会话一次
#
# 代价：SessionEnd 不能阻断（会话已在结束），所以这是**收工报告**不是硬门禁。
# 想要硬门禁就挪回 Stop，代价是每轮都等。
#
# 为什么值得留着：
#   「我认为这能编译」和「它编译过了」之间隔着一次编译。这跟模型强不强无关，是信息问题。
#   模型越强、你越放手让它一轮改十个文件、越少逐行 review，这个自动验证就越是唯一的兜底。
#
# ⚠️ 这个文件只做验证，不做拦截。别往里加"禁止 AI 做某某"的规则——
#    那类规则的历史战绩是：拦死 rm -rf target（清理构建产物）、拦死 .env.example
#    （唯一允许改的凭据模板）、拦死迁移脚本里的 DROP。挡住正常工作流之后，
#    人会把整个门禁关掉，比不设更糟。
#
# 已知缺口：只看工作区未提交的改动，会话里已提交的不重新验证。

set -uo pipefail

INPUT=$(cat 2>/dev/null || echo '{}')
# 挂 Stop 时防死循环；挂 SessionEnd 时这个字段不存在，走默认 false
if command -v jq >/dev/null 2>&1; then
  [ "$(jq -r '.stop_hook_active // false' <<<"$INPUT" 2>/dev/null)" = "true" ] && exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 0

# 中文 Windows 下 javac/msbuild 按 GBK 输出，不转码就是乱码。
# 吐乱码的门禁等于白跑——看不懂的错误没有任何价值。
decode() {
  if command -v iconv >/dev/null 2>&1; then iconv -f GBK -t UTF-8 2>/dev/null || cat; else cat; fi
}

fail() {
  {
    echo "❌ 基线未通过：$1"
    echo "---"
    printf '%s\n' "$2" | decode \
      | grep -E '\[ERROR\]|error:|error TS|FAIL|✕|×|Error:' \
      | grep -Ev 'Help 1|-e switch|-X switch|full stack trace|For more information|following articles|After correcting|resume the build|^\[ERROR\]\s*$' \
      | awk '!seen[$0]++' | head -n 20
    echo "---"
    echo "⚠️ 这个会话留下的是红的代码。下次开工第一件事是修它，别在红的基线上继续加东西。"
  } >&2
  exit 2
}

dirty_matches() { git status --porcelain 2>/dev/null | grep -Eq "$1"; }

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# ── 按技术栈分派。铺完后按项目实际情况删掉用不上的分支 <<< ──

# Java / Maven —— mvn 常常不在 PATH，解不出就跳过而不是报假错
if [ -f pom.xml ] && dirty_matches '\.(java|xml)$'; then
  MVN="$(command -v mvn || ls -d ~/.maven/*/bin/mvn.cmd "/c/Program Files/apache-maven-"*/bin/mvn.cmd 2>/dev/null | head -1)"
  if [ -n "$MVN" ]; then
    echo "🔍 编译中…"
    out=$("$MVN" -q compile -o 2>&1) || fail "Maven 编译" "$out"
    echo "✅ 编译通过"
  else
    echo "⚠️  没解出 Maven，跳过——这轮没验证过，别当它绿了" >&2
  fi
fi

# Node —— 只跑 lint + 单测，不跑 build。门禁得快到能活下来
if [ -f package.json ] && dirty_matches '\.(js|ts|jsx|tsx|vue|svelte)$' && command -v npm >/dev/null; then
  if node -e "process.exit(require('./package.json').scripts?.lint?0:1)" 2>/dev/null; then
    echo "🔍 lint 中…"
    out=$(npm run --silent lint 2>&1) || fail "lint" "$out"
  fi
  if node -e "process.exit(require('./package.json').scripts?.['test:unit']?0:1)" 2>/dev/null; then
    echo "🔍 单测中…"
    out=$(npm run --silent test:unit 2>&1) || fail "单测" "$out"
  fi
  echo "✅ 前端检查通过"
fi

# Python
if dirty_matches '\.py$' && command -v ruff >/dev/null; then
  echo "🔍 ruff 中…"
  out=$(ruff check . 2>&1) || fail "ruff" "$out"
  echo "✅ ruff 通过"
fi

exit 0
