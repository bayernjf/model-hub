# 账单口径（metering → billing）

> 代码：`apps/hub/src/billing.ts`（纯函数）、`apps/hub/src/routes/admin/billing.ts`（`GET /api/admin/billing`）。
> 这段口径不改现有成本看板的行为，只给它一个"月"的形状。

## 1. 三条硬规则

**规则一：`byok` 只计量，不计费。**
`billing_source=byok` 是客户自带的 key，钱不经过我们。`buildStatement` 把它全部计入
`metered_only`，且 `amount_micros` 恒为 0——即使 `usage_events` 里那一行记了真实成本，
也不进账单。这与 `routes/admin/costs.ts` 的 `withCost = billing_source !== 'byok'` 一致：
账单和看板口径不一致，比没有账单更糟。

**规则二：`cost_micros` 直接求和，不在报表时重算。**
`cost.ts` 的 `computeCostMicros` 在**写入时**算好并落库。报告期重算会与账本漂移，
而账本才是对账依据。价格为空的行走 `Number(x) || 0`，不允许变成 `NaN` 污染整张账单。

**规则三：账期是 UTC 自然月。**
`usage_events.ts` 存的是 `…Z` 的 ISO-8601，按 UTC 归月，不做本地时区换算。
`periodBounds('2026-11')` → `2026-11-01T00:00:00.000Z` ~ `2026-11-30T23:59:59.999Z`（闭区间）。

## 2. 缓存 token 怎么处理

`cache_read_tokens` **计入用量**，其成本已由 `computeCostMicros` 按 `cache_read_usd_per_million`
算进 `cost_micros`，聚合时**不额外加价**。若某模型没有 cache 单价，该字段对成本贡献为 0，
但 token 数仍然记账——用量和成本是两列，不能互相替代。

## 3. `billing_type` 现在不参与账单

表里有 `billing_type (payg | subscription snapshot)`，本版账单**只按用量算**，
不区分订阅。原因：订阅合同价不体现在 `cost_micros` 里，混进账期会让金额对不上。
订阅折扣属于 T-B1-04（账单落库）要一起定的事。

## 4. 接口

```bash
GET /api/admin/billing?period=2026-11     # 缺省 = 当前 UTC 月
```

响应要点：

| 字段 | 含义 |
|---|---|
| `period` / `period_start` / `period_end` | 账期与其闭区间 |
| `billable` | `builtin` 用量与金额（**唯一带价格的桶**） |
| `metered_only` | `byok` 用量；`amount_micros` 恒 0 |
| `by_project[]` | 每项目：`billable_micros`、`metered_tokens`、`calls` |
| `by_model[]` | 每（项目, 模型）：`billable_micros`、`calls` |
| `excluded_rows` | 仓库返回但落在其它月份、被排除的行数 |
| `note` | 用一句话说明 byok 规则，读 JSON 的人不必翻文档 |

`excluded_rows` 是有意暴露的：仓库窗口与本函数若对不齐，钱会在月份之间悄悄移动。
把它显示出来，对不上时能被看见，而不是被算进某个月。

## 5. 为什么先做查询不做落库

账单一旦落库就是**不可重建状态**（要独立备份、独立恢复演练）。按开仓标准，那一步要先定
订阅与按量如何并存、如何处理跨期调整。在定之前，账单是"随时可重算的视图"——
它可被复核，这对账单是更重要的性质。

## 6. 已验证的边界

| 场景 | 期望 |
|---|---|
| builtin 300 + builtin 200 + byok 4000 | `billable=500`，`metered=0`，byok 的 tokens 仍记 |
| 跨月行混入 | 被排除且 `excluded_rows=1`，不静默计入 |
| `cost_micros` 为空 | 计 0，不产生 NaN |
| `period=2026-13` | `400 validation_error`，`field=period` |
| 未登录 | `401` |
| 无 period | 取当前 UTC 月，并在响应里回显 |

测试：`apps/hub/test/billing.test.ts`（13 例）。
