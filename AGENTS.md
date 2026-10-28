# AGENTS.md — model-hub

本文件供在本仓工作的 AI 协作 agent 使用。设计/需求/任务拆解的单一事实源
在 `bayjf/docs/tier0/`（三份 model-hub 文档，见下），本文只规定本仓工程纪律。

## 项目定位

model-hub 是 owner 单用户的**模型控制面（control plane）**：管理厂商凭证、
预置模型目录、按项目多对多分配；各项目用 project token 拉取"被分配的内置
模型"投影（含明文 key、端点、定价、预算），然后**直连厂商**推理。

hub 不是网关：不经手推理流量、不做流式中转、不做集中扣费；终端用户 BYOK
永远留在各项目内，hub 不触碰。

## 权威设计文档（在 bayjf 仓，改设计只回那里更新）

- `../bayjf/docs/tier0/Tier0-model-hub PRD.md`
- `../bayjf/docs/tier0/Tier0-model-hub技术方案.md`
- `../bayjf/docs/tier0/Tier0-model-hub现状盘点与统一设计.md`
- `../bayjf/docs/tier0/Tier0-model-hub落码任务列表.md`

## 技术栈

- Node.js 22（`node:sqlite` 需 `--experimental-sqlite`）、ESM、TypeScript strict
- 后端：Hono 4（`@hono/node-server`）
- 管理台（M2 起）：Astro SSR（node standalone）+ React 交互岛
- 测试：Vitest；包管理器：**npm workspaces**（禁止 pnpm/Yarn/Bun 锁文件）

## 仓库结构

```text
model-hub/
├── apps/
│   └── hub/            # @model-hub/hub：Hono API + SQLite；web/ 为 Astro 管理台
│       ├── src/
│       │   ├── server.ts        # 启动入口（绑定 HUB_PORT）
│       │   ├── app.ts           # 组装 Hono app（供测试）
│       │   ├── routes/          # admin/ 与 pub/ 路由
│       │   ├── db/              # 迁移与 repository（M1）
│       │   ├── crypto/          # 信封加密（M1）
│       │   ├── presets/         # 预置清单（M2）
│       │   └── auth/            # 管理会话与 project token（M1）
│       └── web/                 # Astro SSR 页面 + React 岛（M2，git 内独立构建）
├── packages/
│   └── model-kit/       # @model-hub/model-kit：项目侧 TS 客户端
└── contracts/           # 下发契约 JSON Schema/OpenAPI（W1-1 起）
```

## 常用命令（仓根执行）

```bash
npm ci                   # 按锁文件安装全部 workspaces
npm run dev              # hub 本地开发（HUB_PORT，默认 8791）
npm run typecheck        # 各 workspace tsc --noEmit
npm run lint             # eslint .
npm test                 # vitest run（覆盖 apps/*/test、packages/*/test）
npm run build            # 各 workspace 构建
npm run check:all        # typecheck + lint + test + build 串行
```

每个 W（里程碑工作项）结束必须 `npm run check:all` 全绿。

## 代码风格

- 严格按 tsconfig：`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、
  `noUnusedLocals`、`noUnusedParameters`。
- NodeNext 模块解析：相对导入写 `.js` 扩展名。
- 所有外部输入在服务端校验；repository 用 `?` 占位符，不拼接 SQL。
- 时间戳存 ISO-8601 文本；JSON 字段在 SQLite 用 `TEXT`。
- 测试命名 `*.test.ts`，放在各包 `test/`；不依赖真实外部服务与真实凭证。

## 环境变量（apps/hub）

- 浏览器/进程公开：无（hub 不向浏览器暴露 key）。
- 服务端：`HUB_MASTER_KEY`、`HUB_ADMIN_PASSWORD`、`HUB_PORT`、
  `HUB_DATA_DIR`、`HUB_DEV_NO_AUTH`（见 `apps/hub/.env.example`）。
- 真实 key 只经管理台 UI 录入加密入库，或放 gitignored 的 `.env.local`；
  禁止写入文档、提交历史、日志、构建产物。

## 加密与凭证纪律

- 静态加密统一信封 `enc$v1$<kid>$<iv>$<ct>`，AES-256-GCM；每记录随机 IV。
- API 回显只给掩码（末 4 位）；提交掩码形态值保留原 key，空 key 不动原值。
- project token 只存 SHA-256 哈希，明文仅创建/轮换时展示一次。
- 数据目录与缓存文件权限 0600（文件）/0700（目录）。

## Git

- 原子提交，英文 Conventional Commits（subject ≤ 50 字符、带 body），
  配置/功能/测试/文档分开提交，不加 AI co-author。
- 未明确授权前不 push；model-kit 以 **Git 标签依赖**（`git+ssh://…#vX.Y.Z`）
  被消费，semver 锁定，不建私有 registry；具体消费坐标、pnpm `path:`
  子目录语法与发布流程见 [RELEASING.md](./RELEASING.md)。
