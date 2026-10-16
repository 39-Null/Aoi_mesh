#!/usr/bin/env bash
# opencode-mesh 启动（Linux）— Node App 启动别名
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# 1) 开发/仓库布局：node-app 内自带 Electron
if [ -x "$DIR/node-app/node_modules/electron/dist/electron" ]; then
  exec "$DIR/node-app/node_modules/electron/dist/electron" "$DIR/node-app" --no-sandbox "$@"
fi

# 2) 便携包布局：仓库根旁存在打包好的 app/
if [ -x "$DIR/app/opencode-mesh" ]; then
  export OPENCODE_MESH_ROOT="$DIR"
  exec "$DIR/app/opencode-mesh" --no-sandbox "$@"
fi

echo "未找到可用 App：请先在 node-app 执行 npm install，或使用便携包 start-app.sh" >&2
exit 1
