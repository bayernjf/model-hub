# model-hub 语音模型接入参考（火山方舟 Agent Plan）

> 来源：火山引擎《接入语音模型》官方文档。model-hub 的 HTTP 连接测试只覆盖 TTS
> HTTP 接口；ASR 与 TTS WebSocket 接口需额外探测能力（见文末）。

## 认证（TTS / ASR 通用）

- `X-Api-Key`: 专属 API Key（**新版控制台单头**；非 `Authorization: Bearer`，
  也非旧版 `X-Api-App-Id` + `X-Api-Access-Key` 双头）。
- `X-Api-Resource-Id`: 模型资源标识，决定模型版本与计费。
- `X-Api-Connect-Id` / `X-Api-Request-Id`: 每次请求的 UUID，便于排查。
- 排查：始终记录响应头 `X-Tt-Logid`。

## TTS 语音合成（doubao-seed-tts-2.0）

- 资源标识：`X-Api-Resource-Id: seed-tts-2.0`
- 三种接口：

| 接口 | 协议 | 地址 | 场景 |
|---|---|---|---|
| HTTP 接口 | HTTP POST | `https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional` | 一次性返回完整音频，简单/非实时 |
| 单流接口 | WebSocket | `wss://openspeech.bytedance.com/api/v3/plan/tts/unidirectional/stream` | 长文本播报 |
| 双流接口 | WebSocket | `wss://openspeech.bytedance.com/api/v3/plan/tts/bidirection` | 实时对话低延迟 |

- 请求体（HTTP）：

```json
{
  "req_params": {
    "text": "要合成的文本",
    "speaker": "zh_female_vv_uranus_bigtts",
    "audio_params": { "format": "mp3", "sample_rate": 24000 }
  }
}
```

- **音色必须 `uranus_bigtts` 系列**（seed-tts-2.0 专属）。`mars_bigtts` / `moon_bigtts`
  系列属 seed-tts-1.0，混用报 `55000000 resource ID is mismatched with speaker
  related resource`（且无提示）。示例音色：`zh_female_gaolengyujie_uranus_bigtts`、
  `zh_female_vv_uranus_bigtts`、`zh_female_sajiaoxuemei_uranus_bigtts`。
- 响应：HTTP chunked 流式 JSON，多块 `{"code":0,"data":"<base64>"}`，
  拼接 base64 解码即音频。`code` 非 0 或 `20000000`（结束标记）时按错误处理。

## ASR 语音识别（doubao-seed-asr-2.0）

- 资源标识：`X-Api-Resource-Id: volc.seedasr.sauc.duration`
- **仅 WebSocket**，两种接口：

| 接口 | 地址 | 场景 |
|---|---|---|
| 双流接口 | `wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async` | 实时转写、语音助手 |
| 单流接口 | `wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_nostream` | 准确率优先（全部发完或 15s 后统一返回） |

- 二进制协议（非 JSON）：自定义 header（version/type/flags/serialization/compression）
  + 大端 `seq`（4B）+ payload size（4B）+ gzip 压缩 payload。
- 音频要求：WAV PCM 16kHz 16bit 单声道（非 WAV 需 ffmpeg 转）。
- 请求 payload：`{user:{uid}, audio:{format,codec,rate,bits,channel}, request:{model_name:"bigmodel", enable_itn, enable_punc, ...}}`。

## 计费

- 套餐内 AFP 抵扣；开启超额后付费时额度用尽自动切换（无需改 Base URL/Key/模型）。

## model-hub 接入现状

- TTS HTTP 接口：可直接用 HTTP 探测（认证 `X-Api-Key` 单头 + 非标 body），
  但现有 `probe` 系列为 Bearer + OpenAI 兼容，接入需方言适配。
- TTS WebSocket / ASR：需要 WebSocket + 二进制协议探测能力（待办）。
- 实测记录：2026-10-29 TTS HTTP 打通（真实合成 24KB MP3，MPEG L3 64kbps/24kHz）。
  ASR 未测（WebSocket-only）。
