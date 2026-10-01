-- ==============================================================================
-- NVW • WebTUI x Catppuccin Studio Theme Engine
-- Native Colorscheme Loading (catppuccin-latte / catppuccin-mocha) • 100% Zero-Yellow
-- ==============================================================================

local function mode_label()
  local m = vim.fn.mode()
  if m == "n" then return " NORMAL "
  elseif m == "i" then return " INSERT "
  elseif m:find("v") or m:find("V") or m == "\22" then return " VISUAL "
  elseif m == "c" then return " COMMAND "
  elseif m == "t" then return " TERMINAL "
  else return " " .. m .. " " end
end

function _G.AilyreStatusline()
  local m = mode_label()
  local fname = vim.fn.expand("%:t")
  if fname == "" then fname = "[未命名]" end
  local mod = vim.bo.modified and " ●" or ""
  local ft = vim.bo.filetype ~= "" and (" " .. vim.bo.filetype .. " │") or ""
  local pos = string.format(" %d:%d ", vim.fn.line("."), vim.fn.col("."))
  local total = math.max(1, vim.fn.line("$"))
  local pct = string.format(" %d%%%% ", math.floor(vim.fn.line(".") / total * 100))
  return string.format("%%#StatusLineMode#%s%%#StatusLine# %s%s %%=%%#StatusLineInfo#%s%s%s", m, fname, mod, ft, pos, pct)
end

-- WebTUI 主题 → Neovim colorscheme 映射表 (与浏览器 data-webtui-theme 完全同步)
local THEME_MAP = {
  ["catppuccin-mocha"]  = "catppuccin-mocha",
  ["catppuccin-latte"]  = "catppuccin-latte",
  ["nord"]              = "nord",
  ["gruvbox"]           = "gruvbox-dark",
  ["gruvbox-dark"]      = "gruvbox-dark",
  ["everforest"]        = "everforest-dark",
  ["everforest-dark"]   = "everforest-dark",
  ["vitesse-dark"]      = "vitesse-dark",
  ["vitesse"]           = "vitesse-dark",
  ["osmium"]            = "osmium",
  -- 兼容旧的 light / dark 二元指令
  ["light"]             = "catppuccin-latte",
  ["dark"]              = "catppuccin-mocha",
}

local function apply_ailyre(mode)
  local scheme = THEME_MAP[mode] or "catppuccin-mocha"
  pcall(vim.cmd, "colorscheme " .. scheme)
  vim.cmd("redraw!")
end

-- 全局用户命令：外部可随时下发 :AilyreTheme <webtui-theme-name>，自动重绘屏幕
vim.api.nvim_create_user_command("AilyreTheme", function(opts)
  apply_ailyre(opts.args)
end, { nargs = 1 })

-- 现代原生编辑器调优参数
vim.opt.termguicolors = true
vim.opt.mouse = "a"
vim.opt.fillchars = { eob = "~", vert = "│", horiz = "─", vertleft = "┤", vertright = "├", verthoriz = "┼" }
-- 关闭 cursorline（重要，别打开）。
-- 实测（nvim 0.12.5 + ext_linegrid，逐字符对比 nvim 自己的屏幕）：
--   cursorlineopt = "both"/"line" → :edit 后 29 行只推 4 行，整屏残留
--   cursorlineopt = "number"      → 只丢"光标行的行号"这一个格子（行 0 的 " 1" 不出来）
--   cursorline = false            → 打开/切换文件/长行换短行 全部 0 偏差
-- 代价只是少一条当前行高亮；光标位置由客户端的反色块光标表达，信息不丢。
vim.opt.cursorline = false
vim.opt.number = true
vim.opt.signcolumn = "yes"
vim.opt.scrolloff = 4
vim.opt.splitright = true
vim.opt.splitbelow = true
-- 不使用 nvim 自带的状态栏：app 侧已有自己的状态栏（模式/文件/位置/编码）。
-- 关掉后既去掉重复，也避开一个实测缺口：nvim 不会发送状态栏"模式段"那几个格子
-- （文字没变、只有高亮变了的格子不发），开着会看到状态栏左边缺一块。
vim.opt.laststatus = 0
-- 关掉命令行区域的 ruler/showcmd：它们是状态栏信息的重复，且会占着最后一行
vim.opt.ruler = false
vim.opt.showcmd = false
vim.opt.clipboard = "unnamedplus"
vim.opt.statusline = "%!v:lua.AilyreStatusline()"

-- 智能关闭处理：当只有一个标签页执行 :q, :wq, :q! 时，保持会话平滑切为空白文档而不是断开会话
local function close_or_enew(save, force)
  if save then
    local ok, err = pcall(vim.cmd, "write")
    if not ok then
      vim.api.nvim_err_writeln(err)
      return
    end
  end

  local cur_buf = vim.api.nvim_get_current_buf()
  local bufs = vim.fn.getbufinfo({ buflisted = 1 })

  if #bufs <= 1 then
    vim.cmd("enew")
    if force then
      pcall(vim.cmd, "bdelete! " .. cur_buf)
    else
      pcall(vim.cmd, "bdelete " .. cur_buf)
    end
  else
    if force then
      pcall(vim.cmd, "bdelete! " .. cur_buf)
    else
      local ok, err = pcall(vim.cmd, "bdelete " .. cur_buf)
      if not ok then
        vim.api.nvim_err_writeln(err)
      end
    end
  end
end

vim.api.nvim_create_user_command("SmartQ", function(opts)
  close_or_enew(false, opts.bang)
end, { bang = true })

vim.api.nvim_create_user_command("SmartWQ", function(opts)
  close_or_enew(true, opts.bang)
end, { bang = true })

vim.cmd([[
  cnoreabbrev <expr> q (getcmdtype() == ':' && getcmdline() == 'q' ? 'SmartQ' : 'q')
  cnoreabbrev <expr> q! (getcmdtype() == ':' && getcmdline() == 'q!' ? 'SmartQ!' : 'q!')
  cnoreabbrev <expr> wq (getcmdtype() == ':' && getcmdline() == 'wq' ? 'SmartWQ' : 'wq')
  cnoreabbrev <expr> wq! (getcmdtype() == ':' && getcmdline() == 'wq!' ? 'SmartWQ!' : 'wq!')
]])

-- 默认加载由环境变量 NVW_INITIAL_THEME 传入的主题，或 fallback 到 catppuccin-mocha
local initial_theme = os.getenv("NVW_INITIAL_THEME") or "catppuccin-mocha"
apply_ailyre(initial_theme)
