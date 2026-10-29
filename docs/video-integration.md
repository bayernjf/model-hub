# model-hub 视频模型接入参考（Agnes Video 2.5 Flash）

> 来源：Agnes Video 2.5 Flash 官方文档。OpenAI Videos 兼容 API，异步任务接口。

## 认证

- `Authorization: Bearer <sk-key>`（OpenAI 兼容，非 Ark 的 X-Api-Key）。

## 接口

- 创建任务：`POST https://apihub.agnes-ai.com/v1/videos`
- 查询任务（推荐）：`GET /agnesapi?video_id=<id>&model_name=agnes-video-2.5-flash`
  - 纯 `video_id` 查询仅适用于 `mode: text` 任务。

## 异步任务流程

1. `POST /videos` 创建任务，响应含 `video_id` / `id` / `task_id`。
2. 每隔 1–2s 轮询查询，直到 `status` 为 `completed` 或 `failed`。
3. `completed` 时顶层 `url` 字段即视频地址（`internal_status`/`internal_progress` 忽略，
   以 `status`/`progress` 为准）。

## 请求参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `model` | 是 | `agnes-video-2.5-flash` |
| `prompt` | 是 | 视频描述 |
| `mode` | 是 | `text` / `keyframe` / `reference` |
| `seconds` | 否 | 字符串 `"4"`–`"12"`，默认 `"5"` |
| `size` | 否 | Flash 固定 `"720P"` |
| `aspect_ratio` | 否 | 默认 `16:9` |
| `seed` / `n` | 否 | `n` 仅支持 `1` |

模式专用：`keyframe` 用 `first_frame`/`last_frame`；`reference` 用 `images`(≤5)/`audios`(≤3)。

## Flash 专属校验（失败返回 400，不创建任务不产生费用）

- `size` 必须 `"720P"`。
- `reference` 的 `images` 最多 5 张、`audios` 最多 3 段。
- `videos` 不支持。

## 计费

- `$0.025/秒`（输出分辨率 720P），当前限时 `$0/秒`。

## model-hub 接入现状

- 已登记 Agnes provider（payg）+ `agnes-video-2.5-flash`（带 adapter：`submit_path`、
  `retrieval_url_template`、`create_body:{size:"720P",mode:"text"}`、`seconds_field` 等）。
- `probeVideoSubmit` 已按 adapter 构造提交 body（不再硬编码 `duration`）。
- 实测：body 已被 Agnes 接受（错误从字段拒绝变为 `video_queue_full` 队列满）。
  真实生成待 Agnes 队列空闲后重试（提交一次即止、不轮询，loom 花钱不重试纪律）。
