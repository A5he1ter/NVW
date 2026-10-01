# NVW (Neovim WebTUI)

> **开发预览版 (Developer Preview)**：NVW 是一个运行在浏览器里的本地 Neovim 工作台，基于 [WebTUI](https://webtui.ironclad.sh/) 规范构建，直接连接本机的 Neovim 进程。当前处于持续迭代阶段，适合尝鲜与本地实验。

---

## 背景与设计

在浏览器里使用 Neovim 通常有两类做法：

1. **PTY 加终端模拟器（如 xterm.js）**：容易出现转义字符解析偏差、屏幕缩放字形模糊、字符宽度与行高不对齐等问题。
2. **Web 编辑器模拟 Vim 键位（如 Monaco 或 CodeMirror）**：无法使用本机的 init.lua/init.vim 配置、Lua 插件生态以及完整的底层撤销树和宏。

NVW 采用如下架构：

- **直连后端**：通过 `nvim --embed` 建立常驻 msgpack-RPC 连接，Neovim 负责维护文本、模式、撤销树、插件与寄存器状态。
- **WebTUI 界面**：布局与面板框线使用 WebTUI 官方组件与规则，不引入额外的独立 CSS 样式类。
- **行级 DOM 渲染**：将 UI 事件转换为 DOM 行与文本节点，利用浏览器的字体排版引擎显示文本，避免 Canvas 在高分屏下的缩放模糊问题。

---

## 主要功能

- 加载本机配置（`~/.config/nvim`）与插件，支持分屏、浮窗、宏录制与寄存器操作。
- 完整消费 Neovim 的 `redraw` 事件流（包括 `grid_line`、`grid_scroll`、`hl_attr_define`、`default_colors_set`、`mode_info_set` 等），按 `flush` 边界更新画面。
- 支持切换工作区目录，自动同步全局工作目录（`cwd`）与分屏窗口的局部工作目录（`lcd`/`tcd`），切换前检查未保存修改。
- 广泛版本兼容：高亮表采用字符串键映射，支持 Neovim 0.9.x 至 0.12.x 版本。
- 内置本地 Nerd Font 图标字体回退，在离线或 CDN 受限环境下图标可正常显示。
- 中文输入法（IME）合成事件分发，避免字符重复或漏字。
- 支持 `:terminal` 终端缓冲区与命令交互。
- 弹出式代码补全菜单与选项插入。
- 自动根据容器与基础字号适配行列数，支持桌面与移动端视口。
- 内置 Catppuccin（Mocha / Latte）、Nord、Gruvbox、Everforest、Vitesse 等配色。
- 服务端维护权威网格状态镜像，刷新页面或重连时下发完整快照。

---

## 环境要求

- Node.js (运行环境 >= 18.0.0；若运行包含 puppeteer-core 的无头自动化测试建议 >= 22.12.0)
- Neovim (开发与主测环境基于 v0.12.5，兼顾 v0.9.x ~ v0.12.x 协议映射)
- pnpm (推荐 v9/v12) 或 npm
- 支持操作系统：macOS / Linux / WSL (CLI 部分管理指令依赖 Unix 工具链)

---

## 安装与启动

```bash
# 克隆仓库
git clone https://github.com/A5he1ter/NVW.git
cd NVW

# 安装依赖
pnpm install

# 启动服务（默认监听 127.0.0.1:3999）
pnpm start
```

启动后在浏览器打开：
```
http://127.0.0.1:3999
```

也可以使用配套的 CLI 工具：

```bash
# 打开指定工作区并在浏览器中查看
./bin/nvw.js web /path/to/project

# 指定端口启动
./bin/nvw.js web -p 5000

# 检查服务状态
./bin/nvw.js status

# 停止服务
./bin/nvw.js stop
```

---

## 快捷键

| 快捷键 | 功能 |
| :--- | :--- |
| `Mod + K` (⌘K / Ctrl+K) | 查找工作区文件 |
| `Mod + Shift + F` | 聚焦侧栏文件过滤框 |
| `Mod + B` | 切换专注模式（隐藏顶栏与侧栏） |
| `Mod + ,` | 打开设置面板 |
| `Mod + /` | 打开按键文档面板 |
| `Mod + S` | 保存当前文件（`:write`） |
| `Alt + W` | 关闭当前缓冲区（有修改时提示） |
| `Alt + ↑` / `Alt + ↓` | 切换前一个 / 后一个缓冲区 |
| `Mod + J` | 聚焦到编辑器网格 |
| `Esc` | 退出弹窗或专注模式 |

---

## 系统结构

```text
┌────────────────────────────────┐
│      浏览器客户端 (WebUI)        │
│  · 行级 DOM 渲染 (grid-renderer) │
│  · 输入与按键编码 (input.js)      │
│  · WebTUI 界面组件              │
└───────────────▲────────────────┘
                │ WebSocket (JSON 增量帧 / 快照)
                ▼
┌────────────────────────────────┐
│     Node.js 本地服务            │
│  · 会话生命周期管理             │
│  · 网格状态镜像 (GridState)     │
│  · 工作区协调与 REST API         │
└───────────────▲────────────────┘
                │ msgpack-RPC (stdio)
                ▼
┌────────────────────────────────┐
│      本机 Neovim 实例          │
│       (nvim --embed)           │
│  · 状态、高亮与插件管理         │
└────────────────────────────────┘
```

---

## 验证边界与测试

本项目采用严格分层测试，区分已自动化验证的核心路径与当前边界：

- **已通过核心测试**：
  - 纯度审计：遵循 WebTUI 官方契约，无自写 class 与内联样式。
  - 双端网格：服务端与客户端正负方向滚动、视口行列适配、大文本分段输入与无损粘贴。
  - 协议与编辑：首屏 redraw 事件流完整消费、文件读写、撤销重做、宏与分屏。
  - 异常安全：来源与 Host 校验、优雅关机与子进程回收、工作区路径防逃逸。
- **当前边界**：
  - 系统级原生输入法候选框依赖各桌面视窗环境，当前浏览器端仅测试标准合成事件链路。
  - 核心编辑流程已跑通，针对复杂的第三方 Neovim 插件矩阵适配仍在持续进行中。

```bash
# WebTUI 规范纯度审计
pnpm test

# 运行全量核心测试套件（纯度审计 + 滚动算法 + 初始重绘 + 真实编辑 + 异常生命周期）
pnpm run test:all

# 浏览器端到端交互断言（需本地 Chrome/Chromium 环境）
node tests/test_browser_interaction.mjs
```

---

## 致谢与项目引用

- [WebTUI](https://webtui.ironclad.sh/) ([GitHub](https://github.com/ironclad/webtui))：提供 CSS 组件与声明式布局规范。
- [Neovim](https://neovim.io/)：文本编辑核心与 msgpack-RPC UI 协议。

---

## 许可证

[MIT License](LICENSE)
