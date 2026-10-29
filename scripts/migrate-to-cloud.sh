#!/usr/bin/env bash
#
# model-hub 云服务器迁移脚本（DEPLOYMENT.md §云服务器迁移）
#
# 把本机 Docker 长驻的 model-hub 迁移到云主机：镜像、数据卷、配置生成、
# 启动、Caddy 反代五步全部脚本化。云主机上无需任何 Dockerfile/compose 改动。
#
# 用法（分两阶段，均为幂等可重跑）：
#   本机（导出侧）：   ./scripts/migrate-to-cloud.sh export <cloud-host>
#   云主机（导入侧）： ./scripts/migrate-to-cloud.sh import [--generate-keys]
#
# 环境变量：
#   SSH_KEY    指定 ssh -i 私钥（可选，默认走 ~/.ssh 配置）
#   HUB_DOMAIN 反代域名（import --generate-keys 时用于 Caddy 配置）
#   NO_TLS=1   跳过 Caddy 配置（仅生成基础 reverse_proxy 片段）
#
# 纪律：
#   - 明文密钥（HUB_MASTER_KEY / HUB_ADMIN_PASSWORD）绝不跨机复制；
#     云侧用 openssl 重新生成。
#   - 数据卷整体打包迁移，保留 SQLite 与加密 key 材料。
#   - export 侧默认不删除本机产物（可 --clean 清理）。
set -euo pipefail

IMAGE=model-hub:latest
VOLUME=model-hub-data
ARTIFACT_DIR=./.migrate

usage() {
  sed -n '2,30p' "$0" | grep -E '^#' | sed 's/^# \{0,1\}//'
  exit 1
}

cmd_export() {
  local host="$1"
  local tarball="$ARTIFACT_DIR/model-hub-data.tgz"
  mkdir -p "$ARTIFACT_DIR"

  echo "==> [1/5] 导出镜像并推送到云主机"
  docker save "$IMAGE" | gzip \
    | ssh ${SSH_KEY:+-i "$SSH_KEY"} "$host" 'gunzip | docker load'

  echo "==> [2/5] 打包数据卷（SQLite + key 材料）"
  docker run --rm -v "${VOLUME}:/data" -v "$PWD/$ARTIFACT_DIR":/bak \
    alpine tar czf "/bak/model-hub-data.tgz" -C /data .

  echo "==> [3/5] 上传数据包"
  scp ${SSH_KEY:+-i "$SSH_KEY"} "$tarball" "$host:/tmp/model-hub-data.tgz"

  echo "==> 本机侧完成。产物：$tarball（可保留作备份快照，或 --clean 删除）"
}

cmd_import() {
  local generate_keys="${1:-}"
  mkdir -p "$ARTIFACT_DIR"

  echo "==> [3/5] 解包数据卷到同名 volume"
  docker volume create "$VOLUME" >/dev/null 2>&1 || true
  docker run --rm -v "${VOLUME}:/data" -v /tmp:/src alpine \
    sh -c 'tar xzf /src/model-hub-data.tgz -C /data'

  echo "==> [4/5] 生成 .env.local（不复制本机明文密钥）"
  if [ ! -f .env.local ]; then
    cp apps/hub/.env.example .env.local
  fi
  sed -i '' -e "s/^HUB_MASTER_KEY=.*/HUB_MASTER_KEY=$(openssl rand -base64 32 | tr -d '\n')/" .env.local 2>/dev/null \
    || sed -i -e "s/^HUB_MASTER_KEY=.*/HUB_MASTER_KEY=$(openssl rand -base64 32 | tr -d '\n')/" .env.local
  if [ "$generate_keys" = "--generate-keys" ]; then
    sed -i '' -e "s/^HUB_ADMIN_PASSWORD=.*/HUB_ADMIN_PASSWORD=$(openssl rand -base64 24 | tr -d '\n')/" .env.local 2>/dev/null \
      || sed -i -e "s/^HUB_ADMIN_PASSWORD=.*/HUB_ADMIN_PASSWORD=$(openssl rand -base64 24 | tr -d '\n')/" .env.local
    echo "    已重新生成 HUB_MASTER_KEY / HUB_ADMIN_PASSWORD（admin 密码请从 .env.local 抄出并妥善保存）"
  else
    echo "    HUB_MASTER_KEY 已重新生成；HUB_ADMIN_PASSWORD 沿用模板占位，请手动设置后继续。"
  fi

  echo "==> 启动服务"
  docker compose up -d --build

  echo "==> 健康检查"
  sleep 3
  curl -sf "http://127.0.0.1:8791/api/health" && echo " model-hub healthy" || {
    echo "    健康检查失败，查看：docker compose logs model-hub" >&2
    exit 1
  }

  if [ "${NO_TLS:-0}" != "1" ]; then
    echo "==> [5/5] 生成 Caddy 反代配置片段"
    if [ -n "${HUB_DOMAIN:-}" ]; then
      cat <<EOF
# 写入 Caddyfile（或 /etc/caddy/Caddyfile）：
${HUB_DOMAIN} {
    reverse_proxy 127.0.0.1:8791
}
EOF
    else
      cat <<'EOF'
# 未设置 HUB_DOMAIN，生成基础片段（域名替换 <your-domain>）：
<your-domain> {
    reverse_proxy 127.0.0.1:8791
}
EOF
    fi
  fi

  echo "==> 云侧完成。model-hub 已在本机 127.0.0.1:8791 长驻。"
}

case "${1:-}" in
  export) cmd_export "${2:?usage: export <cloud-host>}" ;;
  import) cmd_import "${2:-}" ;;
  *) usage ;;
esac
