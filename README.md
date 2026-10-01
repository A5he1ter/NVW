# NVW (Neovim Web)

> 纯净、极简的本地 Neovim Web 工作台。采用 [WebTUI](https://webtui.ironclad.sh/) 官方规范构建，直连本机 Neovim 实例。

---

## 特性

- **真实 Neovim 驱动**：使用 `nvim --embed` 常驻 msgpack-RPC 链路直连本机 Neovim，加载本地配置与插件，以 Neovim 作为文本状态权威来源。
- **WebTUI 原生视觉**：界面严格遵循 WebTUI 官方组件与框线契约，零自写杂乱样式，保持终端美学。
- **行级 DOM 网格渲染**：摒弃传统 VT 终端模拟器与 Canvas 后端，采用高清晰度的行级 DOM 增量更新与 CSS 字符度量单位，原生清晰、低延迟。
- **协议完整消费**：完整解析 Neovim UI 事件流（`grid_line`、`grid_scroll`、`hl_attr_define`、`default_colors_set` 等），按 `flush` 边界稳定提交，避免闪烁与重叠。
- **真实工作区切换**：支持结构化全局与局部窗口工作目录同步，集成未保存修改弹窗防护。
- **现代编辑器交互**：支持分屏、浮窗、内置终端（`:terminal`）、补全菜单、中文输入法（IME）及多套官方主题。

---

## 快速开始

### 依赖环境

- [Node.js](https://nodejs.org/) (>= 18.0.0)
- [Neovim](https://neovim.io/) (>= 0.9.0，推荐 0.10+)
- [pnpm](https://pnpm.io/) (推荐) 或 npm

### 安装

```bash
# 克隆仓库
git clone https://github.com/<你的用户名>/NVW.git
cd NVW

# 安装依赖
pnpm install
```

### 启动服务

```bash
# 启动本地服务（默认端口 3999）
pnpm start
```

服务就绪后，在浏览器中打开：
```
http://127.0.0.1:3999
```

也可以通过 CLI 快速启动与指定工作区：
```bash
# 全局链接或直接通过 bin 运行
./bin/nvw.js web /path/to/project
```

---

## 常用快捷键

| 快捷键 | 功能描述 |
| :--- | :--- |
| `Mod + K` (⌘K / Ctrl+K) | 查找工作区文件 |
| `Mod + Shift + F` | 聚焦侧栏文件过滤框 |
| `Mod + B` | 切换专注模式 (Zen Mode) |
| `Mod + ,` | 打开设置选项 |
| `Mod + /` | 查看快捷键速查表 |
| `Mod + S` | 保存当前缓冲区 (`:write`) |
| `Alt + W` | 关闭当前缓冲区（带未保存守护确认） |
| `Alt + ↑` / `Alt + ↓` | 切换上一/下一缓冲区 |
| `Mod + J` | 焦点快速回到 Neovim 编辑网格 |
| `Esc` | 关闭当前模态弹窗 / 退出专注模式 |

---

## 架构概览

```
浏览器客户端 (DOM Grid) ◄── WebSocket (JSON) ──► 本地 Node.js 进程 (GridState) ◄── msgpack-rpc ──► 本机 Neovim (nvim --embed)
```

1. **服务端**：管理 Neovim 子进程生命周期、RPC 通信协议与权威网格快照镜像。
2. **渲染器**：精确维护单元格属性、高亮样式表与光标形态，每帧仅针对改动脏行做 DOM patch。
3. **输入层**：语义化按键、修饰键组合、粘贴与 IME 独立分发。

---

## 检验与测试

```bash
# 运行 WebTUI 规范纯度静态审计
pnpm test
```

---

## 开源许可

[ISC License](package.json)
