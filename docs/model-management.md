# 模型管理与激活（model-hub 控制面说明）

> 状态：实现/操作说明，2026-11-19。
> 本文说明本仓“模型如何被管理、如何被激活、如何下发给项目、用量如何回传”。
> 它是工程说明，**不替代** `bayjf/docs/tier0/` 的 PRD / 技术方案；设计变更只回那里更新。
> 本文不记录任何真实 API key、project token、密文或末四位。

## 1. 一句话定位

model-hub 是**模型控制面**，不是推理网关：

```text
管理台 / Admin API
        │ 写 provider、model、assignment、key pool
        ▼
   model-hub（SQLite）
        │ GET /pub/v1/models（project token）
        ▼
   项目投影（base_url + key + model + pricing）
        │ 项目自己直连厂商
        ▼
厂商 API ── 项目把用量 POST /pub/v1/usage ──▶ model-hub usage_events / costs
```

边界：

- hub 不经手推理流量、不做流式中转、不做集中扣费。
- 项目拿到的投影里包含**明文厂商 key**；project token 只是拉取投影的凭证，不是厂商 key。
- 终端用户 BYOK 留在各项目内，hub 不感知、不触碰。
- 因为 key 已经下发到客户端，hub 改 key **不能自动撤销**客户端缓存里的旧 key；要彻底停用必须在厂商侧禁用/轮换，并让消费方重新同步。

## 2. 实体与职责

| 实体 | 作用 | 关键字段 |
|---|---|---|
| Project | 一个消费方项目 | `slug`、`enabled`、project token（哈希存储） |
| Provider | 一个厂商接入点 | `base_url`、`protocol`、`billing_type`、`enabled`、legacy key |
| Provider key | 同一 provider 的 key 池 | `is_active`、`seq`、`status`、`cooled_until`、密文/hint |
| Model | 上游模型目录项 | `provider_id`、`model`、`modalities`、`pricing`、`enabled`、`is_default`、`sort_order`、`reasoning` |
| Assignment | 把模型分配给项目 | `project_id`、`model_id`、`alias`、`role`、`daily_budget_micros` |
| Usage event | 项目回传的调用记录 | provider/model/project、token 数、`cost_micros`、org 归因；**无 key id** |
| Revision | 投影版本号 | 管理变更后自增；`/pub/v1/models` 用它做 ETag |

两条硬约束：

1. **凭证只能挂在 provider / key pool。** 模型的 overlay 写入是严格白名单，只允许
   `modalities`、`pricing`、`enabled`、`is_default`、`sort_order`、`reasoning`；
   `model`、`base_url`、`api_key`、`protocol`、`endpoints`、`adapter`、`litellm_id`
   等都不能经模型目录层写入。
2. **一个 assignment 是一个“项目 alias → 模型”的映射。** 同一项目可以有多个
   alias（`content`、`text`、`vision`、`embed`、`voice` 等），也可以是
   `primary` / `fallback` 角色；没有 assignment 的模型不会出现在该项目目录里。

## 3. 管理动作的实际语义

### 3.1 新增/编辑 Provider

- 选择预置厂商或手填 `base_url`、`protocol`、`billing_type`。
- `billing_type=subscription` 表示套餐制，`payg` 表示按量；它影响成本页的
  解释口径，不改变请求路径。
- 先做连接测试，再启用；`enabled=0` 时该 provider 下所有模型都不会投影。
- 旧的单 key 字段仍保留一个迁移周期；新建 provider 的第一把 key 会进入
  legacy 列，之后加 key pool 时被提升为 `seq=0` 的池行。

### 3.2 新增/编辑 Model

- 可以按预置清单批量导入，也可以手填模型名、显示名、模态、上下文窗口、
  endpoint override、adapter 方言、定价等。
- 模型的 `enabled`、`pricing`、`modalities`、默认标记和排序属于 owner overlay，
  可随时改；**模型行本身不带 key**。
- 模型只有被 assignment 到某个项目后，才会出现在该项目的投影里。

### 3.3 分配（Assignment）

- 分配页按项目整批保存：`PUT /api/admin/assignments` 接收
  `{ project_id, assignments[] }`，**整批替换**该项目当前分配集。
- 每条 assignment 至少要有 `model_id`；可选 `alias`、`role`、`daily_budget_micros`。
- 修改后 `revision` 自增；项目下次拉投影时会看到新目录。
- 同一个模型可以给多个项目、多个 alias；删掉 assignment 等于从该项目撤下该模型。

### 3.4 Key 池

- 一个 provider 可以有 0..N 把 key；`is_active=1` 才进入可用池。
- 可用池按 `seq` 升序；`status=quota_exhausted` 且 `cooled_until` 未到期的 key
  会被过滤；冷却到期后自动恢复可用。
- key 池非空时，投影只读池，不再读 legacy 单 key。
- key 池为空时，回退到 provider 的 legacy `api_key_cipher`；两者都没有，模型不会投影。
- 最后一把 active key 不能被停用或删除（服务端 409）；要换 key 先加新 key，再停旧 key。
- key 轮换/故障转移由项目侧 model-kit 在请求内完成；hub 只负责下发有序
  `api_keys` 列表和记录配额失败信号，不实时拉厂商余额。

## 4. 一个模型“激活”的判定链

项目请求 `GET /pub/v1/models` 时，投影按以下顺序过滤：

| 顺序 | 条件 | 不满足时 |
|---|---|---|
| 1 | project token 有效 | 401，无投影 |
| 2 | project 有 assignment | 该模型不出现 |
| 3 | model 存在且 `enabled=1` | 该模型不出现 |
| 4 | provider 存在且 `enabled=1` | 该模型不出现 |
| 5 | key 池有可用 key，或 legacy key 存在 | 该模型不出现 |
| 6 | 客户端 revision 与 hub 不同 | 返回新投影；相同则 304 |

常见误判：

- **“模型页已启用”不等于“项目可用”**：没有 assignment 就不会下发。
- **“assignment 已存在”不等于“能调用”**：provider 停用、model 停用、key 全部
  inactive/冷却中，都会让投影为空。
- **“key 池为空”不等于“没有 key”**：可能仍在用 legacy key；这正是迁移期的
  兼容路径。
- **“hub 里改了 key”不等于“客户端立刻换 key”**：客户端可能持有旧投影缓存，
  需要重新同步/重启；旧 key 在厂商侧仍然有效。

## 5. 投影契约（`GET /pub/v1/models`）

请求：

```http
GET /pub/v1/models
Authorization: Bearer <project-token>
If-None-Match: "<revision>"   # 可选
```

响应（字段按 `ProjectionService` 实际输出，key 值一律省略）：

```jsonc
{
  "project": "example-project",
  "revision": 42,
  "fetched_at": "2026-11-19T00:00:00.000Z",
  "models": [
    {
      "assignment_id": "asn_...",
      "alias": "text",
      "role": "primary",
      "daily_budget_micros": null,
      "modalities": ["text"],
      "model": "example-model",
      "litellm_id": null,
      "display_name": "Example Model",
      "protocol": "openai-compatible",
      "base_url": "https://vendor.example/v1",
      "api_key": "<redacted: first usable key>",
      "api_keys": [
        { "key": "<redacted>", "keyId": "pkey_...", "label": "primary" }
      ],
      "endpoints": { "chat": "/chat/completions" },
      "adapter": null,
      "context_window": 32768,
      "supports_json": true,
      "supports_stream": true,
      "pricing": {
        "input_usd_per_million": 2.5,
        "output_usd_per_million": 15
      }
    }
  ]
}
```

要点：

- `api_key` 是兼容字段，等于 `api_keys[0].key`；新客户端应读 `api_keys` 顺序。
- `api_keys` 只包含 active 且未冷却的 key，顺序即 `seq`。
- 响应头带 `ETag: "<revision>"` 和 `Cache-Control: private, no-cache`；
  客户端带相同 `If-None-Match` 时返回 304。
- 投影里的 `pricing` 是成本估算用的列表价，不等于厂商实际账单；subscription
  套餐尤其只是估算。
- 任何管理变更（provider/model/assignment/key）都会 `revision.bump()`，但只有
  客户端重新拉取才生效。

## 6. 客户端缓存与“旧 key 还在用”

这是控制面架构的必然结果，不是 bug：

1. 项目启动或定时同步时拉 `/pub/v1/models`，把投影缓存到本地（通常 0600）。
2. 运行中的请求直接使用缓存里的 `base_url + api_key` 调厂商。
3. hub 不可用时，项目可以继续用缓存运行；这是设计目标。
4. 因此 hub 修改/停用 key 后：
   - 已缓存的客户端仍可能继续用旧 key；
   - 有本地 `.env` 直连 key 的项目会完全绕过 hub；
   - 要让旧 key 真正失效，必须在厂商侧停用/轮换，并清理客户端直连配置，
     再让客户端重新同步投影。

**排查“为什么还有别的 key 在产生用量”时，先查三处：**

- model-hub 当前 assignment 指向的 provider/key 池；
- 各项目本地 `.env` / `config` 中是否有直连厂商 key；
- 客户端投影缓存是否还是旧 revision。

## 7. 用量与成本

- 项目通过 `POST /pub/v1/usage` 回传；写入是 append-only，失败也会记零用量。
- 关键字段：`project`、`feature`、`billing_source`（builtin/byok）、`provider`、
  `model`、`assignment_id`、输入/输出/缓存/推理 token、`http_status`、`degraded`、
  可选的 org 归因（`position_id`/`department_id`/`task_id`）和时间戳。
- `usage_events` **没有 key_id**：同一 provider 多把 key 时，无法把某次调用精确
  归到某把 key；账只能到 provider/model/project/assignment 维度。
- `GET /api/admin/costs` 聚合 token 与 `cost_micros`；`GET /pub/v1/usage/summary`
  返回项目当天各 assignment 的花费与预算百分比。
- `cost_micros` 只对 builtin 流量计算；BYOK 流量的成本字段为 null，不计入
  hub 的预算/成本口径。
- pricing 为空或占位值的模型会显示 0 成本，但这**不代表免费**；上生产/计费前
  必须补真实单价。

## 8. 运营检查清单

### 新增一个项目可用模型

1. Provider 已存在且 `enabled=1`。
2. Provider 至少一把可用 key（池或 legacy）。
3. Model 已创建/导入且 `enabled=1`，模态和定价正确。
4. 在目标项目创建 assignment，填 alias / role / 预算。
5. 用该项目 token 拉 `/pub/v1/models`，确认模型出现、`base_url` 和 `api_keys`
   正确（不要在日志/终端回显明文）。
6. 项目侧重新同步或重启，跑一次最小请求，确认 usage 回传。

### 停用一个模型

- 只想对某个项目撤下：删对应 assignment。
- 想对所有项目撤下：把 model `enabled=0`。
- 想连厂商一起停：把 provider `enabled=0`；这会影响该 provider 下所有模型。
- 改完通知消费方重新拉投影；不要假设运行中的进程会自动换目录。

### 轮换 key

1. 先在 key 池加新 key，确认 active、`seq` 顺序正确。
2. 让项目重新同步投影，确认新 key 已被使用。
3. 再停旧 key；最后一把 active key 服务端会拒绝停用。
4. 旧 key 在厂商侧禁用/删除，防止缓存客户端继续使用。

## 9. 排障矩阵

| 现象 | 优先检查 | 说明 |
|---|---|---|
| 项目投影为空 | token、assignment、model/provider enabled、key 池 | 任一层失败都会静默过滤 |
| 模型出现但调用 401/403 | `api_keys`、厂商 key 状态、base_url | hub 只下发，不代理；认证由厂商判 |
| 改了 key 但请求仍用旧 key | 客户端 revision/缓存、本地 `.env` 直连 key | 旧投影不会自动失效 |
| 成本显示 0 | `pricing` 是否为空/占位 | 0 不等于免费 |
| 多把 key 无法对账 | `usage_events` 无 key_id | 只能到 provider/model/project 维度 |
| 某个 key 一直不用 | `is_active`、`status`、`cooled_until`、`seq` | 冷却中或排在后面 |
| 停用最后一把 key 报 409 | key 池 active 数量 | 先加新 key 再停旧 key |

## 10. 代码与契约索引

| 位置 | 内容 |
|---|---|
| `apps/hub/src/projection.ts` | `ProjectionService.projectFor()`：assignment → model → provider → key 的组装与过滤 |
| `apps/hub/src/routes/pub.ts` | `GET /pub/v1/models`、`GET /pub/v1/usage/summary`、`POST /pub/v1/usage` |
| `apps/hub/src/repositories/provider-keys.ts` | `usableKeys()`、key 池 active/冷却/顺序、legacy 回退 |
| `apps/hub/src/routes/admin/providers.ts` | provider 增删改、连接测试、revision bump |
| `apps/hub/src/routes/admin/models.ts` | 模型导入/手填/overlay/启停 |
| `apps/hub/src/routes/admin/assignments.ts` | 项目 assignment 整批替换 |
| `apps/hub/src/routes/admin/costs.ts` | 成本聚合与导出 |
| `apps/hub/src/model-schemas.ts` | 模型 overlay 只允许六个字段；凭证字段拒绝 |
| `docs/provider-key-rotation.md` | 同 provider 多 key 轮换/冷却的详细设计 |
| `docs/cost-governance.md` | 预算水位、成本治理与告警 |
| `docs/billing-model.md` | metering → billing 口径 |

## 11. 非目标

- 不做推理代理、流式中转、集中扣费。
- 不做跨 provider 的模型级 fallback；fallback 由 assignment 的
  `role=primary/fallback` + 日预算降级承担，key 轮换只在同 provider 内。
- 不实时查询厂商余额；套餐剩余额度对 hub 不可见。
- 不承诺“改 hub 配置就能立刻停掉所有旧 key”；厂商侧禁用和消费方刷新是必要步骤。
