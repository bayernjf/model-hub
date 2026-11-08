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
| `by_model[]` | 每（项目, 模型）：`billable_micros`、`calls`、`metered_calls` |
| `excluded_rows` | 仓库返回但落在其它月份、被排除的行数 |
| `unattributed_rows` | 窗口内**项目未登记**的用量行数；不进任何合计，单独报出来 |
| `note` | 用一句话说明 byok 规则，读 JSON 的人不必翻文档 |

`excluded_rows` 是有意暴露的：仓库窗口与本函数若对不齐，钱会在月份之间悄悄移动。
把它显示出来，对不上时能被看见，而不是被算进某个月。

`unattributed_rows` 是同类问题的另一半：聚合 SQL 是
`FROM usage_events u JOIN projects p ON p.id = u.project_id`，`usage_events.project_id`
存的是 **projects 表的 id**（不是 slug）。项目没登记、被删掉、或客户端自己塞了一个标签出来，
这些用量行在 JOIN 里直接消失 —— 不报错、不进任何桶、`excluded_rows` 也不会计数。
账单会因此少报真实发生过的用量。所以窗口内的未命中行单独 `COUNT(*)` 一次带出来。

## 5. 页面（`/billing`）

`apps/hub/web/src/pages/billing.astro` + `islands/Billing.tsx`，与同目录的 `costs.astro`
共用 `ConsoleLayout`、`AsyncState` 与表格样式（`apps/hub/web` 本来就有前端，这里只是加一页）。

三处刻意的显示规则：

1. **空月不显示 0**：`billable.calls` 与 `metered_only.calls` 都为 0 时只显示
   「这个月没有用量记录 —— 不是金额为零，是没有账可出」，不出金额表格。
2. **极小金额不显示 0**：`usd()` 在 4 位小数下会把 `<$0.0001` 舍成 `$0.0000`，
   于是非零金额改为显示 `< $0.0001`。一个存在的费用不能被渲染成免费。
3. **`excluded_rows > 0` 时显示警示**：跨月行被排除这件事必须被看见，否则钱会在
   月份之间悄悄移动而没人察觉。
4. **`by_model` 里的 byok 模型不显示 `$0.0000`**：真机跑数据时发现，一个真实被调用过的
   byok 模型在「按模型」表里只剩一行 `$0.0000`，读起来就是免费。金额为 0 且有过 byok 调用时
   改显示「仅计量（N 次）」；为此 `by_model` 增加了 `metered_calls` 字段——页面之所以能区分，
   是因为响应里先有了这个区分。
5. **未归属用量绝不能被显示成「这个月没有用量」**：只要 `unattributed_rows > 0`，空月文案就
   不成立，页面出警示条；若本月除它之外没有任何可归属用量，正文改说「有 N 行用量，但没有一行
   能归属到已登记的项目」，并把人指去登记项目，而不是让人以为账已经结清。

## 6. 为什么先做查询不做落库

账单一旦落库就是**不可重建状态**（要独立备份、独立恢复演练）。按开仓标准，那一步要先定
订阅与按量如何并存、如何处理跨期调整。在定之前，账单是"随时可重算的视图"——
它可被复核，这对账单是更重要的性质。

## 7. 已验证的边界

| 场景 | 期望 |
|---|---|
| builtin 300 + builtin 200 + byok 4000 | `billable=500`，`metered=0`，byok 的 tokens 仍记 |
| 跨月行混入 | 被排除且 `excluded_rows=1`，不静默计入 |
| `cost_micros` 为空 | 计 0，不产生 NaN |
| `period=2026-13` | `400 validation_error`，`field=period` |
| 未登录 | `401` |
| 无 period | 取当前 UTC 月，并在响应里回显 |

测试：`apps/hub/test/billing.test.ts`（13 例）。
