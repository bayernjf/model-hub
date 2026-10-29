# model-hub handoff（D 组 M7 收尾，2026-10-28）

本文件记录 M7 收尾的工程进展；设计事实仍以 bayjf `docs/tier0/` 文档为准。

## 2026-10-29 接力进展

- ~~ASR 语音识别（WebSocket 二进制协议）~~：**已完成**。`packages/model-kit/src/asr.ts`
  实现 SAUC 二进制帧（4B header + BE seq + BE payload size + gzip payload）、
  WAV PCM 解析、X-Api-Key 握手、分块上传、负序收尾包，`ModelKit.asr()` 接入。
  新增 `ws` 依赖（Node 全局 WebSocket 不支持握手自定义头）。9 个新测试
  （含本地真实 ws server 集成），当轮记录 check:all 23 files / 167 tests；python 步骤
  当时实际为红，见下「复核接力」。
  原子提交：`chore ws 依赖` / `feat ASR 驱动` / `test ASR 测试`（8c6db28、9ac00ff、502af38）。
- ~~代码质量评审~~：**已完成**。后端（config/crypto/auth/repositories/routes/
  projection/revision/audit）、web islands、migrations、python client、contracts
  全部过一遍。整体质量高（见下方评审结论），发现并修复 4 类问题。
- ~~评审问题修复~~：**已完成**，Node 侧 23 files / 168 tests；python 步骤当时为红
  （见下「复核接力」）。4 个原子提交：
  - `72cfd26` feat(hub): 登录端点加暴力破解限流（10 次失败/15 分钟/IP）
  - `e6cd44d` feat(hub): AdapterDialect/Schema 补 auth_style/resource_id/nonstream
  - `3774320` feat(hub): 新增 openspeech 语音 preset（TTS + ASR 双流/单流）
  - `421f9ba` fix(web): 补 admin islands 缺失的 React keys
- ~~临时资源清理~~：**已完成**。停 cloudflared 隧道（PID 78933）；`docker compose down`
  移除 model-hub（含 backup sidecar）与 commerce-os 容器及网络（**保留 named volume 与
  ./backups**）；删除 /tmp 下 mhub-*、hub-server.log、sf-tunnel.log、sf13/sf14 db、
  cloudflared-bin/tgz。infra-* 容器未触碰。
- 后续任务清单：见文末「后续待推进任务」。

### 2026-10-29 复核接力（第二会话）

前一轮的 9 个提交与分支状态（`feature/m7-wrapup`，9 unpushed / 0 behind）逐项复核一致，
但有三处需要更正或补强：

- **`check:all` 当时并不全绿**。在 `79fd2c2` 实测：Node 23 文件 / 168 用例通过，但
  `test:python` 失败——`test_304_keeps_cached` 在 `exc.close()` 处抛
  `KeyError: 'file'`。已在隔离 worktree 的基线 `a46d3ec` 复现，**不是本批引入**：
  测试里 `HTTPError(..., fp=None)` 与真实 urllib 不符（真实 HTTPError 必带 fp），
  只有 Xcode 自带的 Python 3.9.6 才暴露。修法是让假件忠实（`io.BytesIO(b"")`），
  见 `bef90f9`。
- **`72cfd26` 的登录限流可被绕过**。`clientIp()` 取 `X-Forwarded-For` 的**最左段**，
  而 Caddy 把观测到的对端**追加在末尾**——攻击者每次换一个伪造首段就能拿到新桶，
  10 次/15 分钟的预算永不累积，审计里的 IP 也是伪造的。改为取最右段（`2017736`），
  并补 5 个用例（`e8bd0f2`）；其中两个在旧实现下必红（已植入缺陷实测验证）。
- 该限流提交原本**没有任何测试**，本次一并补上。

状态：`check:all` 全绿（**23 文件 / 173 用例** + Python 7 用例），工作区干净，
**12 个提交待 owner 授权后 push**（AGENTS.md：「未明确授权前不 push」）。

### ASR 真实联调（2026-10-29，已跑通）

用种子语音（`say` 合成 → 16k/16bit/单声道 WAV，4.78s）对 `openspeech.bytedance.com`
真实调用，**双流与单流均返回正确文本**：
`"今天的增装实验已经完成，请检查新的页面修复。"`（预期句为"增长"，同音误识属正常；
双流某次跑出的是正确的"增长"）。耗时 ~0.8–1.1s。成本：每轮 2 次真实调用（按秒计费，
价格未确认，见下）。

这一轮证明**假 socket 永远测不出的三处缺陷**，全部已修（`fix(asr)` 提交）：

1. **音频帧序列化标记错误**：`buildHeader` 给所有帧打 `SERIALIZATION_JSON`，纯音频帧
   应为 raw。服务端因此读不出音频。
2. **WAV 输入声明成 `format: 'wav'`**：客户端上传的是剥掉容器头的裸 PCM，服务端按
   WAV 容器解析，返回 **45000151（音频格式不正确）**。改为声明 `pcm`。
3. **双流没要最终结果**：`enable_nonstream` 只在单流模式为 true。双流据此只回
   `log_id + audio_info.duration`，**没有任何文本**。改为两种模式都请求最终非流式
   结果；`collect()` 同时改为优先取最后一个**非空**文本（双流会发空文本帧）。

**凭据/端点事实（与上一轮记录不同）**：

- 语音路由不在 `ark.cn-beijing.volces.com`（该 host 上 `/api/v3/plan/sauc/*` 与伪造
  路径一样返回 404；`x-api-key` 在该 host 上一律 401，只认 Bearer）。
- 语音在 `openspeech.bytedance.com`，且**同一把 Ark Plan key 在该 host 上可用**
  （x-api-key；TTS 路由返回语义错误 45000000 而非 401，sauc 路由返回 405 说明存在）。
- volume 里原本**没有 OpenSpeech provider**（只有 Ark Plan 与 Agnes）。已在
  **owner 授权**下新建（见下「OpenSpeech provider 登记」）。
- 两条 ASR preset 的 `submit_path`/`resource_id` 本身是对的，未改；只更新了注释里
  "尚未用真实 key 验证"的说法。

### OpenSpeech provider 登记（2026-10-29，owner 授权后执行）

- **provider**：`prov_4cc7051090a4168fb0139d4e94f1f508`，name=`OpenSpeech`，
  `preset_id=openspeech`、`protocol=openai-compatible`、
  `base_url=https://openspeech.bytedance.com`、`billing_type=subscription`、
  `api_key_hint=****10d1`（与 Ark Plan 同一把 key，掩码一致）。
- **写入方式**：一次性容器脚本（`model-hub:latest` 镜像内复用 hub dist 的
  `ProviderRepository.create` + `writeAudit` + `RevisionService.bump`），key 仅
  在进程内解密（从 Ark Plan 复用后重新信封加密落库），未落日志/未打印。
  audit：`aud_8b30e8fb09552eb17cf3b9f5add36a4f`（actor=owner，
  action=provider.create，detail 注明 owner-approved scripted write）；
  `catalog_revision` bump 至 10。
- **冒烟（写库后）**：从生产库解密 OpenSpeech key → `bigmodel_async` 双流真实
  识别 → 输出与预期一致：`"今天的增长实验已经完成，请检查新的页面修复。"`
  （含 utterances 逐词时间戳），916ms。验证了 解密→路由→握手→识别 全链路。
- 分支状态更新：3 个 ASR 提交（`bb2e96b` fix、`0053697` test、`c83034b` docs）
  已 push（`a2db6b2..c83034b`）。

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

- model-hub：`feature/m7-wrapup`（已 push：`cfdbe64..ffdad5c` 含 W7-5 部署修复；
  `a2db6b2..c83034b` 含 ASR 真实联调的 fix/test/docs 三提交）。
- zeus/loom：`feature/model-hub-integration`（未 push）。
- growth-os：`feature/model-hub-optin`（未 push）。

## 本地验证基线

- model-hub `npm run check:all`：**23 files / 177 tests + Python 7 tests 全绿，exit 0**
  （2026-10-29 ASR 真实联调后实测；此前记录的 20 files / 153 tests 是 W7 之前的口径）。
- zeus：typecheck + build 通过；20 个失败测试为 undici `invalid onError method`
  环境问题（Node 26），stash 基线同现，与本次改动无关。
- loom：venv pytest，hub/content/registry 208 passed。

## 2026-10-29 推进轮（第三会话，owner 授权「把能推进的搞了」）

- **TTS 端到端真实回归已完成并固化音色**：用生产库 OpenSpeech key（复用 Ark Plan key，
  信封解密进程内、未落日志）走真实 `synthesize` 驱动合成：`http=200`、1174ms、MP3
  `ID3` 头 32493 字节，ffprobe 确认 `mp3 / 4.06s / 64kbps`。过程中修正了请求体事实：
  TTS 是 **X-Api-Key 单头 + `X-Api-Resource-Id: seed-tts-2.0` + `req_params` 包装
  （`{text, speaker, audio_params}`）**——不带 resource-id 报 45000030、text 不在
  req_params 报 45000000「text and ssml are both empty」。preset 已固化音色
  `zh_female_vv_uranus_bigtts`。
- **视频 Agnes deep 复测**：`video_queue_full` 仍在（平台队列未恢复，任务被拒未计费）；
  提交 body 方言已确认走 adapter（create_body/seconds_field）。待平台恢复后再复测。
- **TTS probe 方言适配（代码）**：`connection-test.ts` 新增 `probeTts`（x-api-key +
  X-Api-Resource-Id + req_params 方言，解析 chunked JSON 的 `code`/base64 data；Bearer
  方言兼容 OpenAI TTS），`testModel` 增加 audio 模态分支，`testProvider` 对 voice-only
  provider 回退到 TTS 探测。提交 `6e2bb25`，check:all 181。
- **登录失败限流持久化（代码，handoff 可选项 #7）**：新增 `login_attempts` 表
  （migration 011）+ `PersistentLoginLimiter`（语义与内存版一致：10 次/15 分钟/IP、
  仅失败消耗、成功登录清除），session 路由替换内存限流器。提交 `04439fa`，
  check:all 183。
- **ASR WebSocket 探测能力（代码，handoff 开放点 #1 待办）**：`connection-test.ts`
  新增 `probeAsrWs`——ASR 仅 WebSocket 端点，HTTP 连接测试无法覆盖；握手级探测
  带 X-Api-Key/X-Api-Resource-Id/X-Api-Request-Id/X-Api-Connect-Id/X-Api-Sequence
  头，open 即认证+路由+resource id 通过，**不发音频、不产生按秒计费**；audio 模态
  按 submit_path 含 `/sauc/` 路由到 WS（ASR）vs HTTP（TTS）。hub 新增 `ws` 依赖。
  提交 `7338606`，check:all 186。
- 分支状态：本轮 3 个新提交（`6e2bb25`/`04439fa`/`7338606`）在本地
  `feature/m7-wrapup`。

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
     连接测试无法覆盖，需 WebSocket 探测能力（待办）。**provider 已于 2026-10-29
     登记**（OpenSpeech，见「ASR 真实联调」小节），驱动已跑通双流/单流真实识别。
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

遗留（非阻塞，见后续任务）：~~clientIp 无 XFF 时回退 127.0.0.1，上反代后需确认信任链~~
已按单跳 Caddy 取 `X-Forwarded-For` 的最右段（`2017736`）；若将来在前面再加一层可信
反代，最右段会变成那层代理、所有客户端共用同一个限流桶，必须先把跳数钉进配置
（见 `request.ts` 注释里的 flip condition）。~~admin 端点未入契约~~ 已补齐（admin-openapi.yaml）。

## 后续待推进任务

按优先级排列；标注【受阻】的需要 owner 输入或外部条件，其余可直接做。

1. 【受阻】pricing 真实价格：成本看板要算准，需 owner 提供各模态真实单价
   （TTS 按千字符、ASR 按秒、视频按秒/分辨率档位）。当前语音 preset 价格留空。
2. 【受阻】云服务器迁移：最终方案，需 owner 确认服务器资源与时间；要点见
   DEPLOYMENT.md §「云服务器迁移」（原 hasee-2016-server 不可用）。
3. ~~ASR 真实联调~~ **已完成（2026-10-29）**：双流/单流均对真实端点返回正确文本，
   并修出三处只有真实服务端才暴露的 wire 缺陷（见上「ASR 真实联调」）。**OpenSpeech
   provider 已登记**（`prov_4cc7051090a4168fb0139d4e94f1f508`，复用 Ark Plan key，
   写库后双流冒烟通过）。
4. TTS 真实联调：HTTP 已真实合成过 MP3，可再补一次端到端回归并固化音色。
   ~~（待办）~~ **已完成（2026-10-29）**：真实 `synthesize` 驱动回归通过（4.06s MP3，
   音色 `zh_female_vv_uranus_bigtts` 固化在 preset）。
5. 视频 Agnes 真实生成复测：队列曾满（video_queue_full），待平台恢复后 deep 复测；
   probeVideoSubmit 已按方言适配（create_body/seconds_field/omit_duration）。
   ~~（待办）~~ **2026-10-29 复测：队列仍满**，任务被拒未计费；方言 body 已实测正确，
   待平台恢复后再次 deep 复测。
6. ZEUS_DECISION_*（Jev 决策模型）在 hub 注册模型条目（若 Jev 也迁 hub）；
   受阻于 Jev base URL/key，且其 /decide 为非标准方言，需另立 provider。
7. ~~（可选）登录失败计数持久化到 DB，支持多实例共享限流（当前为进程内内存）。~~
   **已完成（2026-10-29）**：migration 011 + `PersistentLoginLimiter`，限流预算
   重启不丢、共享 DB 的多实例共享同一预算。

已在本轮推进：~~admin 端点补进 OpenAPI 契约~~（新增 `contracts/admin-openapi.yaml`，
18 paths / 29 operations，已交叉引用）。

## 2026-10-29 推进轮（第四会话，owner 授权「把剩余的给搞了」）

- **pricing 真实价格已填（handoff 后续任务 #1 解除受阻）**：火山引擎官方公开价
  抓取（2026-10-29）——豆包语音合成 5 元/万字符（0.5 元/千字符 → $0.075/kilo_char）、
  豆包流式语音识别 4.5 元/小时（→ $0.0001875/second）。来源：
  volcengine.com/product/doubao + ai.volcengine.com/model；汇率沿用 catalog
  声明的 1 USD = 6.666 CNY。提交 `37625b2`，hub typecheck 0 错、catalog 相关
  测试 34/34 绿。订阅制（ark-code）与视频（Agnes $0.025/秒、限时 $0/秒，
  docs/video-integration.md 已记录）维持原状。
- **model_overlays 4 行 enabled=0 判定为预期状态**：4 个模型（ark-code-latest /
  seedream-5.0-flash / embedding-vision / agnes-video-2.5-flash）均为登记未启用
  （preset_model_id=null、enabled=0，projection 三层全 enabled 才投给项目），
  assignments 表为空、无项目引用。安全默认，无需改动。
- **视频 Agnes 再复测：队列仍满**（`video_queue_full`，HTTP 503，request id
  2026102909010921722638a12F34JW，未计费）。平台限制未恢复，维持受阻。
- **云迁移脚本化（handoff 后续任务 #2 准备完毕）**：新增
  `scripts/migrate-to-cloud.sh`（export/import 两阶段幂等脚本：镜像 save/load、
  数据卷 pack/unpack、云侧重新生成密钥、compose up、健康检查、Caddy 片段），
  DEPLOYMENT.md §云服务器迁移补「一键脚本」小节。提交 `0904acb`。
  执行仍待 owner 确认云服务器资源与时间。

## 2026-10-29 zeus 决策模型接通（hub 侧分配，owner 授权「你搞」）

目标：用 `ark-code-latest`（Ark Plan 订阅）替代已下线的 Jev/直连通道，作为
zeus 决策后端；走 hub 主路径（非 env 直连）。以下条目本轮逐项核实/验证：

- ~~启动本地 hub~~：`model-hub` 容器在跑（`docker compose`，healthy，
  127.0.0.1:8791，含 backup sidecar），named volume `model-hub_model-hub-data`
  数据完好。
- ~~注册 zeus 项目 + token~~：`prj_8e9bf3701a8af05562d4fcdec29e3e2b`，
  slug=`zeus`，enabled；token `tok_dbae45acbf22c0b59867cac0f7c81557`
  （hint `****2329`，enabled）。
- ~~启用 overlay~~：`ark-code-latest`（`mdl_6008b68bfbe5719f61d401af9262be45`）
  enabled=1，modalities=text。
- ~~建别名 assignments~~：zeus 项目下三个别名 `noul` / `choice` / `score`
  均指向 ark-code-latest（role=primary，无日预算）。
- ~~投影验证~~：zeus token 拉 `GET /pub/v1/models` 返回 revision **17**，
  三个别名齐全（含 base_url `…/api/plan/v3`、直连凭证、chat 端点）。
- ~~真实连通性复测~~：`POST /api/admin/models/:id/test`（L1）`ok=true`，
  latency 2401ms，`model_echo=auto`（订阅套餐特征）。
- ~~zeus 侧装配实测~~：`node --env-file=.env` 跑 `resolveDecisionConfigWithHub()`
  返回 `backendKind='hub'`、backend 非 null（`hub:noul/choice/score`）、
  hubTest present；不再是规则兜底。

说明：上述项目/overlay/assignment 行在本轮接手时已存在（当日早些时候创建），
本轮工作为「端到端核实 + 真实 L1 复测 + zeus 装配验证」，未重复创建、未 rotate token。

待办：Jev 若后续提供 base_url/key，env 优先权仍保留、会自动胜出；视频/图片
等其余 overlay 维持 enabled=0 安全默认；云服务器迁移仍待 owner 定（见上）。

## 2026-10-29 五模态「分配 → model-kit 使用」闭环验证（第五会话）

目标：验证 model-hub 完整闭环——维护模型 → 按 alias 分配给项目 → 产品侧用
model-kit 以 alias 真实调用（不碰 URL/key/模型名）。

- **分配**：smoke-proj（`prj_6cc0aed63d47127835aa8d8ae3b2ab99`）分配 5 个模型，
  alias 如下（role=primary，无日预算）：
  - `content` → ark-code-latest（text）
  - `embed` → doubao-embedding-vision（embedding）
  - `image` → doubao-seedream-5.0-flash（image）
  - `video` → agnes-video-2.5-flash（video）
  - `voice` → seed-tts-2.0（audio，OpenSpeech preset）
- **model-kit 端到端真实调用结果**（`npx tsx`，hub=127.0.0.1:8791）：
  - `chat("content")` → ✅ 200，1064 token 真实回答（ark-code-latest 路由到
    Moonshot 系模型）
  - `embed("embed")` → ✅ 200，2048 维向量
  - `image("image")` → ✅ 200，真实生成 TOS URL（~11s）
  - `tts("voice")` → ✅ 200，27693 字节 MP3（MPEG L3 64kbps/24kHz；adapter 的
    auth_style=x-api-key / resource_id=seed-tts-2.0 / create_body 经投影正确下发）
  - `video("video")` → ⚠️ 提交 body 正确、Agnes 接受，但 `video_queue_full`
    （HTTP 503，平台队列满，未计费）
- **过程清理**：验证时误建了重复语音 provider `Ark Plan Voice`
  （`prov_b0ae6fc`）+ 手动模型 `doubao-seed-tts-2.0`（`mdl_f5392158`），已删除；
  改用已有 OpenSpeech provider（`prov_4cc705`）+ preset `seed-tts-2.0`
  （`mdl_e3fe5792`，enabled）。删除须先清 assignment 外键引用 → 删 model → 删
  provider（migration 012 的 FOREIGN KEY 约束）。

结论：**五模态「维护 → 分配 → 产品使用」闭环成立**，4 态真实跑通、video 受 Agnes
队列满限制（代码链路已通）。产品侧统一用 model-kit 的 chat/embed/image/video/tts/asr，
方言（X-Api-Key、异步轮询、非标 body、WebSocket）全由 hub 的 adapter 描述、model-kit
执行，产品不碰 URL/key/模型名。

## 2026-10-30 控制台交互加固（第六会话）

UI/UX 评审定级 P0 的四条交互安全问题全部落地（仅 `apps/hub/web`，无服务端改动）：

- **分配页保存护栏**（`c4f3ee0`）：整批保存是全量替换 PUT，误取消勾选会静默
  吊销产品侧 alias。现在：工具栏常驻"未保存：新增 N · 移除 N · 修改 N"角标
  （草稿 vs 服务端快照逐行 diff，alias/预算归一化比较，非法预算数字计为改动）；
  存在移除时保存前 `confirm` 列出将被移除的模型名；无改动时提示"无改动"不发请求。
- **切换项目丢弃前确认**（同上提交）：有未保存草稿时切换项目先确认，取消则
  重挂 select 回退 DOM（`selectKey` remount）。
- **保存反馈可辨**（同上提交）：成功 `--ok` 绿 / 失败 `--alert` 红 / 提示灰
  （tokens 新增 `.ok-text`），容器加 `role="status"` + `aria-live="polite"；
  修复保存失败也渲染成灰色 `.dim` 的问题。
- **模型页停用护栏**（`5199e1b`）：拉 `GET /api/admin/assignments` 全量列表按
  模型统计去重项目数，表格新增"分配"列（已分配 N 项目 tag）；停用已分配模型
  前确认"这些项目的调用会立即失败"；启用 checkbox 补 `aria-label`。
- 范围外未动：多 alias（migration 012）服务端已支持但分配页 UI 仍是一模型一
  alias 草稿（后续任务）；P1（加载失败静默、L2 结果不持久、裸微美元输入、
  搜索/日期过滤）未动。

验证：`npm run check:all` 全绿（23 文件 / 188 用例 + Python 7 用例 + build）。
环境注意：默认 shell Node 是 v20（Astro 7 拒跑），需前置 fnm 的 v22.23.1：
`export PATH="$HOME/.local/share/fnm/node-versions/v22.23.1/installation/bin:$PATH"`。
**3 个提交待 owner 授权后 push**（c4f3ee0、5199e1b、本 handoff 提交）。
