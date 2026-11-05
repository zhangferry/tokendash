# DeepSeek Harness 接入开发计划

日期：2026-11-04。状态：里程碑 A / B 已于 2026-11-05 实现并验证；见[交付与验证记录](../../research/2026-11-05-deepseek-harness-validation.md)。下文保留原始实施方案。

依据：[本机调研](../../research/2026-11-04-deepseek-harness-local.md)、[同版本官方资料](../../research/2026-11-04-deepseek-harness-official.md)。仓库基线 `6d140b3`，TokenDash `1.10.0`。

## 目标与边界

将 DeepSeek Harness 作为第六个独立 coding agent 接入，ID `deepseek`，显示名 `DeepSeek Harness`。首个里程碑完成准确的 token 统计、项目/模型过滤、时间趋势、All Agents 和托盘汇总。第二个里程碑完成会话详情与工具分析。

首版支持本机已验证的 **V4 JSONL / 多帧 JSONL.zstd**；支持默认 `~/.dsh/sessions` 与 `DSH_HOME` 下的 sessions。历史 V0–V3 和未来版本明确诊断，不静默解释为 V4。第一版不调用 Harness 进程、不修改或迁移它的文件、不读取凭据、不接入账户额度或实际扣费。

继续使用现有 Node `>=20.10.0` 要求，不新增 npm 依赖。环境路径覆盖先支持 `DSH_HOME`，任意 profile 自定义 persistence root、图形化路径设置及远程会话后续再扩展。

## 已核实的接入约束

| 事实 / 决策 | 依据 |
| --- | --- |
| 独立 parser 输出 daily/projects/blocks 是当前最小边界 | `src/server/piParser.ts:36`、`:452`；`src/shared/types.ts:1` |
| 可复用文件索引，保存规范化 token 记录，不缓存原始对话 | `src/server/usageFileIndex.ts:88` |
| `/agents` 的 available 列表仍需手动接入；客户端 All Agents 已动态取来源 | `src/server/routes/api.ts:101`；`src/client/api/client.ts:54` |
| 统计 API 未匹配到 agent 时会回落 Claude，必须显式分发 | `src/server/routes/daily.ts:44`、`projects.ts:44`、`blocks.ts:58`、`analytics.ts:54`、`monthly.ts:24`、`session.ts:24` |
| Dashboard 的 agent 联合类型和配置表是硬编码的 | `src/client/components/Dashboard.tsx:187`、`:517` |
| Swift、Tauri、Popover 已根据 `/agents` 动态汇总 | `TokenDashSwift/Sources/TokenDash/BadgeUpdater.swift:283`；`src-tauri/src/usage.rs:46`；`src/popover/usePopoverData.ts:156` |
| 现有模型价格是 Go / AMAX 参考价格，不能表述为 Harness 账单 | `src/shared/modelPricing.ts:25`、`:46`、`:102` |
| 会话详情有独立索引、revision、transcript 和能力字段 | `src/server/sessionAnalyticsParser.ts:362`、`:954`；`src/server/sessionTranscripts.ts:24`；`src/shared/types.ts:155` |

## 核心实现规则

### 1. 发现、版本选择与解压

- 新增 `src/server/deepseekParser.ts`，扫描 `DSH_HOME`（非空时，按 Harness 规则展开 `~` / 相对路径），否则使用 `homedir()/.dsh`。以可读会话数据判断可用，不依赖应用安装路径或 CLI 是否在 PATH。
- 每个 session 目录只选一个 canonical generation，按数值版本选最高者；同时验证文件名与 header version。高版本未知时报告不支持，不回退到旧文件重复计算；不同物理编码同时存在时明确报告歧义。
- 新增小型 `src/server/deepseekSessionLog.ts` 负责物理读取、帧边界扫描和格式诊断，与用量聚合分开。仅使用 Node 公共 API，不使用 `_handle` 等私有接口。
- 原生 Zstandard 可用时逐帧解压，并验证完整帧的校验和；不能一次解压整文件。原生不可用时用 `spawn` 和参数数组调用系统 `zstd`，输入限定为本次稳定读取的完整帧前缀，逐块消费 stdout；不使用 shell 字符串。若实现选择 `spawnSync`，必须显式配置 `maxBuffer`、超限诊断与 fixture，不能使用默认 1 MiB 上限（本机样本解压已超过 3 MiB）。原生能力按功能检测，避免旧 Node 静态导入失败。
- 两种 decoder 均不可用时，压缩源返回明确错误与安装提示；其他 agents 继续工作。原始 `.jsonl` 不要求 zstd。沿用仓库已有的“旧 Node 读取特定数据源需系统工具”兼容方式，参照 `README.md:65`、`:83` 的 SQLite 说明。
- 半写原始尾行忽略；半写压缩尾帧暂不计入，下次追加重读。首版仅公布完整帧组成的已提交前缀，不尝试复刻 Harness 对 torn frame 内残余行的恢复。完整帧损坏、非法事件或版本不匹配明确失败，不冒充零用量。
- 若复用官方 MIT 帧扫描代码，保留相应版权/许可说明；不引入 Harness 整套插件运行时。

### 2. 事件归一化与去重

实现可单测的纯函数，将事件折叠为 `DeepseekTokenEvent[]`：包含 session ID、源 seq、时间、provider、model、四个互斥 token 桶与总量。

- `assistant/message` 优先使用 `data.usage`；没有时从 embedded stream 取最后一份 usage。`assistant/attempt` 从 embedded stream 取最后一份 usage；不递归累加所有 usage。
- 对齐同版本官方 `token-meter/src/usage-projection.ts`：同一 turn/step 的后续样本替换该 attempt 的前样本；`llm/retry-started` 关闭替换槽，随后重试的 usage 单独累加。保留被替换项的索引，替换整条规范化事件，避免在图表中产生正负修正点。
- 替换样本采用最终结算事件的时间与模型；重试产生新的点。新增跨时间桶/跨日的替换测试，保证 daily 与 blocks 一致。
- 主数据模型读取 `data.message.source.provider/model`；attempt 或缺失 source 的记录使用当时 `request/header.data.header.config`，模型切换按事件顺序维护。无法识别时保留 unknown，不继承上一个无关会话的模型。
- 以 `input + output + cacheRead + cacheWrite` 为总量；input 已经是未缓存输入，不减缓存；reasoning 已包含于 output，不再加。校验所有计数为有限、非负整数；缺 usage 不估算，非法 usage 给出诊断。
- fork / seeded session 按最后一个 `session/end-seed` 且 `data.inherited === true` 排除继承前缀。未标记 inherited 的普通 end-seed 不作为截断点。排除前缀后仍保留路由恢复所需元数据。
- 同一真实新增子会话的 token 应计入一次；父日志中引用、复用内容和内嵌 stream 不产生额外用量。不按 message ID 或 turn/step 在所有会话间全局去重。
- 不使用 compaction 后的可见消息集重算历史消耗；已发生的非继承结算保留。上下文 pressure、projectedTokens、projection cache 和 SQLite 搜索索引均不作为用量真源。

### 3. 聚合、缓存与费用

- 对外实现 `getDailyResponse()`、`getProjectsResponse()`、`getBlocksResponse({ project, granularity })`，复用现有项目规范化、日期/时区规则及 1m/5m/15m/hour 粒度。`estimatedTokens` 为 0，不能因费用估算而把真实 token 标为估算。
- 使用 `buildUsageFileIndex` 保存不含正文的解析结果；发现新文件、追加、截断、删除、generation 切换均改变签名；parserVersion 升级使旧索引失效。会话查询另用包含文件选择结果的 source revision。
- 首版按变更文件整体重解析，并缓存未变化文件；暂不做持久化压缩字节游标。这样可正确处理替换样本、继承边界与截断，后续测量表明确有需要再做追加解析优化。
- 价格计算放在规范化 token 缓存之后，或把汇率/价格规则版本纳入缓存依赖；沿用已有 `modelCost` 与时间峰谷规则，设置汇率变更后必须重算，不能永久固化解析时费用。
- 对已确认的官方 provider 路由，局部将 `deepseek-flash` 价格查询映射到 `deepseek-v4.1-flash`；展示/原始模型名保留。`deepseek-v4-pro` 直接匹配。不能全局把任意第三方同名模型重新命名，也不能把 Go/AMAX 规则替换为 Harness 实际账单。
- 已知型号显示“参考价格估算”；未知型号保留准确 token，费用显示“价格未知”，不能伪装免费。向后兼容地增加 `costAvailable?: boolean`，缺省视为既有行为，任意参与项明确 false 则聚合结果 false。具体覆盖 `ModelBreakdown`、`DailyEntry`、`Totals`、`BlockEntry` 及其 Zod schemas；B 阶段还覆盖 `SessionUsage`、`SessionSummary`、session analytics summary。不能仅在 model breakdown 增字段，否则 totals 与 blocks 会丢失语义。
- 数字费用字段仍保存已知部分的估算小计；当 `costAvailable === false` 时，Web KPI/曲线提示、模型表、AllAgentsStats、Popover、Swift tooltip 与 Tauri 金额展示均显示“价格未知 / 部分估算”，不能把数字小计当完整费用。补齐 `agentAggregation.ts`、项目/时间过滤、Popover 派生类型、Swift `APIModels.swift` / badge 派生模型及 Tauri `usage.rs` 的可选字段解析和布尔 AND 传播；旧响应缺省保持兼容。
- 具体补上 `Dashboard.tsx:141` 的项目合并、`:376` 的 totals reduce 和 `AllAgentsStats.tsx:63` 的独立汇总。`Dashboard.tsx:786` 目前通过 `getPricing(rawModelName)` 判断未知价格；改为优先消费上述可用性元数据，缺省才沿用旧逻辑，避免局部别名已经成功计价却仍报 `deepseek-flash` 价格未知。

### 4. 单来源失败隔离与能力降级

- DeepSeek 单来源请求遇到无解码器或完整文件损坏时明确报错，不返回伪造的空成功响应。已有其他 agent 的单来源请求不受影响。
- 当前 All Agents 的 `client/api/client.ts:54`、`:82`、`:94`、`:111` 使用 `Promise.all`，Tauri `usage.rs:46` 使用逐源 `?`，都会因新增来源失败使整次聚合失败。因此 A 阶段必须做有测试的按来源隔离，不能只依赖“动态来源”就声称桌面无需改动。
- Web 对 All 模式的每个来源整组请求分别结算：只合并该来源成功的结果，在响应的可选 `sourceErrors` 元数据中保留失败来源与简洁原因，并在数据 hook / Dashboard 展示部分数据状态。补齐 daily/projects/blocks/analytics 响应类型和相应 schema / 合并函数的元数据传播，避免 Zod 去除新增字段。blocks/analytics 的项目子请求按来源作为一个单元，失败不产生来源内半份统计。单来源模式照常报错；全部来源失败时保留错误/旧数据，不显示成功的 0。
- Tauri `fetch_today` 改为逐源收集成功值和失败信息，成功来源至少一个时保留部分总量并标注不完整；全部失败时返回错误。Swift / Popover 已跳过部分失败请求，但仍需补充失败来源标记，并防止全部失败时清空为零。总额完整性同时考虑 `sourceErrors` 与价格未知。
- A 阶段 Dashboard 对 `deepseek` 的会话区域显示明确“会话详情尚未接入”占位，而非显示“0 个会话”；All 模式会话统计旁标注暂不含 DeepSeek。现有 `SessionAnalyticsCapabilities` 没有整体 supported 字段，不能假设全 false 就会隐藏区块；在 `Dashboard.tsx:788` 的渲染处做局部 guard，B 完成后移除。A 的 analytics 同样明确隐藏，后端返回 `EMPTY_ANALYTICS` 防止 Claude fallback。

## 实施顺序与交付物

### 里程碑 A：核心统计可用

1. **建立输入契约与解码回归测试**
   - 新增 `src/__tests__/server/deepseekSessionLog.test.ts` 与结构脱敏 fixture：V4 raw、多帧 zstd、校验失败、半写尾、版本不匹配、多 generation、缺解码器。
   - 使用本次调研确认的官方事件结构制作合成数据；不提交本机原始聊天。多帧 fixture 必须在单次 one-shot 解压只读首帧时失败，防止假阳性。
   - 完成 `deepseekSessionLog.ts`，用公共 Node API 与 zstd fallback 两条路径验证同一结果。

2. **实现用量 reducer 和三类统计**
   - 新增 `deepseekParser.ts` / `deepseekParser.test.ts`，实现上述结算替换、重试、继承处理、模型切换、计价和文件索引。
   - 测试 daily/projects/blocks 合计相等、项目过滤、多模型、跨日/时区、所有粒度、价格未知和汇率/峰谷变化。
   - 加入 `agentDetection.ts:29`、`routes/api.ts:101`、`index.ts:90` 的来源发现和诊断；覆盖 deepseek-only 安装及其他源不受影响。

3. **打通 API、Dashboard 和桌面汇总**
   - 标准路由：`routes/daily.ts:44`、`projects.ts:44`、`blocks.ts:58`；兼容路由 `monthly.ts:24`、`session.ts:24` 显式接入同一 daily 适配器。
   - 暂未实现的 `/analytics?agent=deepseek` 返回现有 `EMPTY_ANALYTICS`，不回落 Claude；按上文的局部 guard 隐藏工具分析、显示会话未接入占位和 All 模式说明，不能把空会话数组展示为真实零会话。里程碑 B 完成后解除此限制。
   - 更新 Dashboard 的 agent 类型、选项、图标与名称，以及 `agentAggregation.ts:6`、`AllAgentsStats.tsx:8` 的来源标签；透传费用可用性标记并处理 All Agents 的不完整费用。
   - Popover / Swift / Tauri 保留动态来源发现，按上文明确补齐费用完整性和失败隔离；不做无关的来源注册架构重写。
   - 扩充 `usageSupport.test.ts`、`forceRefreshRoutes.test.ts`、`blocksGranularity.test.ts` 与 `e2e/fixtures.ts`、`e2e/dashboard.spec.ts`。README 增加目录、zstd 兼容、能力和费用语义。

里程碑 A 完成即可交付本轮核心需求；不会宣称已支持会话正文或工具生产力分析。

### 里程碑 B：会话与工具分析

4. **接入会话索引与详情**
   - `sessionAnalyticsParser.ts:362`、`:954` 加来源 revision 与 `deepseekSessionsToIndexed`；`sessionTranscripts.ts:24` 增加 reader。
   - 以 `user/message`、`assistant/message`、`tool/call`、`tool/result` 映射现有事件结构；工具以 callId 关联，文本预览沿用现有脱敏/截断规则。输入历史与本会话新增 usage 分开，历史正文可用于展示，继承 token 不再次计费。
   - 状态有明确事件才映射，否则 unknown；锁文件存在不能单独证明 active。不把普通工具名称强行解释为 Skill，缺失 skill 能力保持 false。
   - 覆盖搜索、分页、模型/项目/时间筛选、详情、all 下 `deepseek::id`、追加后刷新、工具结果失败和子会话归属。

5. **按已有数据开放工具分析**
   - `routes/analytics.ts:54` 加 `deepseek` 的 `extractSessionToolCalls` 分发；Dashboard 解除对应能力限制。
   - 工具频次可先完整接入；代码增删行只有在 Harness 编辑工具参数或结果明确提供可验证 diff 时统计，不能用调用次数推算行数。
   - 会话能力与分析能力按实际证据启用，补充 `sessionParserCompatibility.test.ts`、`sessionAnalyticsParser.test.ts`、E2E 的真实能力配置。

### 收尾与验证

6. **执行质量门禁与本机对照**
   - 每个里程碑都完成 typecheck、全部 unit tests、production build 和 E2E；本仓库没有 lint script，不虚构 `npm run lint`。
   - Node 20 是支持门禁：必须至少一次使用真实 Node 20 运行系统 zstd fallback、raw 读取及无 decoder 错误分支；不能只 mock 原生 API 不存在。原生 decoder 还需较新 Node 22 或 Node 24 实测。加入解压结果超过 1 MiB 的多帧 fixture，并校验无系统 zstd 的 Windows/macOS 路径会给出清楚提示。
   - 在本机只读验证 TokenDash 对两份日志的结果，按稳定快照与 Harness projection cache 对照；本次基准见下表，若日志继续增长则重新取同一时间快照，不能硬编码旧合计为实时断言。
   - macOS Popover/Swift 验证一次来源汇总；Tauri Linux/Windows 的动态来源通过 fixture/API 测试及对应平台 CI 验证。未实际跑的平台单列证据缺口。

## 可测试验收条件

| 编号 | 通过条件 |
| --- | --- |
| A1 | deepseek-only fixture 能启动并在 `/api/agents` 返回 available/default=`deepseek`，Dashboard 自动选中 |
| A2 | V4 raw 与多帧 zstd 的四个 token 桶、总量、模型和项目完全相同；两种 decoder 结果一致 |
| A3 | 直接 usage 与 stream 副本只计一次；同一步替换不叠加；retry 边界后的新 attempt 单独累加 |
| A4 | seeded 父历史只在原始消费会话计一次，child 自己新增的 usage 正常进入 all 汇总；普通 end-seed 不误截断 |
| A5 | daily 总量 = projects 所有项目总量 = blocks 对应完整时间范围的总量；时间桶边界、替换及跨日符合项目日期规则 |
| A6 | 未改变文件复用缓存；追加、截断、删除、generation 切换与手动 refresh 更新结果；汇率/价格规则变化更新金额 |
| A7 | 半写尾部保留完整前缀且追加后恢复；完整帧损坏/未知格式/解码器缺失有明确错误，其他 agents 正常 |
| A8 | 官方 deepseek-flash 使用已核实价格别名；第三方同名模型不强制套用；未知价格显示未知、All 的金额标为不完整 |
| A9 | deepseek 所有已接入 API 不返回 Claude 数据；A 阶段 analytics/session details 明确显示未支持，All 会话统计注明不含 DeepSeek |
| A10 | Dashboard 来源切换、项目/模型/时间筛选、刷新、All Agents 和托盘不会漏计或重复计入 DeepSeek |
| A11 | DeepSeek 失败但 Claude 成功时 Web All、Popover、Swift、Tauri 保留 Claude 数值并标记不完整；全部失败时显示错误/旧数据，不产生成功的零值 |
| A12 | 未知价格标记经 schema 校验、模型合并、日/项目/时间过滤、blocks、All、桌面派生后仍保留；旧响应缺少可选字段时不变 |
| A13 | 真实 Node 20 fallback 与 raw 路径通过，原生 zstd 路径通过；超过 1 MiB 输出不被截断，无系统 zstd 时显示可操作诊断 |
| B1 | 会话列表/搜索/分页/详情与 all 的命名空间正确；工具调用/结果一一关联，继承用量不翻倍 |
| B2 | 工具频次与源事件一致；无可靠 diff 时不产生虚构增删行；Skill 能力不冒充可用 |

本机基准（2026-11-04 的稳定读取结果）：未缓存输入 `172,909`、输出 `112,394`、缓存读取 `24,112,512`、缓存写入 `0`、总计 `24,397,815`，来自 176 条 assistant/message。与 Harness projection cache 的四桶累计一致；无重试/继承的本地样本不能替代这些边界的合成测试。

验证命令：

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
git diff --check
```

## 风险与处理

| 风险 | 处理 |
| --- | --- |
| 日志版本继续演进，README 示例落后于 V4 实际代码 | 按同安装版本 tag 的类型/codec 建契约；每 session 只选最高 generation，未知版本明确拒绝 |
| 系统 Node 无 zstd 或只解出首帧 | 逐帧公共 API + 系统工具 fallback；用至少两个独立帧做固定回归 |
| 失败 attempt、重试、fork、迁移导致多计 | 对齐官方 reducer 与继承边界；只选一代文件；为 replacement、retry、fork 单独写断言 |
| 长日志同步解压拖慢服务 | 按文件缓存、不展开内嵌流正文；测量冷读/热读和单文件追加，再决定是否用异步/worker，首版不增加通用调度层 |
| 缓存包含价格或失效条件遗漏 | 规范化 token 与计价分离；revision 纳入路径选择/mtime/size，价格与汇率独立失效 |
| 模型别名漂移或第三方覆盖 | 别名限定已核实的官方 provider，保留原名；未知价格显式表示不可用 |
| 辅助标题请求等消耗没有落到结算日志 | 产品说明统计已记录 usage，不保证账单对齐；不通过文本长度补造精确用量 |
| 只改主页面导致桌面漏来源 | 测试 `/agents` 驱动的三条桌面汇总链；已有动态逻辑无需盲目重写 |
| 来源失败使 All 或 badge 整体失败 | A 阶段补齐按来源隔离、全部失败保护和可见的不完整标记；验证实际失败路径而非仅成功 fixture |

## 2026-11-04 规划阶段记录

已完成本机只读数据探测、官方同版本源码核对、多帧解码实证及开发计划。未修改产品源代码、依赖或版本，未执行发布、提交或真实模型调用。开发时按 A → B 顺序推进；第一轮先完成可独立验收的 A。

独立只读复核已纳入四项修订：费用可用性跨响应/桌面的传播、A 阶段会话未支持提示、All/托盘的来源失败隔离、真实 Node 20 与大于 1 MiB 解压输出的验证门禁。
