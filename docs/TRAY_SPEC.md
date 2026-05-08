# TokenDash 菜单栏 Spec

> 当前状态：v1.3.0 已实现
> 最后更新：2026-05-06

---

## 1. 架构概览

```
┌─────────────────────────────────────────────────┐
│  trayHelper (Swift binary)                      │
│  - 创建 macOS 菜单栏图标                         │
│  - 右键菜单: Open Dashboard / Quit               │
│  - stdin/stdout 协议与 Electron 通信             │
└───────────────┬─────────────────────────────────┘
                │ stdin: title:<text>, tooltip:<text>, quit
                │ stdout: click, rightclick, open-dashboard, quit-request, ready
┌───────────────┴─────────────────────────────────┐
│  Electron main.cjs                              │
│  - 启动 Express 服务器                           │
│  - 管理 trayHelper 进程                          │
│  - 定时刷新 badge (每 5 秒)                      │
│  - 管理 popover 窗口                             │
└───────────────┬─────────────────────────────────┘
                │ HTTP
┌───────────────┴─────────────────────────────────┐
│  Express Server                                 │
│  - /api/agents   → 可用 agent 列表               │
│  - /api/daily?agent=X → 每日数据                 │
│  - /api/blocks?agent=X → 时段数据 (图表)         │
│  - /popover.html → 静态页面                      │
└─────────────────────────────────────────────────┘
```

### 文件清单

| 文件 | 作用 |
|------|------|
| `electron/main.cjs` | Electron 主进程：服务器启动、tray 管理、badge 刷新、popover 窗口 |
| `electron/trayHelper.swift` | 原生 macOS 菜单栏二进制，stdin/stdout 通信协议 |
| `electron/trayBadge.cjs` | 工具函数：`formatTokens()`、`formatCost()`、`createBadgeIcon()` |
| `public/popover.html` | 点击图标后弹出的详情卡片页面 |
| `electron-builder.yml` | 打包配置，签名跳过 (`identity: null`) |
| `esbuild.config.mjs` | 将 Express 服务器打包为 CJS 供 Electron 加载 |

### 已解决的问题

| 问题 | 解决方案 |
|------|----------|
| macOS 26 `NSStatusBar` 接口不再可用 | 使用 Swift 编写的独立 trayHelper 二进制进程 |
| trayHelper 在 asar 内无法执行 | 启动时自动提取到 `userData/helpers/` |
| `import.meta.url` 在 CJS 中为 undefined | esbuild banner + define 替换 |
| 路径不一致（esbuild bundle vs tsc 输出） | `createApp` 接受 `baseDir` 参数 |
| macOS 26 代码签名冲突 | `identity: null` 跳过签名 |

---

## 2. 已实现功能

### 2.1 菜单栏 Badge

- **显示内容**：今日所有 agent 的 token 总数
  - 格式：`1.2K` / `32.0M` / `123`
  - 具体逻辑：`formatTokens(totalTokens)`，见 `trayBadge.cjs`
- **Tooltip**：`TokenDash - 32.3M tokens today ($11.10) | cache: 98.4%`
- **更新频率**：每 5 秒（从 `/api/agents` → 并行请求每个 agent 的 `/api/daily`）

### 2.2 多 Agent 汇总

- 先请求 `/api/agents` 获取可用 agent 列表（claude / codex / opencode）
- 对每个 agent 并行请求 `/api/daily?agent=X`
- 汇总今日的 `totalTokens`、`totalCost`、`inputTokens`、`outputTokens`、`cacheReadTokens`
- 任何 agent 请求失败不影响整体结果

### 2.3 Popover 详情面板

- **触发**：左键点击菜单栏图标
- **尺寸**：340×460，无边框，置顶，失焦自动关闭
- **数据来源**：同 multi-agent 汇总逻辑
- **显示内容**：
  - Header: `Today May 6`
  - 四个卡片：`Input` / `Output` / `Cache Rate` / `Total Tokens`
  - 24 小时柱状图（来自 `/api/blocks`，目前仅 default agent）
  - `Open Dashboard` 按钮（在浏览器中打开完整 dashboard）
- **自动刷新**：每 5 秒

### 2.4 右键菜单

- `Open Dashboard` — 在浏览器打开 `http://localhost:3456`
- `Quit TokenDash` — 关闭应用

---

## 3. 待补充需求

> 以下为占位，等待你补充具体需求。

### 3.1 菜单栏 Badge

- [ ] （补充）

### 3.2 Popover 详情面板

- [ ] （补充）

### 3.3 右键菜单

- [ ] （补充）

### 3.4 其他

- [ ] （补充）

---

## 4. 构建与打包

```bash
# 完整构建
npm run build          # vite + tsc + esbuild

# 打包 Electron .app（跳过签名）
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:electron

# 输出
release/TokenDash-1.3.0-arm64.dmg
```

---

## 5. 通信协议详情

### trayHelper stdin 命令

| 命令 | 说明 |
|------|------|
| `title:<text>` | 设置菜单栏文字 |
| `tooltip:<text>` | 设置 tooltip |
| `quit` | 终止 trayHelper 进程 |

### trayHelper stdout 事件

| 事件 | 触发 |
|------|------|
| `ready` | trayHelper 初始化完成，通知 Electron 开始更新 |
| `click` | 左键点击图标 |
| `open-dashboard` | 右键菜单选择 Open Dashboard |
| `quit-request` | 右键菜单选择 Quit |

---

## 6. 已知限制

1. **柱状图只显示一个 agent**：`/api/blocks` 默认只请求 claude，未聚合所有 agent
2. **无 icon**：使用默认 Electron 图标，没有自定义 app icon
3. **popover 位置**：固定在屏幕右上角，未跟踪图标实际位置（trayHelper 未反馈位置）
4. **无菜单项显示 agent 分布**：tooltip 只显示总量，不知道哪个 agent 消耗最多
