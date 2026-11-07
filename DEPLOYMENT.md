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
  backup sidecar：每天一次 `VACUUM INTO` 一致性快照（node:sqlite）→ 宿主 ./backups，保留 7 天
```

zeus / loom 容器内以 `http://model-hub:8791`（同 compose 内网）或
`http://<宿主机>:8791`（loopback 映射）访问；项目侧 model-kit 缓存投影，
hub 宕机不影响已缓存调用。

## 首次部署

1. 在宿主机拉取本仓，从 `apps/hub/.env.example` 复制两份（均不入库）：

   ```bash
   cp apps/hub/.env.example .env              # docker compose 变量替换文件
   cp apps/hub/.env.example apps/hub/.env.local  # 本地/裸机 npm run dev 使用
   ```

   在 `.env` 中填入真实密钥（`HUB_MASTER_KEY=<长随机串，>=16 字符>`、
   `HUB_ADMIN_PASSWORD=<强口令，>=12 字符>`、`HUB_PORT=8791`），权限必须
   0600（`chmod 600 .env apps/hub/.env.local`），与 `apps/hub/data/model-hub.db`
   同一纪律（AGENTS.md）。

   生产**不要**设 `HUB_DEV_NO_AUTH`；若误设，`NODE_ENV=production` 下
   启动会直接抛 `ConfigError` 拒绝运行（同机反代使 socket peer 恒为
   loopback，`isLoopbackPeer` 无法区分外部流量）。第二道防线：该开关
   与 `HUB_MASTER_KEY`/`HUB_ADMIN_PASSWORD` 同现时同样拒绝启动，
   杜绝"带着真实密钥的 dev 模式"——本地纯开发使用该开关时，两个密钥
   必须留空（空串视为未配置）。

   知识库（M3，可选）：要启用文档 ingest/问答，再配
   `KNOWLEDGE_PROJECT_TOKEN`（持有相关 alias 分配的消费项目 token）与
   `KNOWLEDGE_EMBED_ALIAS` / `KNOWLEDGE_RERANK_ALIAS` /
   `KNOWLEDGE_ANSWER_ALIAS`；不配则知识库 ingest/query 返回 503。
   详见 `docs/knowledge-api.md`。

   成本治理告警（M5，可选）：要接收预算水位告警（某分配当日用量达
   日预算 80%/100% 时各至多一次），配 `HUB_BUDGET_WEBHOOK_URL`（接收端
   URL，不配则整层告警跳过）与 `HUB_BUDGET_WEBHOOK_SECRET`（HMAC-SHA256
   签名密钥，接收端按 `x-hub-signature: sha256=<hex>` 校验原始 body）。
   详见 `docs/cost-governance.md`。

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
  `.backup` 快照，保留 `HUB_BACKUP_RETENTION_DAYS`（默认 7）天。快照与 live 库
  同级敏感（信封密文、token 哈希、审计 IP、全量配置），`backup-hub.sh` 以
  `umask 077` + 显式 `chmod 600` 落盘，宿主 `./backups/` 下文件应为 0600。
- 恢复：停容器 → 用任一快照替换卷内 `model-hub.db` → 启动 → 跑一次
  `/pub/v1/models` 冒烟。
- 破坏性迁移（如 016 重建 `assignments`）：迁移器在**已有数据**的数据库上执行
  前强制校验快照——文件存在、非 0 字节、权限 0600、`integrity_check=ok`、
  且账本行数与当前库一致；任一不满足即拒绝执行，**没有绕过参数**。容器内需
  `-v "$PWD/backups:/backups:ro"` 并设 `HUB_BACKUP_PATH=/backups/<快照>`；
  不设则取仓库 `backups/` 下最新的 `hub-*.db`。全新数据库不受此限。

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
3. **配置**：云主机 `cp apps/hub/.env.example .env.local`，并同样复制一份为
   仓库根 `.env`（docker compose 变量替换文件）；重新生成
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
