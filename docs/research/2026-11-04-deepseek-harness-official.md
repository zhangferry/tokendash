# DeepSeek Harness 官方资料调研

调研日期：2026-11-04。用途：为 TokenDash 增加独立 coding agent 数据源提供依据；本文件不实现功能。

## 来源与版本

- [DeepSeek 官方产品页](https://www.deepseek.com/harness/en/)直接指向 `deepseek-ai/deepseek-harness`，介绍 Desktop 与 `npx @deepseek-ai/dsh web` 两种入口。产品是插件化 agent harness，不等同于 DeepSeek 模型供应商。
- 本机桌面安装包中 `@deepseek-ai/dsh-session-persistence-jsonl`、`dsh-llm` 等包版本均为 **0.2.1-rc.5**；package.json 的 repository.directory 能定位官方源文件。
- 下文代码证据固定在官方发布标签 **`dsh-v0.2.1-rc.5`**，与本机安装版本对应。另查询到 2026-11-04 官方 master 为 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，仅作为当前 upstream 参照，不混作安装包版本。
- 高置信度：以下行为均由发布标签源代码与/或本机安装包 README 直接支持。私人会话内容、凭据不应写入提交材料。

## 存储位置与权威来源

Harness 数据根优先级为显式配置、非空 `DSH_HOME`、`~/.dsh`。使用 Node 的 `homedir()`/`path.join()`，不应把 macOS 的 Electron 浏览器数据目录当作跨平台日志根。[home-paths/src/index.ts:127](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/util/home-paths/src/index.ts#L127)

Desktop 复用 npm-installed dsh 的 Harness home，其 Electron 自有 profile/lock 路径位于 `<dshHome>/profiles/desktop`。[desktop/src/paths.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/apps/desktop/src/paths.ts)

JSONL 后端 `root` 是部署配置，没有插件级默认值。标准部署下本机实际日志在 `~/.dsh/sessions/<project>/<session>/session.v4.jsonl.zstd`。也允许 `compression: none` 的 `.jsonl`。同一 session 可能保留多个不可变格式世代，必须选择最高规范 generation，不能把 v0–v4 文件一起累加。目录中的 readable cwd 可能发生规范化碰撞，项目路径应读取 header.cwd。[JSONL persistence README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/session/session-persistence-jsonl/README.md)

`session-query-sqlite` 只是可选、可重建的 FTS 搜索索引，另有单进程所有权和 schema 重建规则，不能依赖它作为 token 权威数据库。[query-sqlite README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/session/session-query-sqlite/README.md)

## 压缩与兼容性关键点

默认文件由多个独立、带 checksum 的 Zstandard frame 拼接组成：第一个 frame 是 header，之后每批 durable append 一个 frame。它不是单帧压缩的完整 JSONL。[zstd.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/session/session-persistence-jsonl/src/zstd.ts)

官方先扫描 frame 的 header/block 长度，确定完整 frame 范围，再逐帧解压。公开 API fallback 逐个调用 `zstdDecompressSync(source.subarray(start, end))`；不能直接对整份文件调用一次解压就假定读全。[zstd-public-decoder.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/session/session-persistence-jsonl/src/zstd-public-decoder.ts)

尾部截断与完整帧损坏不同：不完整末帧可恢复已完整解码的 JSONL 行；完整 frame checksum/结构错误属于 corruption。TokenDash 读取器应只读，绝不能调用官方可能修复、迁移、截断源文件的 write-open 路径。[JSONL persistence README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/session/session-persistence-jsonl/README.md)

发布版本 writer 为 V4。官方自带 V0→V1→V2→V3→V4 的迁移链；早期版本有 packed delta、事件引用和 cardinality 变换。建议首期明确承诺 V4；旧版本须单独验证，不能只改文件名就当兼容。[Session types](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/core/session/src/types.ts)、[format catalog](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/session/session-format-catalog/README.md)

## Token 口径与去重

| 源字段/事件 | 对 TokenDash 的含义 |
| --- | --- |
| `data.usage.inputTokens` | 未缓存输入 token，已排除 cache read/write |
| `outputTokens` | 输出 token，已经包含 reasoning；不可再次加 reasoningTokens |
| `cacheReadTokens` / `cacheWriteTokens` | 独立输入桶，缺失时官方累计投影取 0 |
| `assistant/message` | 优先取 `data.usage`，否则取 stream 最后一个 usage chunk |
| `assistant/attempt` | 没有顶层 usage；可从 stream 最后一个 usage chunk 取得失败/取消/重试请求的已上报用量 |
| `llm/retry-started` | 结束当前同 turn/step 的 sample replacement 范围；下一尝试另计 |

桶定义见 [llm/src/types.ts:166](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/llm/llm/src/types.ts#L166)，reasoning 关系见 [token-meter/projection.ts:7](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/llm/token-meter/src/projection.ts#L7)。事件形状见 [Session types:332](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/core/session/src/types.ts#L332)。

官方 `tokenUsage` 投影对相同 turn/step 的后续样本做替换，保留最后 usage，遇到 `llm/retry-started` 清除 replacement slot。数据提取应复现该口径，再生成按日/模型聚合记录，避免同时累加 message.usage 与 stream usage，也避免漏掉失败但已计费的尝试。[usage-projection.ts:81](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/llm/token-meter/src/usage-projection.ts#L81)

message 的 provider/model 来自 `data.message.source.{provider,model}`；attempt 的路由需沿用先前有效 request/header，不能假造身份。缺失 usage 时不要默认为准确的 0 或凭字符数补齐；应区分已观测值与未知样本。

普通 fork 会拷贝历史事件。V4 header 使用 isSeeded，真正继承 cut 来自**最后一个带 `inherited: true` 的 `session/end-seed`**；无标签 marker 不表示当前 session cut。跨 session 累计应排除继承前缀，仅统计新增请求；subagent 自己产生的调用仍应计入。`parentSession` 单独不足以判断 subagent，官方使用 `origin: 'subagent'`。[Session types header](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/core/session/src/types.ts#L87)、[end-seed 规则](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/core/session/src/types.ts#L407)

## 模型与费用

发布版官方目录把模型 id `deepseek-flash` 显示为 `DeepSeek-V4.1-Flash`，另一个 id 为 `deepseek-v4-pro`。可据此为 Harness 官方 provider 建立有限的 pricing alias；不要全局把第三方同名模型改成此价格。[llm-deepseek/src/models.ts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/llm/llm-deepseek/src/models.ts)

TokenUsage 没有费用字段。TokenDash 现有模型表采用项目既定估算策略；Harness 接入应继续区分“日志里的真实 token”与“按模型表计算的估算费用”，不能声称等于 DeepSeek 账号账单。登录/订阅 quota 是另一功能，不应从 token 日志虚构剩余额度。

## 已知覆盖边界

标题生成是 auxiliary model call。官方 executor 记录 `session/title-llm-request` 的输入和路由，消费 stream 后只返回 blocks/finish/model，未把 usage 结算事件写回 session。因此仅凭主会话 JSONL 不能保证涵盖标题请求或其他插件绕过 agent-loop 的调用，更不能声称统计全部账号消耗。[session-title-llm/src/index.ts:267](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/session/session-title-llm/src/index.ts#L267)

首期需通过独立实验解决的工程问题：Node 20 的 Zstandard 支持路径；默认无外部 zstd 程序的 Windows/macOS 安装兼容；截断尾帧策略；V4 新增未知事件的保守处理；跨日志增量缓存与 format generation 切换；自定义 persistence root 的发现方式。这些属于 TokenDash 的开发决策，不是已验证的 Harness 支持承诺。
