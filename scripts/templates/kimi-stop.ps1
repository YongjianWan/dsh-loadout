#!/usr/bin/env pwsh
# Stop: 轮次结束 → verification-before-completion 最终门禁

$json = [Console]::In.ReadToEnd()
$json = $json.TrimStart([char]0xFEFF)

try {
    $data = $json | ConvertFrom-Json -ErrorAction Stop
    $stopActive = $data.stop_hook_active
} catch {
    $stopActive = $false
}

# Stop hook 防循环：已被重新触发时静默退出
if ($stopActive) { exit 0 }

# ═══════════════════════════════════════════════════════════════
# 1. Verification 铁律门禁
# ═══════════════════════════════════════════════════════════════
Write-Output @"
+--------------------------------------------------------------+
|  STOP: VERIFICATION GATE - BEFORE claiming done              |
+--------------------------------------------------------------+
|                                                              |
|  没有新鲜的验证证据，不许宣称完成                              |
|                                                              |
|  1. 确定：什么命令能证明这个结论？                            |
|  2. 运行：执行完整命令（重新运行，完整执行）                   |
|  3. 阅读：完整输出，检查退出码，统计失败数                     |
|  4. 验证：输出是否支持这个结论？                               |
|     - 否 -> 用证据说明实际状态                                  |
|     - 是 -> 带证据陈述结论                                      |
|  5. 只有这时 -> 才能做出结论                                   |
|                                                              |
|  跳过任何一步 = 说谎，不是验证                                |
+--------------------------------------------------------------+
"@

# ═══════════════════════════════════════════════════════════════
# 2. Git 状态检查
# ═══════════════════════════════════════════════════════════════
try {
    $gitStatus = git status --short 2>$null
    if ($gitStatus) {
        Write-Output ""
        Write-Output "📝  UNCOMMITTED CHANGES:"
        $gitStatus | ForEach-Object { Write-Output "     $_" }
        Write-Output ""
        Write-Output "     Consider: git add and git commit -m '...'"
    } else {
        # 检查是否在 git 仓库中
        $inGit = git rev-parse --git-dir 2>$null
        if ($inGit) {
            Write-Output ""
            Write-Output "✅  Working tree clean — no uncommitted changes."
        }
    }
} catch {}

# ═══════════════════════════════════════════════════════════════
# 3. 后台任务检查
# ═══════════════════════════════════════════════════════════════
try {
    $tasks = kimi task list --active 2>$null
    if ($tasks -and ($tasks -match 'running|in_progress')) {
        Write-Output ""
        Write-Output "⚠️   BACKGROUND TASKS ACTIVE — check /task before finishing"
    }
} catch {}

# ═══════════════════════════════════════════════════════════════
# 4. Project-specific handoff check (ADR-0001)
#    向上查找 scripts/handoff-check.sh，找到则强制运行；失败则阻止收工。
#    显式绕过：HANDOFF_SKIP=1 时跳过本项检查（保留跨会话 WIP）。
# ═══════════════════════════════════════════════════════════════
if ($env:HANDOFF_SKIP -eq "1") {
    Write-Output ""
    Write-Output "⚠️   HANDOFF_SKIP=1：跳过 project-specific handoff check，未提交改动已保留到下次。"
    exit 0
}

try {
    # Get-Location 返回的 PathInfo 没有 .Parent 成员（恒为 $null），之前这里
    # 循环第一轮就退出，"向上查找"从未真正生效。改用字符串路径 +
    # Split-Path -Parent 逐级上溯。
    $currentDir = (Get-Location).Path
    $handoffScript = $null
    while ($currentDir -and ($currentDir -ne [System.IO.Path]::GetPathRoot($currentDir))) {
        $candidate = Join-Path $currentDir "scripts\handoff-check.sh"
        if (Test-Path $candidate) {
            $handoffScript = $candidate
            break
        }
        $parent = Split-Path -Parent $currentDir
        if (-not $parent -or $parent -eq $currentDir) { break }
        $currentDir = $parent
    }

    if ($handoffScript) {
        Write-Output ""
        Write-Output "🔍  Running project handoff check..."
        $output = bash $handoffScript 2>&1
        $handoffExit = $LASTEXITCODE
        $output | ForEach-Object { Write-Output "    $_" }
        if ($handoffExit -ne 0) {
            Write-Output ""
            Write-Output "❌  handoff-check.sh failed. Resolve the issues above before finishing."
            exit $handoffExit
        }
    }
} catch {
    Write-Output ""
    Write-Output "⚠️   Could not run handoff-check.sh: $_"
}

exit 0
