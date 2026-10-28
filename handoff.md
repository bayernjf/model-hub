# model-hub handoff（D 组 M7 收尾，2026-10-28）

本文件记录 M7 收尾的工程进展；设计事实仍以 bayjf `docs/tier0/` 文档为准。

## 2026-10-29 接力进展

- ~~ASR 语音识别（WebSocket 二进制协议）~~：**已完成**。`packages/model-kit/src/asr.ts`
  实现 SAUC 二进制帧（4B header + BE seq + BE payload size + gzip payload）、
  WAV PCM 解析、X-Api-Key 握手、分块上传、负序收尾包，`ModelKit.asr()` 接入。
  新增 `ws` 依赖（Node 全局 WebSocket 不支持握手自定义头）。9 个新测试
  （含本地真实 ws server 集成），check:all 23 files / 167 tests 全绿。
  原子提交：`chore ws 依赖` / `feat ASR 驱动` / `test ASR 测试`（8c6db28、9ac00ff、502af38）。
- ~~代码质量评审~~：**已完成**。后端（config/crypto/auth/repositories/routes/
  projection/revision/audit）、web islands、migrations、python client、contracts
  全部过一遍。整体质量高（见下方评审结论），发现并修复 4 类问题。
- ~~评审问题修复~~：**已完成**，check:all 23 files / 168 tests 全绿。4 个原子提交：
  - `72cfd26` feat(hub): 登录端点加暴力破解限流（10 次失败/15 分钟/IP）
  - `e6cd44d` feat(hub): AdapterDialect/Schema 补 auth_style/resource_id/nonstream
  - `3774320` feat(hub): 新增 openspeech 语音 preset（TTS + ASR 双流/单流）
  - `421f9ba` fix(web): 补 admin islands 缺失的 React keys
- ~~临时资源清理~~：**已完成**。停 cloudflared 隧道（PID 78933）；`docker compose down`
  移除 model-hub（含 backup sidecar）与 commerce-os 容器及网络（**保留 named volume 与
  ./backups**）；删除 /tmp 下 mhub-*、hub-server.log、sf-tunnel.log、sf13/sf14 db、
  cloudflared-bin/tgz。infra-* 容器未触碰。
- 后续任务清单：见文末「后续待推进任务」。

## 已完成（任务10–17）

- **W2-3 L1 / W2-4 L2 测试真实验证**：本地 hub（8791）建 Agnes-本机 provider，
  L1 连接测试 `ok`、L2 文本/图片 `ok`，审计三条 success。**2026-10-28 Ark Plan
  subscription 路径真实复跑成功**：Plan key 已由 owner 提供并经管理台录入，
  `ark-code-latest` L1 `ok`、`model_echo:"auto"`（订阅套餐特征）。图片模型
  `doubao-seedream-5.0-flash` L2 deep 真实生成 `ok`（~11s；顺带修复生成超时
  15s→60s，见下方 fix(test) 提交）。向量模型 `doubao-embedding-vision` L2 `ok`
  （embedding 模态，~0.5s）。
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
  compose 加 backup sidecar（7 天保留）；DEPLOYMENT.md 运行手册。**2026-10-28 本机
  Docker 实测全绿**：镜像构建 + 容器 healthy + healthz 200 + 备份快照 + 模型拉取
  （admin 登录→建项目→签发 token→`pub/v1/models` 200）。真实部署暴露并修复 5 个
  缺陷（Dockerfile syntax 行/db COPY/npm ci ignore-scripts、.dockerignore web、
  model-kit prepare 容错、backup sidecar sqlite3→node:sqlite），拆 2 个原子提交。

## 分支与提交

- model-hub：`feature/m7-wrapup`（已 push：`cfdbe64..ffdad5c`，含 W7-5 部署修复）。
- zeus/loom：`feature/model-hub-integration`（未 push）。
- growth-os：`feature/model-hub-optin`（未 push）。

## 本地验证基线

- model-hub `npm run check:all`：20 files / 153 tests 全绿。
- zeus：typecheck + build 通过；20 个失败测试为 undici `invalid onError method`
  环境问题（Node 26），stash 基线同现，与本次改动无关。
- loom：venv pytest，hub/content/registry 208 passed。

## 开放点

1. 视频/语音模型接入（部分受阻，多为非代码问题）：
   - 视频：Agnes `agnes-video-2.5-flash` 已登记（payg，`apihub.agnes-ai.com/v1`）。
     手动 curl 连通性通过（认证/模型/URL 正确），但 Agnes 视频队列当前满
     （`video_queue_full`，平台临时限制）。另发现 `probeVideoSubmit` 请求体硬编码
     `duration`，与 Agnes 的 `seconds/mode/size` 方言不兼容——L2 视频提交 body 需
     per-provider 适配（待办）。
   - 语音 TTS（`seed-tts-2.0`）：**2026-10-29 真实打通（owner 判断正确，此前
     "需 appid+token"的结论有误）**。认证用新版 `X-Api-Key` 单头——Ark Plan key
     直接可用；旧版 `X-Api-App-Id`/`X-Api-Access-Key` 双头不适用。音色字段为
     `req_params.speaker`，且**必须用 uranus_bigtts 系列**（mars/moon 系列属
     seed-tts-1.0，混用报 resource mismatch）。响应为 HTTP chunked JSON
     （`{code,data:base64}` 多块），拼接解码即 MP3。实测合成 24KB MP3
     （MPEG L3 64kbps/24kHz）。
     model-hub 适配注意：豆包语音是 X-Api-Key 单头 + 非标 body（text/speaker），
     现有 probe 系列为 Bearer + OpenAI 兼容，接入需方言适配（待办）。
   - 语音 ASR（`volc.seedasr.sauc.duration`）：仅 WebSocket 端点，model-hub 的 HTTP
     连接测试无法覆盖，需 WebSocket 探测能力（待办）。
2. W7-5 生产宿主机部署待定：本机 MacBook Docker 已实测全绿（镜像构建 + healthz +
   备份 + 模型拉取），制品可用。生产长驻部署改为**云服务器方案（最终选择，后续执行）**，
   原 zeus/loom 同机宿主机（hasee-2016-server）暂不可用。迁移要点见 DEPLOYMENT.md
   §「云服务器迁移」。
3. zeus 是 npm 项目、不支持 git 标签子目录依赖，暂留 `file:` 兄弟依赖（RELEASING.md 已记录）。
4. zeus ZEUS_DECISION_*（Jev 专用决策模型）未在 hub 注册，W7-3 仅下线 agnes 直连线；
   若 Jev 也要迁 hub 需另立模型条目。

## 代码质量评审结论（2026-10-29）

**总体评价：高。** 安全边界清晰、分层一致、测试扎实，无明显高危漏洞。

做得好的地方（应保持）：

- 所有 SQL 全占位符；动态 UPDATE 只拼接硬编码列名，无注入面。
- 密钥信封加密 AES-256-GCM，每条记录随机 IV；项目 token 只存 SHA-256。
- session token 用 HMAC 常量时间比较；数据文件强制 0700/0600；配置 fail-closed。
- owner overlay 写入走 zod `.strict()` 严格 allow-list，凭证/方言字段无法经 catalog 写入。
- 成本聚合 byok 只计量、不算 owner 成本；schema 索引与外键设计合理。
- 无 XSS sink（无 dangerouslySetInnerHTML/eval/innerHTML）。

已修复（见上）：登录无限流、方言类型缺语音字段、preset 缺语音 provider、React keys。

遗留（非阻塞，见后续任务）：clientIp 无 XFF 时回退 127.0.0.1（单机单用户可接受，
上反代后需确认信任链）。~~admin 端点未入契约~~ 已补齐（admin-openapi.yaml）。

## 后续待推进任务

按优先级排列；标注【受阻】的需要 owner 输入或外部条件，其余可直接做。

1. 【受阻】pricing 真实价格：成本看板要算准，需 owner 提供各模态真实单价
   （TTS 按千字符、ASR 按秒、视频按秒/分辨率档位）。当前语音 preset 价格留空。
2. 【受阻】云服务器迁移：最终方案，需 owner 确认服务器资源与时间；要点见
   DEPLOYMENT.md §「云服务器迁移」（原 hasee-2016-server 不可用）。
3. ASR 真实联调：当前仅 mock + 本地 ws server 测试，需用真实 key 跑通双流/单流。
   真实 key 已保存在 named volume `model-hub_model-hub-data`，起容器即可测。
4. TTS 真实联调：HTTP 已真实合成过 MP3，可再补一次端到端回归并固化音色。
5. 视频 Agnes 真实生成复测：队列曾满（video_queue_full），待平台恢复后 deep 复测；
   probeVideoSubmit 已按方言适配（create_body/seconds_field/omit_duration）。
6. ZEUS_DECISION_*（Jev 决策模型）在 hub 注册模型条目（若 Jev 也迁 hub）；
   受阻于 Jev base URL/key，且其 /decide 为非标准方言，需另立 provider。
7. （可选）登录失败计数持久化到 DB，支持多实例共享限流（当前为进程内内存）。

已在本轮推进：~~admin 端点补进 OpenAPI 契约~~（新增 `contracts/admin-openapi.yaml`，
18 paths / 29 operations，已交叉引用）。
