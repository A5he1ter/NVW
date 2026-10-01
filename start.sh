#!/usr/bin/env bash
# NVW 极简启动脚本
cd "$(dirname "$0")" || exit
echo "🚀 正在启动 NVW (Neovim Web 科研工作台)..."
node server.js &
PID=$!
wait $PID
