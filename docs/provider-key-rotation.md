# 多 API Key 轮换（同厂商多套餐）技术设计

> 状态：设计稿，2026-11-01，待 owner 确认后落码。
> 场景：同一厂商（如字节 Ark）订阅两份套餐，除 API key 外配置完全相同；
> 一份套餐额度耗尽（配额类 429）时，希望在**同一次模型请求内自动换用另一把 key
> 重试**，业务无感；第二天套餐恢复后可重新启用。
>
> 已拍板（2026-11-01）：
> 1. 轮换执行层 = **model-kit 请求内自动轮换**（不是 hub 侧切换激活 key）。
> 2. 触发条件 = **仅识别"配额类 429"**（普通秒级/分钟级限流不换 key）。

## 1. 边界与非目标

- 只解决"同一 provider 多把等价 key"的凭证级故障转移；**不是**模型级 fallback
  （模型级 fallback 已由 `role=primary/fallback` + 日预算降级承担，二者正交）。
- hub 不经流、不做实时用量拉取（不接 Ark 余额 API）；套餐剩余额度对 hub 不可见，
  hub 只依据 model-kit 回报的"配额失败信号"标记 key。
- 不改 BYOK 语义；项目终端用户自己的 key 不参与轮换。
- 不做跨 provider 轮换（ark key 只在 ark 的多把 key 间换）。

## 2. 数据模型

复用现有 `providers` 行（一个 provider = 一个厂商接入点），把"单 key"扩为"有序 key 池"。
新增迁移 `014_provider_keys.sql`（sqlite + postgres 双方言）：

```sql
CREATE TABLE provider_keys (
  id              TEXT PRIMARY KEY,            -- pkey_xxx
  provider_id     TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  label           TEXT NOT NULL DEFAULT '',    -- 例如 "套餐A" / "套餐B"
  api_key_cipher  TEXT NOT NULL,               -- enc$v1$kid$iv$ct，复用 KeyRing
  api_key_hint    TEXT NOT NULL,               -- 掩码 ak-****ab12
  is_active       INTEGER NOT NULL DEFAULT 1,  -- 管理台可停用
  -- 轮换状态（由 model-kit 回报驱动；均为"软冷却"，不持久拉黑）
  status          TEXT NOT NULL DEFAULT 'ok',  -- ok | quota_exhausted
  cooled_until    TEXT,                        -- ISO；ok 时为 NULL
  last_error_code TEXT,                        -- 最近一次配额错误码（审计/展示）
  last_failed_at  TEXT,
  seq             INTEGER NOT NULL,            -- 使用顺序，越小越优先；用户可在管理台手动排序
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_provider_keys_provider ON provider_keys(provider_id, is_active, seq);
```

兼容策略（关键，避免大爆炸）：
- 迁移时把每个现存 `providers.api_key_cipher` 原样搬成一行 `provider_keys`
  （seq=0、status=ok），随后**保留** `providers.api_key_cipher/hint` 两列一个迁移周期
  （读路径：有 key 池读池，否则回落旧列），全部消费方升级后再出 015 迁移删旧列。
- 旧接口 `PATCH /api/admin/providers/:id {api_key}` 仍可用，但会**同步写入池**
  （更新 `seq` 最小的那行密文/hint，并清除旧的冷却状态；池为空时创建 seq=0 行），
  避免出现"改了 key 但投影仍用旧 key"的静默失效。
- 一个 provider 至少有一把 active key；删除"最后一把 active key"拒绝（409）。

## 3. 下发契约（/pub/v1/models）

`ProjectedModel` 现在的单个 `api_key: string` 扩为**有序凭证列表**，旧字段保留兜底：

```jsonc
{
  "model": "ark-code-latest",
  "protocol": "openai-compatible",
  "base_url": "https://ark.cn-beijing.volces.com/api/v3",
  "api_key": "<key[0] 明文，旧客户端兼容>",
  "api_keys": [
    { "key": "<套餐A 明文>", "keyId": "pkey_a1", "label": "套餐A" },
    { "key": "<套餐B 明文>", "keyId": "pkey_b2", "label": "套餐B" }
  ]
  // 其余字段不变
}
```

- 顺序 = `seq`，且只下发 `is_active=1 AND status!='quota_exhausted'（或冷却已过期）` 的 key。
- 只有一把 key 时 `api_keys` 长度为 1，行为与今天完全一致。
- 明文仍走既有 project-token HTTPS + 不落日志的规则；列表不改变密文边界。

## 4. model-kit 轮换逻辑

新增凭证轮换器（driver/audio/asr/media 等所有持 Bearer key 的出口共用）：

1. 按 `api_keys` 顺序取第一把；只有旧 `api_key` 时维持现状。
2. 请求失败时用 `classifyProviderError(status, body)` 判定（判定规则做成**可配置常量**
   `QUOTA_ERROR_PATTERNS`，便于拿到真实码后一处收紧）：
   - **配额类**（触发轮换）：HTTP 429 **且** body 的 code/message/type 命中配额特征。
     默认词表（小写子串，覆盖中英文）：
     `quota`、`exceed`、`insufficient`、`balance`、`arrears`、`out of credit`、
     `额度`、`配额`、`欠费`、`余额不足`、`用尽`。
     仅"请求过多 / rate limit / too many requests / rpm / tpm / 429 无 body"
     这类普通限流**不**命中（不换 key）。
   - 401（实测 Ark 返回 `401 AuthenticationError "The API key doesn't exist"`）、
     403、5xx、网络错误：**不轮换**，按现有错误路径抛出（key 无效与额度耗尽语义不同）。
   - 规则配在 model-kit 常量并导出，附正反两组单测；hub 侧不复制词表。
3. 命中配额类 → 用下一把 key **重放同一请求**（同样的 body/流式参数）；
   最多尝试 `api_keys.length` 把；每次轮换在返回里带 `keyFailover: true`
   与使用的 `keyId`，并在 usage/审计里记 `credential_failover` 归因。
4. 全部 key 都配额耗尽 → 抛明确的 `AllProviderKeysExhaustedError`（不再重试）。
5. 冷却状态由 hub 管（见 §5），model-kit 单次进程内不维护长期黑名单，避免"以为用 A
   实际一直用 B"的费用意外；每次拉配置都以 hub 下发为准。

流式（stream）注意：必须在**首字节返回前**判定错误才可安全重放；一旦开始产出
content chunk 才遇到 429（罕见，通常在响应头就返回 429），不重放、直接报错，
避免重复/串流。测试要覆盖"429 发生在 headers 阶段→换 key，发生在 body 阶段→不换"。

## 5. key 状态回报与冷却

model-kit 探测到配额类 429 后，除当场换 key 外，**异步、尽力**回报 hub：

- 新端点 `POST /pub/v1/key-events`（project token）：
  `{ providerId?, keyId, kind: 'quota_exhausted'|'recovered', code, at }`。
- hub 收到 `quota_exhausted`：把该 key 置 `status='quota_exhausted'`，按该 key
  所属 provider 配置的**冷却策略**计算 `cooled_until`、记 `last_error_code/last_failed_at`；
  写 admin 审计（不记 key 明文）。冷却策略见 §5.1，用户可在 provider 上配置。
- 冷却窗过后该 key 自动重新进入下发列表（`cooled_until < now` 视为可试）；
  管理台也可手动"标记恢复 / 停用 / **手动排序**"。
- 回报失败不影响主请求（best-effort，复用 usage 上报的失败静默模式）。

### 5.1 可配置冷却策略（用户自配）

每个 provider 一个 `key_cooldown_policy`（管理台可选，默认 `hours:5`），三档：

| 策略 | cooled_until 计算 | 适用 |
|---|---|---|
| 固定小时数 | `now + N 小时`（默认 **5 小时**，N 可填） | 通用、想快速重试 |
| 周重置 | 下一个套餐周重置时刻（按 provider 上可配的"重置星期几 + 时刻"，缺省下周一 00:00） | 按周计费套餐 |
| 月重置 | 下一个套餐月重置时刻（可配"每月几号 + 时刻"，缺省下月 1 日 00:00；月末日期做 clamp） | 按月计费套餐 |

- 只影响"何时重新允许尝试这把 key"，不做精确账单同步；用户随时可手动恢复立即生效。
- 配置存 provider 行（新列 `key_cooldown_policy TEXT`，JSON：`{kind:'hours'|'weekly'|'monthly', hours?, weekday?, dayOfMonth?, time?}`），
  迁移 014 一并加，默认 `{"kind":"hours","hours":5}`。
- key-events 回报时由 hub 据此算出绝对 `cooled_until` 下发，model-kit 不关心策略类型。

> 说明：key 状态是"软"的。冷却窗是为了避免每次请求都先打废 key；不是精确的套餐
> 重置时刻。用户在 UI 手动恢复或调整顺序都立即生效。

## 6. 管理台 UI（apps/hub/web）

在 provider 编辑抽屉的"API 密钥"区：
- key 列表：label、掩码、状态徽章（正常/额度耗尽+冷却到何时）、启用开关、删除
  （最后一把 active 禁删）。
- **手动排序**：拖拽或上移/下移按钮调整 `seq`，即 model-kit 的使用顺序；
  顺序保存后下次下发即生效（配"上移/下移/置顶"，拖拽作为增强，键盘可达）。
- 每把 key 一个 L1/L2 测试连接按钮（沿用现有 connection-test）。
- "添加备用密钥"（label + 明文，仅提交，回显掩码）；手动"标记恢复"。
- **冷却策略选择器**（provider 级）：固定 N 小时（默认 5）/ 周重置（选星期几+时刻）
  / 月重置（选几号+时刻），写入 `key_cooldown_policy`。
- 所有动作进 admin 审计；提交仍走 strict overlay 白名单。

## 7. 测试与验收

- 迁移：014 双方言配对、现存单 key 自动迁移成 1 行池、旧列兜底读取。
- 投影：多 key 顺序、只下发 active/未冷却 key、单 key 行为不变、明文不入日志。
- model-kit：
  - 配额 429（body 含 quota）→ 换 key 重放成功，`keyFailover=true`；
  - 普通限流 429（body 仅 rate limit）→ 不换、抛限流；
  - 401/5xx/网络错误 → 不换；
  - 两把都耗尽 → `AllProviderKeysExhaustedError`；
  - headers 阶段 429 重放、body 阶段 429 不重放；
  - 单 key（旧 `api_key`）零行为变化。
- key-events：置冷却、窗后恢复、手动恢复、最后一把 active 保护、审计无明文。
- 门禁：hub 与 model-kit 的 typecheck/lint/test/build 全绿；Python client 同步契约。

## 8. 发布顺序（model-kit git tag）

1. hub 迁移 + key 池 CRUD + 投影同时下发 `api_key`（旧）与 `api_keys`（新）。
2. model-kit 发 minor（向后兼容：无 `api_keys` 用旧字段），升 zeus/agent-world/
   job-agent（pnpm）与 atlas/loom（python）。
3. 确认消费方都能读 `api_keys` 后，再出 015 迁移删 `providers.api_key_cipher` 旧列。

## 9. 已确认的事实与后续收紧

- 2026-11-01 实测 Ark Plan：无效 key 返回 **401 `AuthenticationError` / "The API
  key doesn't exist"**（不轮换，符合 §4）；有效 key 200。受限时窗口已恢复，
  当次未抓到真实配额错误码，故 §4 先用保守词表（429 + 配额特征）落地并做成常量。
- 后续拿到真实"5 小时额度耗尽"的 429 响应体后，把 `QUOTA_ERROR_PATTERNS` 收窄到
  Ark 的精确 code（改常量 + 加测试即可，无需迁移）。
- 冷却策略默认 `5 小时`；周/月重置的"星期几/几号 + 时刻"默认下周一/下月 1 日 00:00。
