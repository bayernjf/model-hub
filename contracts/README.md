# model-hub 下发契约

语言中立的契约，是 TS model-kit 与 Python 薄 client 的共同依据。
OpenAPI 3.1 与 JSON Schema 2020-12 兼容，双端共享同一份 fixture。

## 结构

```text
contracts/
├── openapi.yaml                    # OpenAPI 3.1：/pub/v1 三个端点
├── schemas/
│   ├── common.json                 # 枚举、pricing、endpoints、adapter、error
│   ├── models-response.json        # GET /pub/v1/models 响应
│   ├── usage-request.json          # POST /pub/v1/usage 请求
│   └── health-check-request.json   # POST /pub/v1/health-checks 请求
└── fixtures/                       # 双端共用示例（TS/Python 测试都读这里）
```

## 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/pub/v1/models` | 拉取项目投影目录；revision/ETag/304 |
| POST | `/pub/v1/usage` | append-only 用量事件（原始单位，无正文） |
| POST | `/pub/v1/health-checks` | 上报 L3/L4 连接测试结果 |

## 约定

- 所有请求用 project token（Bearer）鉴权；token 与项目一一绑定。
- 金额单位：预算用整数微美元（`*_micros`）；定价用每百万 token / 张 / 秒
  等美元数值，未知维度为 `null`，不强行计价。
- 时间统一 RFC 3339 / ISO-8601（`date-time`）。
- 错误结构统一为 `{ error: { code, detail?, hint? } }`，错误码见
  `schemas/common.json`。

## 校验

TS 侧契约测试（`apps/hub/test/contracts.test.ts`）用 Ajv 加载全部 schema
并校验 `fixtures/`；Python client 侧（W4-3）复用同一批 fixture。
修改 schema 后必须同步更新受影响 fixture 与双端类型。
