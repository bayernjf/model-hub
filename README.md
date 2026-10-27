# model-hub — 统一模型管理中心

Owner 单用户自托管的**模型控制面**：在一处录入厂商凭证、维护模型目录、
按项目多对多分配；各项目（zeus、loom、atlas、agent-world、job-agent）
通过 project token 拉取"被分配的内置模型"投影，然后**直连厂商**推理。

> hub 不是推理网关：不经手推理流量、不做流式中转、不做集中扣费。
> 终端用户 BYOK 永远留在各项目内，hub 不感知、不触碰。

## 能力一览

- **厂商管理**：预置 Ark Plan / Ark Platform / Agnes / Anthropic / OpenAI，
  凭证 AES-256-GCM 加密落库，掩码展示、轮换，L1 凭证测试。
- **模型目录**：五模态（text/image/video/audio/embedding）、多维定价、
  端点与方言 adapter、LiteLLM 命名；预置清单默认不勾选，strict overlay。
- **项目与凭证**：项目注册、project token 哈希存储（明文仅一次）。
- **分配**：模型↔项目多对多，role（primary/fallback）、项目内 alias、
  日预算；整批保存，revision 自增。
- **配置下发**：`GET /pub/v1/models`（Bearer、revision/ETag/304），
  项目侧 0600 缓存兜底，hub 宕机不影响运行。
- **用量与测试**：`POST /pub/v1/usage`、`/health-checks`；L1–L4 连接测试。

## 设计文档（单一事实源，在 bayjf 仓）

- [PRD](../bayjf/docs/tier0/Tier0-model-hub%20PRD.md)
- [技术方案](../bayjf/docs/tier0/Tier0-model-hub技术方案.md)
- [现状盘点与统一设计](../bayjf/docs/tier0/Tier0-model-hub现状盘点与统一设计.md)
- [落码任务列表](../bayjf/docs/tier0/Tier0-model-hub落码任务列表.md)

设计变更只回 bayjf 更新，本仓不复制设计文档。

## 快速开始

```bash
npm ci
cp apps/hub/.env.example apps/hub/.env.local   # 填入真实值，.env.local 已 gitignore
npm run dev                                     # http://localhost:8791/healthz
```

```bash
docker compose up --build                       # 绑定 127.0.0.1:8791
```

## 仓库结构

```text
apps/hub          Hono API + SQLite；Astro SSR 管理台（M2 起）
packages/model-kit 项目侧 TS 客户端（拉取/缓存/解析/L3-L4/usage）
contracts         下发契约 JSON Schema/OpenAPI（W1-1 起）
```

## 常用命令

```bash
npm run typecheck   # 各 workspace 类型检查
npm run lint        # ESLint
npm test            # Vitest
npm run build       # 各 workspace 构建
npm run check:all   # 以上串行，每个 W 结束必须全绿
```

## 安全

- 静态加密信封 `enc$v1$<kid>$<iv>$<ct>`（AES-256-GCM），API 只回显掩码。
- 数据目录与缓存 0600/0700；管理台 HMAC HttpOnly SameSite cookie。
- 真实 key 不入库、不进文档、不进日志与构建产物；部署仅内网 / Tailscale
  暴露，Caddy 终止 HTTPS。
