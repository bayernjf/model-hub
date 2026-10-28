# model-hub handoff（D 组 M7 收尾，2026-10-28）

本文件记录 M7 收尾的工程进展；设计事实仍以 bayjf `docs/tier0/` 文档为准。

## 已完成（任务10–17）

- **W2-3 L1 / W2-4 L2 测试真实验证**：本地 hub（8791）建 Agnes-本机 provider，
  L1 连接测试 `ok`、L2 文本/图片 `ok`，审计三条 success。Ark Plan key 不在本环境，
  subscription/reasoning 路径靠单测 + owner 2026-10-28 记录佐证（见开放点①）。
- **W4-1a 分发定案落码**：model-kit 随 monorepo 发版，消费方 Git 标签依赖
  （npm 不支持 monorepo 子目录、pnpm 需 `#vX.Y.Z&path:`、pip 需 `#subdirectory=`）。
  tag `v0.1.0` 已 push（bf5b2ab），从真实 remote 装通。
- **W7-1 growth-os opt-in 预留**：`src/modelhub/reservation.ts` + 84 tests 全绿，
  .env.example 登记预留变量。
- **W7-4 成本看板**：`GET /api/admin/costs` 聚合（project×source×day×model），
  builtin 算钱、byok 只计量；`/costs` 只读页面。实测 3750 micros 与手算一致。
- **W7-2 导入工具**：`scripts/import-existing-models.mjs`，幂等；zeus/loom 旧 agnes
  模型全部入 hub 并 enabled，对账 5/5 OK。
- **W7-3 env 下线**：zeus 删 ZEUS_LLM_*（实跑 `backendKind=hub`）；loom 删
  LOOM_LLM_*/LOOM_CONTENT_*、删 kill switch、内容底座门控改 hub 配置
  （实跑投影 revision 16、content→agnes-3.0-flash、video→agnes-video-2.5-flash）。
  两仓 208+ 相关测试全绿。
- **W7-5 部署**：Dockerfile 补齐 Astro web（原镜像会缺 entry.mjs 起不来）；
  compose 加 backup sidecar（sqlite3 .backup + 7 天保留）；DEPLOYMENT.md 运行手册。

## 分支与提交

- model-hub：`feature/m7-wrapup`（未 push，按约束仅任务17 部署相关 push；
  本机 Docker 守护进程未运行，镜像构建/起容器受阻，见开放点②）。
- zeus/loom：`feature/model-hub-integration`（未 push）。
- growth-os：`feature/model-hub-optin`（未 push）。

## 本地验证基线

- model-hub `npm run check:all`：20 files / 153 tests 全绿。
- zeus：typecheck + build 通过；20 个失败测试为 undici `invalid onError method`
  环境问题（Node 26），stash 基线同现，与本次改动无关。
- loom：venv pytest，hub/content/registry 208 passed。

## 开放点

1. Ark Plan key 不在环境：L1 subscription 路径复跑受阻，需要 key 后重跑。
2. W7-5 真实部署受阻：本机 Docker daemon 未运行；镜像构建/容器 healthz 未实测。
   已用离线 `docker compose config` + 本机 node 进程 healthz/pub 拉取佐证。
3. zeus 是 npm 项目、不支持 git 标签子目录依赖，暂留 `file:` 兄弟依赖（RELEASING.md 已记录）。
4. zeus ZEUS_DECISION_*（Jev 专用决策模型）未在 hub 注册，W7-3 仅下线 agnes 直连线；
   若 Jev 也要迁 hub 需另立模型条目。
