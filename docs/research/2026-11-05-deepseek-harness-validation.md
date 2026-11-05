# DeepSeek Harness 接入交付与验证

日期：2026-11-05。基于 TokenDash `1.10.0` / 仓库基线 `6d140b3` 开发；本次未改依赖或发布版本，未提交、推送或发布。

## 已交付能力

- 独立 `deepseek` 数据源，显示名 DeepSeek Harness；自动发现默认 `~/.dsh/sessions/` 和 `DSH_HOME/sessions/`。
- V4 raw JSONL 与多帧 Zstandard 读取；只选最高 canonical generation，校验版本和完整帧，容忍半写尾部，明确诊断损坏/不支持格式。
- 按官方结算规则处理 message/stream 副本、同一步样本替换、retry 和 fork 继承；reasoning 不重复累加，四个 token 桶保持互斥。
- 日、项目、模型、时间桶统计及完整 Dashboard / All Agents / Popover / 原生托盘汇总。
- 会话索引、搜索、筛选、分页、详情、正文与 reasoning 预览、工具调用/结果关联、工具频次与有成功结果证据的编辑统计。
- 区分真实用户请求与时钟、技能目录、运行时上下文等注入记录；没有原生 Skill 调用证据时不虚构 Skill 指标。
- 官方模型价格别名与现有参考费用估算；未知价格及失败来源的不完整金额标记，贯穿 Web、Popover、Swift 和 Tauri。
- 按来源隔离错误，保留健康来源；全部刷新失败时保留旧显示并给出错误/过期提示。

主要实现入口：`src/server/deepseekSessionLog.ts`、`deepseekParser.ts`、`deepseekTranscripts.ts`；接入 `sessionAnalyticsParser.ts`、六个统计/分析路由、来源检测和客户端。新增样例均为合成结构，没有提交原始本机对话或凭据。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过，服务端与前端 |
| `npm test` | **41 个文件、288 项通过** |
| `npm run build` | 通过，Vite、TypeScript、server/daemon bundle |
| `npm run test:e2e` | **51 项通过**，含 4 项新增 DeepSeek/失败恢复场景 |
| `swift test` | **49 项通过** |
| `swift build -c release` | 通过 |
| `cargo test --locked --lib --jobs 2` | **32 项通过**，当前 macOS arm64 target |
| `cargo check --locked --all-targets` | 通过，当前 host target 的所有 Cargo targets |
| `cargo fmt --check` | 通过 |
| Node 20 实际运行 | `v20.20.2`，系统 zstd fallback 解出 **3,127,539 字节 / 1,373 行**；raw 与缺 decoder 提示均通过 |
| Node 24 原生解码 | 实际读取本机多帧日志，usage 与系统 zstd 一致 |
| 本机真实 HTTP API | daily/projects/blocks/session analytics/detail 与 Harness projection 累计一致 |
| 独立代码复核 | 已修复旧数据无错误提示和 Swift cache-write 命中率分母遗漏；未发现其他阻塞项 |
| 文档/源码 | `git diff --check` 通过；帧扫描源代码保留完整 MIT 声明，构建 bundle 保留该 license 注释 |

系统 Node 20 通过临时 npm runner 运行，未修改仓库依赖。Rust 工具链安装在 `/tmp/tokendash-deepseek-rust`，验证过官方 checksum，未修改全局 PATH。Rust 构建所需 daemon 资源通过现有 `scripts/stage-server.mjs` 放入忽略目录 `src-tauri/gen/server`。

构建仍有现有大 bundle 体积提醒；不影响本轮构建和测试。原先受本机凭据干扰的一项 quota normalization 测试已改为隔离配置与 credential reader，产品配额逻辑未修改。

## 本机数据对照

经本地临时 Express server 的实际 HTTP endpoint 验证，使用只读 Harness 数据及隔离的临时 TokenDash 索引：

| 指标 | 结果 |
| --- | ---: |
| 未缓存输入 | 172,909 |
| 输出（含 reasoning） | 112,394 |
| 缓存读取 | 24,112,512 |
| 缓存写入 | 0 |
| 总 token | **24,397,815** |
| 模型调用 | 176 |
| 工具调用 | 173 |
| 真实用户轮次 | 3 |

一致性断言：`daily.totals` = 所有项目合计 = 全部 hourly blocks 合计 = session analytics 合计 = 会话详情 llm_call usage 合计 = Harness projection cache 四桶合计。

注意本地共有 11 条 `user/message`，只有 3 条 source.kind 为 `user`，其余为上下文注入。此修正已有独立回归测试。

## 验证边界

- 本次支持契约是 Harness **V4**；V0–V3 / 未知未来格式会明确提示，不做源数据迁移。
- Node 20 没有原生 zstd 时，压缩文件需要系统 `zstd`；raw 日志无需外部工具。
- 费用为 TokenDash 现有模型参考价估算，不是 DeepSeek 账号账单；未持久化到会话结算中的辅助调用无法由此数据源恢复。
- Swift 和 Rust 在当前 macOS arm64 上执行验证；未在本轮实际构建或安装 Linux/Windows 安装包，未发布任何平台版本。
- 本次没有更改或删除 Harness 原始日志、账户配置和凭据。

依据：[原始开发计划](../superpowers/plans/2026-11-04-deepseek-harness.md)、[本机调研](2026-11-04-deepseek-harness-local.md)、[官方同版本调研](2026-11-04-deepseek-harness-official.md)。

## 英文文案统一与发版准备（2026-11-05 后续）

- Web / Popover / 会话面板 / 设置 / All Agents 弹窗 / 托盘 / 原生启动页及向用户展示的后端错误均统一为英文。
- 日期、星期、时间和数值采用显式英文 locale，保留原有本地时区；Swift 增加两项日期格式回归，防止中文系统重新引入中文文案。
- TypeScript AST 审计：生产 client、popover、server、shared 的字符串、模板及 JSX 中中文片段为 **0**。代码注释和用户日志中的原文不在替换范围内；原生 Unicode 路径测试保留。
- 更新后的验证：单元测试 **288 项**、E2E **51 项**、Swift **51 项**、Rust **32 项**均通过；typecheck、production build、Swift release build、Rust all-target check / fmt 与 whitespace 检查通过。
- 本地服务仍在 `http://127.0.0.1:3460/`，已加载并检查英文版 DeepSeek 主页面与设置面板。
- 只读查询确认 npm 与 GitHub 最新公开版本均为 **1.10.0**；新增 agent 能力建议发布为 **1.11.0**。版本文件当前未修改。
- 尚未形成干净且已提交的候选，也没有这组变更对应的完整桌面 CI。`scripts/deploy.sh` 明确要求这些条件，因此尚未运行 deploy、创建 tag、上传安装包或发布 npm/GitHub Release。后续应按 `docs/updating.md` 的统一版本、精确提交 CI、deploy:check 和 deploy 流程推进。
