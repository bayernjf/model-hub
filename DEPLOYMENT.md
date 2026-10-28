# model-hub 部署手册

依据技术方案 §11（owner 2026-10-28 定案）：**与 zeus/loom 全家桶同机 Docker 部署**，
不单独开机器；Caddy 反代终止 HTTPS，仅内网/Tailscale 暴露，不对公网开放。

## 拓扑

```text
Tailscale / LAN
     │
  Caddy（与 loom 全家桶同机，见 loom/infra/caddy/Caddyfile）
     │ 内网反代
  model-hub 容器（docker-compose.yml，loopback 127.0.0.1:8791）
     │ 挂载卷 model-hub-data → /data（SQLite 文件）
  backup sidecar：每天一次 sqlite3 .backup → 宿主 ./backups，保留 7 天
```

zeus / loom 容器内以 `http://model-hub:8791`（同 compose 内网）或
`http://<宿主机>:8791`（loopback 映射）访问；项目侧 model-kit 缓存投影，
hub 宕机不影响已缓存调用。

## 首次部署

1. 在宿主机拉取本仓，复制 `.env.local`（不入库）：

   ```bash
   HUB_MASTER_KEY=<长随机串，>=16 字符>
   HUB_ADMIN_PASSWORD=<强口令，>=12 字符>
   HUB_PORT=8791
   ```

   生产**不要**设 `HUB_DEV_NO_AUTH`。

2. 构建并启动：

   ```bash
   docker compose up -d --build
   docker compose exec model-hub node --experimental-sqlite scripts/migrate.mjs up
   ```

3. Caddy 反代片段（加入 loom Caddyfile 的站点块）：

   ```caddy
   # model-hub 管理台与项目 API；仅内网/Tailscale 解析
   handle /api/admin/* {
       reverse_proxy host.docker.internal:8791
   }
   handle /api/* {
       reverse_proxy host.docker.internal:8791
   }
   handle /healthz {
       reverse_proxy host.docker.internal:8791
   }
   handle / {
       reverse_proxy host.docker.internal:8791
   }
   ```

   若 hub 与 loom 同 compose 网络，把 `host.docker.internal:8791` 换成
   `model-hub:8791`。公网面默认不放：管理台登录与 API 只经内网可达。

## 验证（部署后必做）

```bash
# 1. 健康
curl -fsS http://127.0.0.1:8791/healthz

# 2. 模型拉取（项目 token 在管理台「项目」页签发）
curl -fsS http://127.0.0.1:8791/pub/v1/models \
  -H "Authorization: Bearer <project-token>" | head

# 3. 备份产物
docker compose logs backup | tail -5
ls -lh ./backups/
```

三项全绿才算部署完成；任何一项失败先看 `docker compose logs model-hub`。

## 备份与恢复

- backup sidecar 每 `HUB_BACKUP_INTERVAL_SECONDS`（默认 86400）做一次一致性
  `.backup` 快照，保留 `HUB_BACKUP_RETENTION_DAYS`（默认 7）天。
- 恢复：停容器 → 用任一快照替换卷内 `model-hub.db` → 启动 → 跑一次
  `/pub/v1/models` 冒烟。

## 凭证纪律

厂商 key 只经管理台 UI 录入（加密入库），或开发期放在 gitignored 本地 env；
禁止写入文档、提交历史、日志与构建产物。
