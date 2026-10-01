# NVW (Neovim Web)

NVW 是一个运行在浏览器里的本地 Neovim 工作台，基于 [WebTUI](https://webtui.ironclad.sh/) 规范构建，直接连接本机的 Neovim 进程。

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
- 中文输入法（IME）合成事件分发，避免字符重复或漏字。
- 支持 `:terminal` 终端缓冲区与命令交互。
- 弹出式代码补全菜单与选项插入。
- 自动根据容器与基础字号适配行列数，支持桌面与移动端视口。
- 内置 Catppuccin（Mocha / Latte）、Nord、Gruvbox、Everforest、Vitesse 等配色。
- 服务端维护权威网格状态镜像，刷新页面或重连时下发完整快照。

---

## 环境要求

- Node.js (>= 18.0.0)
- Neovim (>= 0.9.0，建议 0.10+)
- pnpm (推荐) 或 npm

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

## 测试

```bash
# WebTUI 规范纯度审计
pnpm test

# Neovim 核心编辑功能测试（写盘、撤销、宏、分屏、浮窗、终端、补全）
node tests/test_e05_editing.mjs

# 浏览器端到端交互断言（IME、终端输出、补全落盘、状态保持）
node tests/test_browser_interaction.mjs
```

---

## 致谢与项目引用

- [WebTUI](https://webtui.ironclad.sh/) ([GitHub](https://github.com/ironclad/webtui))：提供 CSS 组件与声明式布局规范。
- [Neovim](https://neovim.io/)：文本编辑核心与 msgpack-RPC UI 协议。

---

## 许可证

[MIT License](LICENSE)
