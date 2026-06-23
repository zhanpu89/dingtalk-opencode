#!/bin/bash
# ── 暴力重启脚本 ──
# 延迟等待父进程安全退出
sleep 3

# ── 便携式进程杀手（兼容无 pkill 的环境，如 Alpine Linux） ──
kill_process() {
    local pattern="$1"
    local signal="${2:-KILL}"

    # 方法1: pkill（procps 包，大多数 Linux 发行版）
    if command -v pkill &>/dev/null; then
        pkill -"$signal" -f "$pattern" 2>/dev/null || true
        return
    fi

    # 方法2: 直接遍历 /proc（兼容 Alpine/busybox）
    # 注意：/proc/PID/cmdline 参数间以 null 分隔，需转空格再匹配
    local pid
    for pid_dir in /proc/[0-9]*/; do
        [ -r "${pid_dir}cmdline" ] || continue
        if tr '\0' ' ' < "${pid_dir}cmdline" 2>/dev/null | grep -q "$pattern" 2>/dev/null; then
            pid=$(basename "$pid_dir")
            # 不杀自己
            [ "$pid" = "$$" ] && continue
            kill -s "$signal" "$pid" 2>/dev/null || true
        fi
    done
}

# 强制终止所有相关进程
kill_process "opencode serve"   KILL
kill_process "tsx watch"        KILL
kill_process "concurrently"     KILL
kill_process "python.*server"   KILL

sleep 2

cd /root/project/dingtalk-opencode || exit 1

# 清理可能损坏的会话数据（保留项目上下文，避免切换偏好丢失）
rm -f data/session-map.json

# 确保日志目录存在
mkdir -p data

# 后台重新拉起整套服务
nohup npm run start:all >> data/app.log 2>&1 &
