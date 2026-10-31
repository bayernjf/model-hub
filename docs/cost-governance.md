# 成本治理（Cost Governance，PRD F6 / M5）

预算从"只存不执行"到"告警 + 强制 + 降级"。本文是消费方（zeus / loom /
atlas 等）与运维的对接契约。语义缓存按裁定 D-3 暂缓，不在本层。

## 职责边界

hub 是控制面、不经推理流量，因此：

- **hub** 只负责：预算读数（`GET /pub/v1/usage/summary`）、水位告警
  webhook、成本看板"预算水位"列、`degraded` 归因字段的存储。
- **model-kit（项目侧）** 负责：调用前的预算检查、降级路由（fallback）、
  熔断（显式报错）、kill switch。

## W5-1 · 预算读数

### Hub 端点：`GET /pub/v1/usage/summary`

Project token（Bearer）鉴权。聚合**当日（UTC）**usage_events 的
builtin `cost_micros`，按 assignment 对照 `daily_budget_micros`：

```json
{
  "project": "zeus",
  "day": "2026-10-31",
  "generated_at": "2026-10-31T12:00:00.000Z",
  "models": [
    {
      "assignment_id": "asn_...",
      "alias": "noul",
      "role": "primary",
      "model": "doubao-seed-1-6-250615",
      "spent_micros": 420000,
      "daily_budget_micros": 1000000,
      "percent": 42
    }
  ],
  "unassigned_spent_micros": 0
}
```

- BYOK 流量不计入（`cost_micros` 为 NULL，owner 不为用户 key 付费）。
- `percent = spent/limit*100`（两位小数）；无预算或零预算时为 `null`。
- 日切由 SQLite `date(ts) = date('now')` 完成，两侧都是 UTC，不随宿主
  时区漂移。
- `unassigned_spent_micros` 是当日无法归属到现存 assignment 的 builtin
  花费（未带 assignment 或 assignment 已被替换），用于与成本看板对账。

### model-kit：`kit.getDailyBudgetState(alias)`

```ts
const state = kit.getDailyBudgetState('noul');
// { alias, assignmentId, spentMicros, dailyBudgetMicros, percentUsed, exceeded }
// null：alias 没有 hub 分配（BYOK/env）或治理层被关闭
```

**即时性（重要）**：快照与目录共享同一条刷新节奏——`init()` 拉一次 +
定时器周期刷新（`refreshIntervalMs`，默认 **5 分钟**）。读数最多落后
hub 账本一个刷新周期，外加 usage 上报延迟；本进程在上次刷新之后的调用
不会实时反映在快照里。预算强制（见下）使用同一快照，因此不是硬实时
限额，而是"分钟级延迟的软限额"；超限场景的兜底是告警与审计，不是
分毫不差的扣费。

快照拉取失败时保留上一份（fail-soft）：hub 宕机不阻塞任何调用，也不
会把未知用量误判为超限。

## W5-2 · 降级路由 + 熔断

每次别名调用（`chat` / `stream` / `embed` / `image` / `video` / `tts` /
`asr`）前做预算检查：

1. 解析顺序不变（BYOK → hub → env）。只有 **hub 分配且配置了
   `dailyBudgetMicros`** 的模型受治理；BYOK（用户自费）与 env 迁移凭证
   永不检查。
2. 未超 `dailyBudgetMicros`：行为与之前完全一致。
3. 超预算：
   - 存在**同模态、`role=fallback`、自身预算未超**的分配 → 自动切换到
     该 fallback。调用结果附 `degraded` 溯源，usage 上报带
     `degraded: true` 且 `assignment_id` 记为实际执行的 fallback，
     `feature` 仍是请求的别名——hub 账本可归因（FR6-2）：

     ```ts
     const result = await kit.chat('noul', messages);
     result.degraded; // { reason: 'budget_exceeded', requestedAlias: 'noul' } | undefined
     // stream：最后一个 done chunk 携带同样的 degraded 字段
     ```
   - 没有可用 fallback → 抛 `BudgetExceededError`（`code: 'BUDGET_EXCEEDED'`，
     携带 alias / spentMicros / dailyBudgetMicros）。**显式失败，绝不
     静默放行**，也不会隐式改道到未受治理的模型。

### Kill switch

两层开关，任一生效即整层关闭（不拉 summary、不检查、不降级、
`getDailyBudgetState` 返回 `null`）：

- 代码选项：`initModelKit({ budgetEnforcement: 'off', ... })`
- 环境变量：`MODEL_KIT_BUDGET_ENFORCEMENT=off`

默认（选项缺省且 env 非 `'off'`）治理开启；未配预算的 assignment 行为
不变。

### 审计字段

- 调用结果 / stream 末帧：`degraded: { reason, requestedAlias }`。
- usage 上报：`degraded: true` + 实际执行 assignment 的 `assignment_id`
  与 `model`；hub `usage_events.degraded` 列持久化。
- 熔断（无 fallback 被拒）不产生 usage 事件——调用未发生；错误对象本身
  即审计凭据。

## W5-3 · 水位告警（hub 侧）

某 assignment 当日 builtin 用量达到其日预算 **80% / 100%** 时，hub 向
`HUB_BUDGET_WEBHOOK_URL` POST 一条 JSON（每 assignment 每 UTC 日每档至多
一次，`budget_alerts` 表唯一索引保证幂等，兼作告警审计）：

```text
POST <HUB_BUDGET_WEBHOOK_URL>
x-hub-event: budget.threshold
x-hub-delivery-id: bal_xxx
x-hub-signature: sha256=<HMAC-SHA256(secret, raw body) 的 hex>

{
  "type": "budget.threshold",
  "level": 80,                  // 80 | 100
  "project": "zeus",
  "assignment_id": "asn_...",
  "alias": "noul",
  "model": "doubao-seed-1-6-250615",
  "day": "2026-10-31",
  "spent_micros": 840000,
  "budget_micros": 1000000,
  "percent": 84,
  "at": "2026-10-31T12:00:00.000Z"
}
```

- 形态对齐 ops-console notify 的 HMAC webhook 模式：签名覆盖**原始字节**，
  接收端用 `HUB_BUDGET_WEBHOOK_SECRET` 常量时间校验。
- `HUB_BUDGET_WEBHOOK_URL` 未设 → 整层跳过（即告警的 kill switch）；
  secret 未设则发未签名 webhook（不推荐）。
- 投递是 fire-and-forget 单次尝试，失败不重试、不影响触发它的 usage
  上报（告警是 advisory；状态以 `budget_alerts` 表为准）。
- 一次用量跨越两档（如从 0 直接到 120%）会按 80 → 100 顺序各发一条。

### 成本看板

`GET /api/admin/costs` 响应新增 `budgets` 数组（只含配置了日预算的
assignment），控制台成本页新增"预算水位（UTC 当日）"表：项目 / 别名 /
角色 / 模型 / 已用 / 日预算 / 水位（spent/limit%，>=80% 黄、>=100% 红）。
水位恒为"当下"读数，不受请求的时间窗口过滤影响。

## 兼容性

- 未配 `daily_budget_micros` 的 assignment：无检查、无告警、无降级，
  行为与治理上线前一致。
- 旧版 kit（无 degraded 字段上报）：照常入库，`degraded` 默认 0。
- `budgets` / `degraded` / `usage/summary` 均为新增字段与端点，无破坏性
  变更；消费方升级 model-kit 后才能获得强制/降级能力（升级待办由 owner
  在下次 tag 发布时执行，见 RELEASING.md）。
