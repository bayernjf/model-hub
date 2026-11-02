# 代码评审报告 — model-hub（2026-11-02）

评审方式：只读静态评审 + 实跑验证门。未修改任何源码、未执行任何 git 写操作
（评审期间 `git status --short` 为空，工作区保持原样）。

## 一、仓库定位与规模概览

model-hub 是 owner 单用户的**模型控制面**（monorepo，npm workspaces）：
管理厂商凭证（AES-256-GCM 信封加密落库）、预置/手工模型目录、按项目多对多
分配；各项目用 project token 经 `GET /pub/v1/models` 拉取含明文 key 的投影后
**直连厂商**推理——hub 不经手推理流量（`AGENTS.md:8-13`、`README.md:6-8`）。

| 维度 | 实测 |
|---|---|
| 源文件 | 104 ts + 7 tsx + 9 astro + 5 py + 15 sql + 5 mjs + 3 sh + 2 yml/yaml + 1 css ≈ **151 个**（不含 node_modules/dist/.astro/产物；与任务给的"约 317"口径不同，317 应为含生成物/锁文件的全量口径） |
| 代码量 | 上述源文件合计 **20,277 行**（`wc -l` 实测；任务给的 4.2 万行应为含 lock/生成物口径） |
| 分层 | `apps/hub`（Hono API + SQLite + Astro SSR 管理台）、`packages/model-kit`（项目侧 TS 客户端）、`clients/python`（Python 客户端）、`contracts`（JSON Schema/OpenAPI + fixtures）、`db/migrations`（15 个迁移）、`scripts`（备份/迁移/检查） |
| 部署 | 多阶段 Dockerfile（node:22-slim，非 root）+ docker-compose（loopback 127.0.0.1:8791 绑定 + backup sidecar），Caddy 内网/Tailscale 反代 |
| 测试 | Vitest 33 文件 / 290 用例 + Python 7 用例（实跑全绿） |

## 二、结论摘要

**计数：P0 × 0，P1 × 1，P2 × 2，P3 × 7。** 整体质量高：加密/认证/SQL 纪律扎实，
测试真实且全绿，设计令牌无漂移，CI 门禁真实有效。

最关键 3 条：

1. **P1 — dev-no-auth 缺第二道防线**：生产拓扑（同机 Caddy → loopback:8791）下
   所有请求的 socket peer 都是 127.0.0.1，`isLoopbackPeer` 恒真；一旦
   `HUB_DEV_NO_AUTH=1` 误入生产环境（如手动 `node dist/server.js` + 导出环境变量），
   全部外部流量直接获得 owner 会话，无任何兜底（`NODE_ENV=production` 不拦截、
   密钥已配置时不拒绝）。当前 compose/Dockerfile 路径已确认干净，属"配置失误即裸奔"
   的潜在风险。
2. **P2 — 根 `.env` 含真实 `HUB_MASTER_KEY`/管理员密码且权限 0644**：
   违反本仓自己"敏感文件 0600"的纪律（`AGENTS.md:91`）。
3. **P2 — `backups/*.db` 快照权限 0644**：内容虽为信封密文，但含 token 哈希、
   审计 IP、全量配置，与 live 库 0600/目录 0700 的基线不一致。

## 三、逐条发现

### P1-1 dev-no-auth 在生产反代拓扑下无纵深防御

- **位置**：`apps/hub/src/config.ts:71`（触发）、`apps/hub/src/auth/middleware.ts:36-44`（授权）、`apps/hub/src/auth/request.ts:44-56`（loopback 判定）、`docker-compose.yml:11-15`、`DEPLOYMENT.md:53-72`（生产拓扑）
- **证据**：
  - 触发条件为精确匹配 `HUB_DEV_NO_AUTH === '1'`（`config.ts:71`）；未设时 fail-closed
    强制 `HUB_MASTER_KEY>=16` + `HUB_ADMIN_PASSWORD>=12`（`config.ts:80-91`）。
  - `requireAdmin` 在 devNoAuth 时仅校验 `isLoopbackPeer(c)`（socket 对端地址，
    `request.ts:44-56`；无 socket 时 fail closed）。**Host 头伪造无效**——判的是
    TCP 对端不是 Host（`request.ts:38-40` 注释明确）。
  - 生产拓扑：Caddy 与 hub 同机，反代 `127.0.0.1:8791`（`DEPLOYMENT.md:57-68`），
    compose 端口绑定 `127.0.0.1:8791:8791`（`docker-compose.yml:16-18`）。
    **因此经 Caddy 到达 hub 的每个请求，socket peer 都是 127.0.0.1**。
  - 生产隔离现状（均为正面证据）：Dockerfile runner 不拷贝 `.env.local`
    （`Dockerfile:38-41` 只拷 dist 与 db）；compose `environment:` 只声明
    MASTER_KEY/ADMIN_PASSWORD/PORT/DATA_DIR（`docker-compose.yml:11-15`），
    即使根 `.env` 有 DEV_NO_AUTH 也不会注入容器；`scripts/migrate-to-cloud.sh:63`
    云侧用 `.env.example`（其中 `HUB_DEV_NO_AUTH=0`）重新生成密钥文件；
    `DEPLOYMENT.md:32` 明示"生产不要设"。
  - 残余路径：绕过 compose 直接 `node apps/hub/dist/server.js`（或 `npm start`）
    且环境里有 `HUB_DEV_NO_AUTH=1` 时，`requireAdmin` 给所有经 Caddy 的外部请求
    发放 `role:'owner'` 合成会话（`middleware.ts:38-42`），管理 API 全开。
    启动日志仅一行 `(dev-no-auth)`（`server.ts:60-62`）。
  - 实测：`apps/hub/.env.local` 当前含 `HUB_DEV_NO_AUTH=1`（
    `node --env-file=.env.local -e ...` 输出 `DEV_NO_AUTH = "1"`），本地 dev 依赖
    该模式（近期修复 `2c69d61`/`004fce5` 的目的）。
- **影响**：一次环境变量误配置即导致管理面（厂商密钥掩码、project token 签发、
  分配改写）对内网/Tailscale 全网开放。当前不可利用（compose 路径干净）。
- **修复建议**（任一即可显著降险，建议叠加 1+2）：
  1. `loadConfig` 增加：`NODE_ENV=production` 且 `HUB_DEV_NO_AUTH=1` 时抛
     `ConfigError`（Dockerfile runner 已设 `NODE_ENV=production`，`Dockerfile:27`）。
  2. `devNoAuth` 生效时要求 `HUB_MASTER_KEY`/`HUB_ADMIN_PASSWORD` 均未配置，
     两者同现时拒绝启动（杜绝"带着真实密钥的 dev 模式"）。
  3. 启动横幅升级：`devNoAuth` 时用 `console.error` 输出显著告警。

### P2-1 根 `.env` 含真实主密钥与管理员密码，权限 0644

- **位置**：`/Users/jiangfeng/000mycodes/model-hub/.env`（compose 变量替换文件）
- **证据**：`stat` 显示 `-rw-r--r--`，内容为真实
  `HUB_MASTER_KEY=9f3a…3b4c`（32 位 hex）与 `HUB_ADMIN_PASSWORD=DevAdminPass-2026-strong`。
  已确认被 `.gitignore:17` 忽略、`git ls-files` 不含它（未入库）。对照：
  `apps/hub/.env.local` 为 0600、`apps/hub/data/model-hub.db` 为 0600、
  `apps/hub/data` 为 0700，均符合纪律（`AGENTS.md:91`）。
- **影响**：同机其他用户可读主密钥——主密钥可解开所有厂商 API key 信封密文。
  单用户 MacBook 场景现实风险低，但与仓内自身基线矛盾。
- **修复建议**：`chmod 600 .env`；在 `DEPLOYMENT.md` 首次部署步骤中补一句权限要求。

### P2-2 备份快照 `backups/*.db` 权限 0644

- **位置**：`backups/hub-2026*.db`（6 个文件）、`scripts/backup-hub.sh:18`
- **证据**：`stat` 显示 6 个快照均 `-rw-r--r--`；备份由 sidecar 容器内
  `VACUUM INTO` 生成（`backup-hub.sh:18`），bind mount 到宿主 `./backups`
  （`docker-compose.yml:31`）。内容 = live 库全量拷贝：信封密文（非明文 key）、
  project token 的 SHA-256 哈希与掩码 hint、`admin_audit` 中的 IP、全部目录配置。
  live 库本体为 0600、数据目录 0700（实测 `apps/hub/data` 为 `drwx------`）。
- **影响**：敏感元数据（内网 IP、项目结构、token 哈希）对同机其他用户可读；
  与仓内 0600 纪律不一致。无明文 key 泄露。
- **修复建议**：`backup-hub.sh` 写文件后 `chmod 600 "$OUT"`，或 sidecar 设
  `umask 077`。

### P3-1 管理台 Astro 页面无服务端会话门（仅信息暴露）

- **位置**：`apps/hub/web/src/pages/*.astro`、`apps/hub/web/src/islands/api.ts:11-18`
- **证据**：`providers.astro` 等页面无 frontmatter 会话校验，直接渲染
  `ConsoleLayout` + React 岛；数据加载在浏览器侧 `apiJson('/api/admin/...')`，
  API 401 时跳转登录页（`api.ts:12-17`）。即未登录可拿到完整控制台 HTML/JS
  骨架（导航、页面结构、打包后的 island 代码），但拿不到任何数据。
- **影响**：管理 UI 结构对外可见（纯信息暴露，无数据）。
- **修复建议**：SSR 层校验 `hub_session` cookie（HMAC 校验可在 Astro 侧复用
  sessionKey），未登录直跳 `/login`。优先级低。

### P3-2 知识库查询为全量内存余弦扫描

- **位置**：`apps/hub/src/knowledge/service.ts:190-199`
- **证据**：`listEmbeddedChunks(owner)` 取出该 owner 全部 chunk 后逐条
  `JSON.parse` 嵌入向量并算 cosine，再排序取 topK。migration 012 头注释明确
  这是有意为之的 MVP（"brute-force in-memory cosine scan … no vector
  extension"）。
- **影响**：chunk 数到数万级后每次 query 延迟与内存线性增长；当前单用户小规模
  无实际问题。
- **修复建议**：达到阈值后引入 sqlite-vec 或物化向量列 + 分块扫描；暂可不动。

### P3-3 CI 用 `npm install` 而非 `npm ci`

- **位置**：`.github/workflows/ci.yml`（"Install dependencies" 步）
- **证据**：workflow 中 `run: npm install`；仓内 `package-lock.json`（327KB）
  已提交且 Dockerfile 两阶段均用 `npm ci --ignore-scripts`（`Dockerfile:11,36`）。
- **影响**：CI 依赖解析可能漂移，与本地/镜像构建不完全同源，削弱"锁文件即真相"。
- **修复建议**：改为 `npm ci`。

### P3-4 基础镜像仅钉大版本，未钉 digest

- **位置**：`Dockerfile:2,26`（`node:22-slim`）、`docker-compose.yml:26`（backup sidecar 同镜像）
- **影响**：上游 minor/patch 变更会进入构建，可复现性弱；`node:sqlite` 仍是
  experimental（启动警告实测可见），Node 22 线内行为变化理论上可影响运行时。
- **修复建议**：钉 `node:22-slim@sha256:<digest>`，配合定期升级。

### P3-5 `server.ts` 未显式绑定 host，启动日志写 localhost 有歧义

- **位置**：`apps/hub/src/server.ts:59-63`
- **证据**：`server.listen(config.port, ...)` 无 host 参数（Node 默认绑
  `::`/0.0.0.0），日志却打印 `listening on http://localhost:8791`。容器内需
  绑全网卡才能被 published loopback 端口映射到，属必要；但宿主机直接 `npm run
  dev/start` 时 LAN 也可达——此时 `requireAdmin`/`isLoopbackPeer` 是唯一的门。
- **影响**：无直接漏洞（认证仍生效），但日志误导 + 默认暴露面比文档口吻大。
- **修复建议**：支持 `HUB_HOST`（默认 `0.0.0.0`，文档说明），或日志如实打印
  绑定地址。

### P3-6 无测试覆盖率门禁；`Costs.tsx` 有 2 个未使用 import 提示

- **位置**：`vitest.config.ts`（无 coverage 配置）、`apps/hub/web/src/islands/Costs.tsx:1,3`；`eslint.config.js:22-25`
- **证据**：`astro check` 输出 2 hints（`useCallback`、`errorText` 未使用）；
  ESLint 显式关闭 `no-unused-vars`（依赖 tsc，但 web 侧是 `astro check` 的
  hint 级，不阻断）。
- **影响**：覆盖率不可量化（但实测 290 用例无 skip/todo/假断言，见第四节）；
  未使用 import 纯噪音。
- **修复建议**：清理 2 个 import；可选接入 `vitest --coverage` 并设底线。

### P3-7 README「常用命令」漏列 `test:python` 与 `check:tokens`

- **位置**：`README.md:52-60` vs `package.json:24-26`
- **证据**：根 `check:all` 含 5 步（typecheck/lint/test/test:python/build），
  README 只列 4 步；`check:tokens` 有 CI 门禁（ci.yml "Design tokens in sync"）
  但文档未提。
- **影响**：文档与实现轻微不一致，新接手者可能漏跑 python 与令牌检查。
- **修复建议**：README 补齐两条命令。

## 四、验证门实际执行结果

全部在 macOS、Node v22.23.1（fnm 路径，handoff 指定）、npm 10.9.8 下真实执行，
普通沙箱运行未被拒绝：

| 门 | 命令 | 结果 | 关键输出 |
|---|---|---|---|
| 类型检查 | `npm run typecheck` | **exit 0** | hub/model-kit tsc 0 错；web `astro check` 22 files **0 errors / 0 warnings / 2 hints**（Costs.tsx 未使用 import） |
| Lint | `npm run lint` | **exit 0** | `eslint .` 无输出（全过） |
| 单元/契约测试 | `npm test` | **exit 0** | **Test Files 33 passed (33) / Tests 290 passed (290)**，3.88s |
| Python 客户端 | `npm run test:python` | **exit 0** | `Ran 7 tests ... OK` |
| 构建 | `npm run build` | **exit 0** | hub tsc + Astro SSR（含 14 条 Vite 弃用警告，仅 esbuildOptions 命名层面，非错误）+ model-kit tsc；产物 `apps/hub/dist/server.js`、`apps/hub/web/dist/server/entry.mjs` 均生成 |
| 迁移链 | `bash scripts/check-migrations.sh` | **exit 0** | `OK: sqlite migrations (15 files, table set verified)` |
| 设计令牌 | `npm run check:tokens` | **exit 0** | `tokens ok: apps/hub/web/src/styles/tokens.css`（块哈希 = tokens.lock = `646cdcaf…c6f8`）；另跑 console-ui 侧 `scripts/sync.mjs` 输出 `ok: …/model-hub/…/tokens.css`，双向确认无漂移 |
| dev 链路静态自洽 | `node --experimental-sqlite --experimental-transform-types --import ./dev-resolve.mjs --env-file=.env.local -e …`（apps/hub 目录） | **exit 0** | flag 组合 + env-file + dev-resolve 挂载全部可用；输出 `HUB_PORT = 8791`；未真正起服务（只读评审不起常驻进程）。`dev-resolve.mjs` 逻辑复核：仅在 `.js` 不存在且 `.ts` 存在时重定向，构建产物（dist 真实 `.js`）不受影响；`server.ts:28-30` 已带 node env 转发（`2c69d61` 修复点），`isLoopbackPeer` 运行时可获 socket |

测试真实性抽查：全仓 `grep` 无 `.skip`/`.todo`/`.only`（唯一命中是
`models-crud.test.ts:104` 的断言语句 `data.skipped`，属业务字段）；无
`expect(true).toBe(true)` 类假断言；`contracts.test.ts` 用 ajv 对 4 份
schema + 4 份 fixture 做真实校验；`auth.test.ts`/`pub-models.test.ts` 等覆盖
401/403/限流分支。未跑覆盖率（无配置）。

凭据扫描：`clients/python/`（178 行）无真实凭据，测试全部注入 fake opener；
`backups/` 为加密快照（见 P2-2）；仓内无其他明文密钥文件；`.env`、
`.env.local`、`backups/`、`apps/hub/data/` 均被 gitignore 且未入库
（`git check-ignore -v` 四项全部命中）。

## 五、修复优先级建议

1. **先做（一次提交可完成）**：P1-1 的 `NODE_ENV=production` 拒绝启动 +
   `chmod 600 .env`（P2-1）+ `backup-hub.sh` 补 `chmod 600`（P2-2）+
   CI 改 `npm ci`（P3-3）。四条都是几行改动，直接消除本次全部 P1/P2。
2. **随后**：P3-5（`HUB_HOST`/日志如实）、P3-6（清理 2 个未使用 import）、
   P3-7（README 补命令）、P3-4（镜像钉 digest）。
3. **观察项（无需立即动）**：P3-1（Astro 页面 SSR 会话门）与 P3-2（知识库
   暴力扫描）——单 owner 小规模下现状可接受，分别在内网暴露面扩大或语料增长
   后再处理。

### 附：本次复核确认无需改动的关键点（正面证据存档）

- SQL 全部 `?` 占位符；动态 UPDATE 只拼接硬编码列名
  （`repositories/providers.ts:139-151`、`projects.ts:168-184`）。
- 会话 token HMAC + `timingSafeEqual`（`auth/session.ts:46`）；cookie
  `HttpOnly; SameSite=Strict`（`session.ts:81`）；登录限流 10 次/15 分钟/IP
  且持久化（migration 011 + `login-limiter.ts`）；XFF 取最右段并有 flip
  条件注释（`auth/request.ts:4-16`）。
- project token 只存 SHA-256、明文仅签发时返回一次
  （`repositories/projects.ts:204-225`）；厂商 key 回显仅掩码
  （`repositories/providers.ts:56-70`）。
- 分配整批替换包在 BEGIN/COMMIT/ROLLBACK 事务内
  （`repositories/assignments.ts:174-198`）；alias 重复/空值/角色校验齐全。
- 全局 `onError` 只回 `{code:'server_error'}`，不泄内部细节
  （`app.ts:144-147`）；预算 webhook fire-and-forget 不阻塞用量上报
  （`routes/pub.ts:213-235`）。
- 无 `dangerouslySetInnerHTML`/`innerHTML`/`eval`（grep 零命中）；登录
  `?next=` 有开放重定向防护（`web/src/lib/safe-next.ts`，6 个单测）。
- `/pub/v1/models` 明文下发 key 是文档明示的设计决策
  （`AGENTS.md:8-13`），非缺陷；其风险面 = project token 本身，token 泄露
  即所分配模型 key 泄露，建议在后续轮换流程文档中保持该结论可见。
