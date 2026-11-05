# DeepSeek Harness 本机数据调研

日期：2026-11-04。范围：只读检查安装元数据、随安装包发布的代码、会话结构与累计用量；未读取凭据文件，未运行模型请求，未更改 Harness 数据。本文不保存原始对话、工具参数或项目路径。

## 结论

可以直接接入本机会话日志，不需要登录接口、代理请求或修改 Harness。建议新增 agent ID `deepseek`，显示名 `DeepSeek Harness`。

本机已验证 **V4、多帧 Zstandard 压缩日志的 provider-reported usage** 可完整读取；不能把它当作普通 JSONL，也不能对整个压缩文件只调用一次 `zstdDecompressSync`。

官方版本化资料与其他平台的结论见 [官方调研](2026-11-04-deepseek-harness-official.md)；开发方案见 [接入计划](../superpowers/plans/2026-11-04-deepseek-harness.md)。

## 本机证据

| 项目 | 实际观察 | 证据位置 / 方法 |
| --- | --- | --- |
| 应用版本 | `0.2.1-rc.5`，bundle ID `com.deepseek.dsh` | `/Applications/DeepSeek Harness.app/Contents/Info.plist`，用 `plistlib` 读取 |
| 内置运行时 | Node `24.21.0` | `Contents/Resources/runtime/versions.json` |
| 会话根目录 | `~/.dsh/sessions/` | 文件系统扫描；与内置 `dsh-home-paths` 一致 |
| 会话布局 | `<project-slug>/<session-id>/session.v4.jsonl.zstd` | 实际存在两份会话文件 |
| 本地 projection | `~/.dsh/storages/session_projcache/sessions/*.json` | 只用于对照，不作为接入数据源 |
| 日志头 | `type: session, version: 4, id, createdAt, cwd, isSeeded, delegationDepth, agentPreset` | 解压后的第一行 |
| 普通事件 | `type, seq, time, data`，部分有 `surfaceOp` / `sourceEventSeqs` | 解压后的事件键名；`time` 是毫秒时间戳 |
| 实际模型 | provider `deepseek-account`、model `deepseek-flash` | `assistant/message.data.message.source` 与 `request/header.data.header.config` |
| 模型名称对应 | 默认模型目录将 `deepseek-flash` 标注为 `DeepSeek-V4.1-Flash` | 安装包内 `@deepseek-ai/dsh-llm-deepseek/lib/index.js` 的 `DEFAULT_MODELS` |

Electron 的 `~/Library/Application Support/@deepseek-ai/dsh-desktop/` 主要是桌面壳的数据，不应扫描其 Cookies、Local Storage 或 Chromium 缓存来统计 token。

### 字段映射

仅保留结构的示例：

```json
{
  "type": "assistant/message",
  "seq": 42,
  "time": 1793756600000,
  "data": {
    "turn": 1,
    "step": 1,
    "message": {
      "role": "assistant",
      "id": "redacted-message-id",
      "source": { "kind": "model", "provider": "deepseek-account", "model": "deepseek-flash" },
      "content": []
    },
    "usage": {
      "inputTokens": 489,
      "outputTokens": 262,
      "cacheReadTokens": 12032,
      "cacheWriteTokens": 0,
      "totalTokens": 12783
    },
    "stream": []
  }
}
```

样例中的序号、时间、ID 和内容已替换或省略；usage 取自一条实际记录。不要推断 `provider` / `model` 位于 `data` 的顶层。

| Harness | TokenDash | 规则 |
| --- | --- | --- |
| `data.usage.inputTokens` | `inputTokens` | 未缓存输入，不再次减去缓存读取 |
| `outputTokens` | `outputTokens` | 不额外累加 `reasoningTokens` |
| `cacheReadTokens` | `cacheReadTokens` | 独立用量桶 |
| `cacheWriteTokens` | `cacheCreationTokens` / block 的 `cacheCreationInputTokens` | 按现有 API 命名转换 |
| 四个桶之和 | `totalTokens` | 已记录的 `totalTokens` 用来校验；不再加缓存或 reasoning |
| `time` | token 事件时间 | 不能用文件 mtime 或会话创建时间代替 |
| session header 的 `cwd` | 项目 | 复用项目名称规范化工具，不反解目录 slug |

这不是完整的 usage reducer 规范：官方还定义了 `assistant/attempt`、同一步 usage 替换、`llm/retry-started` 和继承前缀。必须按[官方调研](2026-11-04-deepseek-harness-official.md)实现，不能仅循环求和 `assistant/message`。

## 解压与用量对照实验

实验环境：系统 Node `v24.13.0`；本机已有 `/opt/homebrew/bin/zstd`。无需新增项目依赖。

| 观察 | 活跃会话 | 仅初始化会话 |
| --- | ---: | ---: |
| 压缩字节 | 1,026,550 | 348 |
| 完整压缩帧 | 745 | 2 |
| 完整解压字节 | 3,127,539 | 503 |
| `assistant/message` 数 | 176 | 0 |
| `assistant/attempt` 数 | 0 | 0 |
| 未缓存输入 token | 172,909 | 0 |
| 输出 token | 112,394 | 0 |
| 缓存读取 token | 24,112,512 | 0 |
| 缓存写入 token | 0 | 0 |
| 合计 | **24,397,815** | **0** |

验证路径：

1. `zstd -dc <session-file>` 解压全部帧，逐行解析；只累计结算事件上的 usage。
2. 对照 Harness projection cache 的 `record.rows.tokenUsage.val.totals`，四个桶完全一致。
3. 使用安装包的 `scanZstdFrames` 逻辑定位帧边界，再逐帧调用 Node 公共 API `zstdDecompressSync`；输出字节数和四个桶与路径 1 完全一致。

反例：直接对整个活跃文件调用一次 `zstdDecompressSync`，本机只返回 **225 字节的会话头**。会得到“没有 token”的错误结果，却不一定抛异常。

同一活跃会话能搜索到 352 处 usage：176 份 `data.usage` 与内嵌 stream 中的同值副本。递归搜集所有 usage 会翻倍计数。

## 证据边界

- 两份本地样本均为 V4、`isSeeded: false`，没有实际失败重试或子会话样本；这些场景需根据同版本官方源码制作合成 fixture，不能声称本机已验证。
- 原始 usage、模型名和流式记录可用；不会用文本长度或上下文压力估算来补充未上报 usage。
- 日志没有实际账户扣费字段。本项目已有 Go / AMAX 的跨供应商参考价格规则，见 `src/shared/modelPricing.ts:25`；接入时应保持这一规则，费用标注为估算。
- 官方标题生成器等辅助请求不一定将已消耗的 usage 持久化到会话结算事件。此方案统计的是“日志已记录用量”，不能宣称与账户账单完全相等。
- 默认模型别名有同版本内置目录为证；第三方 provider 可覆盖目录，不能把所有 provider 的 `deepseek-flash` 全局强制归一化为同一型号。
- 尚未运行 macOS、Windows、Linux 上的 TokenDash 接入验证；本轮只调研和规划，没有修改产品代码。
