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

   知识库（M3，可选）：要启用文档 ingest/问答，再配
   `KNOWLEDGE_PROJECT_TOKEN`（持有相关 alias 分配的消费项目 token）与
   `KNOWLEDGE_EMBED_ALIAS` / `KNOWLEDGE_RERANK_ALIAS` /
   `KNOWLEDGE_ANSWER_ALIAS`；不配则知识库 ingest/query 返回 503。
   详见 `docs/knowledge-api.md`。

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

## 云服务器迁移（最终生产方案，后续执行）

当前先用本机 MacBook Docker 长驻（`docker compose up -d --build`，loopback 8791）。
最终迁移到云服务器时，制品已 Docker 化，迁移成本最低，只需：

1. **迁移镜像**：`docker save model-hub:latest | gzip | ssh <cloud-host> 'gunzip | docker load'`
   （或推到私有 registry 后 `docker pull`）。
2. **迁移数据卷**：本机
   `docker run --rm -v model-hub_model-hub-data:/data -v "$PWD":/bak alpine tar czf /bak/model-hub-data.tgz -C /data .`，
   云主机解包到同名 volume（或直接 `scp` 备份快照恢复）。
3. **配置**：云主机 `cp .env.example .env.local` 并重新生成
   `HUB_MASTER_KEY` / `HUB_ADMIN_PASSWORD`（**不复制本机明文密钥**）。
4. **启动**：同一份 `docker-compose.yml` 在云主机 `docker compose up -d --build`，
   无需任何 Dockerfile/compose 改动。
5. **反代/TLS**：compose 仍是 loopback 绑定不变，云主机用 Caddy 终止 HTTPS——
   把 §拓扑 Caddy 片段的 `host.docker.internal:8791` 换成 `127.0.0.1:8791` 即可。

迁移成本集中在第 5 步（域名 + TLS 证书），Docker 层面零改造。

### 一键脚本（推荐）

上述 5 步已脚本化为 `scripts/migrate-to-cloud.sh`（幂等可重跑，明文密钥
不跨机复制）：

```bash
# 本机（导出侧）：导出镜像 + 打包上传数据卷
./scripts/migrate-to-cloud.sh export <cloud-host>

# 云主机（导入侧）：解包 + 生成新密钥 + 启动 + 健康检查 + Caddy 片段
HUB_DOMAIN=model-hub.example.com ./scripts/migrate-to-cloud.sh import --generate-keys
```

环境变量：`SSH_KEY`（指定私钥）、`HUB_DOMAIN`（反代域名）、`NO_TLS=1`
（跳过 Caddy 片段）。`--generate-keys` 会重新生成 `HUB_MASTER_KEY` 与
`HUB_ADMIN_PASSWORD`（admin 密码从云侧 `.env.local` 抄出妥善保存）。
