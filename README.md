# NVW (Neovim Web)

<p align="center">
  <strong>纯净、极简的本地 Neovim Web 工作台。遵循 <a href="https://webtui.ironclad.sh/">WebTUI</a> 官方规范构建，直连本机 Neovim 实例。</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/Neovim-0.9%2B-57A143?logo=neovim&logoColor=white" alt="Neovim">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D18.0.0-339933?logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/WebTUI-Compliant-8A2BE2" alt="WebTUI">
</p>

---

## 💡 为什么做 NVW？

在浏览器中使用 Neovim 通常有两种传统方案：
1. **基于 PTY + 终端模拟器 (如 xterm.js)**：容易遇到 VT 转义序列解析、DPR 缩放发虚、字符间距抖动及字符度量不准等问题。
2. **基于 Web 编辑器核心 (如 Monaco/CodeMirror) 模拟 Vim 键位**：缺乏原生 Neovim 的真实配置、Lua 插件生态以及撤销树和宏等完整底层能力。

**NVW 采用全新主链架构**：
- **直连核心**：通过 `nvim --embed` 的常驻 msgpack-RPC 协议与本机真实安装的 Neovim 通信。Neovim 始终是文本状态、模式、编辑操作、撤销树与插件的权威来源。
- **WebTUI 原生美学**：界面完全采用 WebTUI 官方声明式布局与框线组件构建，零私写乱序样式。
- **行级 DOM 网格渲染**：将 UI 事件映射为原生 DOM 行与字符节点，文本排版交给现代浏览器渲染引擎，字形原生清晰、零间隙、极低延迟。

---

## ✨ 核心特性

- 🚀 **真实 Neovim 驱动**：加载你的本地配置 (`~/.config/nvim`) 与插件，原生支持宏录制、寄存器、撤销重做与分屏操作。
- 🖥️ **完整 UI 协议解析**：准确遍历并消费 Neovim `redraw` 事件流（`grid_line`、`grid_scroll`、`hl_attr_define`、`default_colors_set`、`mode_info_set` 等），按 `flush` 边界帧级提交，无撕裂与旧屏残留。
- 📁 **结构化工作区切换**：支持浏览并切换项目工作区，自动协调全局工作目录 (`cwd`) 与各分屏窗口的局部路径 (`lcd`/`tcd`)，并集成未保存修改防护拦截。
- ⌨️ **现代编辑器交互**：
  - 支持中文输入法（IME）平滑合成与单次精准提交。
  - 内置 `:terminal` 终端画面渲染与命令交互。
  - 原生代码补全下拉菜单与快捷选入。
  - 动态行列尺寸自动适配（支持 1440×900、1024×768 及 390×844 移动端等视口）。
- 🎨 **主题无缝融合**：支持 Catppuccin (Mocha / Latte)、Nord、Gruvbox、Everforest、Vitesse 等官方主题，编辑器配色与网页外壳高度一致。
- 🔄 **断线快照恢复**：服务端权威镜像维护网格与高亮状态，页面刷新或断线重连时瞬间恢复全量快照，不丢内容、不白屏。

---

## 🛠️ 快速开始

### 依赖环境

- [Node.js](https://nodejs.org/) (>= 18.0.0)
- [Neovim](https://neovim.io/) (>= 0.9.0，推荐 0.10+)
- [pnpm](https://pnpm.io/) (推荐) 或 npm / yarn

### 安装步骤

```bash
# 1. 克隆本仓库
git clone https://github.com/A5he1ter/NVW.git
cd NVW

# 2. 安装项目依赖
pnpm install
```

### 启动服务

```bash
# 启动本地服务（默认端口 3999，绑定 127.0.0.1）
pnpm start
```

服务就绪后，在浏览器中访问：
```
http://127.0.0.1:3999
```

### 命令行工具 (CLI)

NVW 自带 CLI 启动工具，支持便捷管理：

```bash
# 在指定目录启动并自动在浏览器中打开
./bin/nvw.js web /path/to/your/project

# 在指定端口启动
./bin/nvw.js web -p 5000

# 检查服务运行状态
./bin/nvw.js status

# 停止正在运行的服务
./bin/nvw.js stop
```

---

## ⌨️ 常用快捷键

| 快捷键 | 功能描述 |
| :--- | :--- |
| `Mod + K` (⌘K / Ctrl+K) | 模糊查找工作区文件 |
| `Mod + Shift + F` | 快速聚焦左侧文件过滤输入框 |
| `Mod + B` | 切换专注模式 (Zen Mode，隐藏侧栏与顶栏) |
| `Mod + ,` | 打开设置面板（调整字号、行高、光标样式） |
| `Mod + /` | 查看按键与文档速查表 |
| `Mod + S` | 保存当前缓冲区文件 (`:write`) |
| `Alt + W` | 安全关闭当前缓冲区（有未保存修改时弹窗提醒） |
| `Alt + ↑` / `Alt + ↓` | 切换上一个 / 下一个已打开的标签页 |
| `Mod + J` | 焦点快速回到 Neovim 编辑网格 |
| `Esc` | 关闭当前弹窗 / 退出专注模式 |

---

## 📐 系统架构

```text
┌────────────────────────────────┐
│      浏览器客户端 (WebUI)        │
│  · 行级 DOM 渲染 (grid-renderer) │
│  · 输入与按键编码 (input.js)      │
│  · WebTUI 外壳与弹窗组件        │
└───────────────▲────────────────┘
                │ WebSocket (JSON 增量帧 / 状态快照)
                ▼
┌────────────────────────────────┐
│     Node.js 本地后端服务        │
│  · 会话管理 (ensureUiSession)    │
│  · 权威网格状态镜像 (GridState)  │
│  · 工作区协调与 REST API         │
└───────────────▲────────────────┘
                │ msgpack-RPC (常驻 stdio)
                ▼
┌────────────────────────────────┐
│    本机真实 Neovim 实例        │
│     (nvim --embed)             │
│  · 权威编辑状态、语法高亮、插件  │
└────────────────────────────────┘
```

---

## 🧪 自动化测试

项目内置了严格的规范纯度与行为测试套件：

```bash
# 1. 运行 WebTUI 规范纯度静态审计（确保零自写样式、纯组件框线）
pnpm test

# 2. 运行 Neovim 核心编辑功能套件（写盘/撤销/宏/分屏/浮窗/终端/补全）
node tests/test_e05_editing.mjs

# 3. 运行浏览器端到端行为断言（IME合成、终端执行、补全落盘、重连恢复）
node tests/test_browser_interaction.mjs
```

---

## 👥 贡献者 (Contributors)

感谢所有参与 NVW 建设、代码编写、架构设计与审查测试的贡献者！

- **[AShelter](https://github.com/A5he1ter)** - *Author & Maintainer*
- **ChatGPT** - *Architecture Review & Code Verification*
- **Gemini** - *Core Implementation & Lifecycle Engineering*

欢迎提交 [Issue](https://github.com/A5he1ter/NVW/issues) 或 [Pull Request](https://github.com/A5he1ter/NVW/pulls) 参与贡献！

---

## 💖 致谢与技术栈 (Acknowledgements)

本项目的前端界面与终端美学深度依赖并遵循以下优秀开源项目的规范与设计：

- **[WebTUI](https://webtui.ironclad.sh/)** ([GitHub](https://github.com/ironclad/webtui))：提供官方 CSS 组件、声明式布局插件与 TUI 框线系统，是 NVW 前端终端风格视觉的基础。
- **[Neovim](https://neovim.io/)**：现代、可扩展的文本编辑器核心，为本项目提供权威的编辑状态与 msgpack-RPC UI 协议。

---

## 📄 开源许可证

本项目采用 [MIT License](LICENSE) 开源许可证。
