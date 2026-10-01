-- Catppuccin Latte for Neovim (Official Light Palette)
vim.cmd("highlight clear")
if vim.fn.exists("syntax_on") == 1 then
  vim.cmd("syntax reset")
end
vim.g.colors_name = "catppuccin-latte"
vim.opt.background = "light"

local c = {
  rosewater = "#dc8a78",
  flamingo = "#dd7878",
  pink = "#ea76cb",
  mauve = "#8839ef",
  red = "#d20f39",
  maroon = "#e64553",
  peach = "#fe640b",
  yellow = "#df8e1d",
  green = "#40a02b",
  teal = "#179299",
  sky = "#04a5e5",
  sapphire = "#209fb5",
  blue = "#1e66f5",
  lavender = "#7287fd",
  text = "#4c4f69",
  subtext1 = "#5c5f77",
  subtext0 = "#6c6f85",
  overlay2 = "#7c7f93",
  overlay1 = "#8c8fa1",
  overlay0 = "#9ca0b0",
  surface2 = "#acb0be",
  surface1 = "#bcc0cc",
  surface0 = "#ccd0da",
  base = "#eff1f5",
  mantle = "#e6e9ef",
  crust = "#dce0e8",
}

-- Editor Base
vim.api.nvim_set_hl(0, "Normal", { fg = c.text, bg = c.base })
vim.api.nvim_set_hl(0, "NormalFloat", { fg = c.text, bg = c.mantle })
vim.api.nvim_set_hl(0, "FloatBorder", { fg = c.surface2, bg = c.mantle })
vim.api.nvim_set_hl(0, "SignColumn", { bg = c.base })
vim.api.nvim_set_hl(0, "LineNr", { fg = c.overlay0, bg = c.base })
vim.api.nvim_set_hl(0, "CursorLineNr", { fg = c.blue, bg = c.surface0, bold = true })
vim.api.nvim_set_hl(0, "CursorLine", { bg = c.surface0 })
vim.api.nvim_set_hl(0, "ColorColumn", { bg = c.surface0 })
vim.api.nvim_set_hl(0, "EndOfBuffer", { fg = c.surface1, bg = c.base })

-- Windows & Statusline
vim.api.nvim_set_hl(0, "StatusLine", { fg = c.text, bg = c.surface1, bold = true })
vim.api.nvim_set_hl(0, "StatusLineNC", { fg = c.overlay0, bg = c.mantle })
vim.api.nvim_set_hl(0, "StatusLineMode", { fg = "#ffffff", bg = c.blue, bold = true })
vim.api.nvim_set_hl(0, "StatusLineInfo", { fg = c.subtext0, bg = c.surface1 })
vim.api.nvim_set_hl(0, "VertSplit", { fg = c.surface1, bg = c.base })
vim.api.nvim_set_hl(0, "WinSeparator", { fg = c.surface1, bg = c.base })
vim.api.nvim_set_hl(0, "TabLine", { fg = c.overlay0, bg = c.mantle })
vim.api.nvim_set_hl(0, "TabLineSel", { fg = c.blue, bg = c.surface0, bold = true })
vim.api.nvim_set_hl(0, "TabLineFill", { bg = c.mantle })

-- Menus & Selection
vim.api.nvim_set_hl(0, "Pmenu", { fg = c.text, bg = c.mantle })
vim.api.nvim_set_hl(0, "PmenuSel", { fg = "#ffffff", bg = c.blue, bold = true })
vim.api.nvim_set_hl(0, "PmenuSbar", { bg = c.surface0 })
vim.api.nvim_set_hl(0, "PmenuThumb", { bg = c.overlay0 })
vim.api.nvim_set_hl(0, "Visual", { bg = c.surface1 })
vim.api.nvim_set_hl(0, "Search", { fg = c.base, bg = c.sapphire })
vim.api.nvim_set_hl(0, "IncSearch", { fg = "#ffffff", bg = c.blue })

-- Syntax Highlights (Catppuccin Palette)
vim.api.nvim_set_hl(0, "Statement", { fg = c.mauve, bold = true })
vim.api.nvim_set_hl(0, "Keyword", { fg = c.mauve, bold = true })
vim.api.nvim_set_hl(0, "Conditional", { fg = c.mauve, bold = true })
vim.api.nvim_set_hl(0, "Repeat", { fg = c.mauve, bold = true })
vim.api.nvim_set_hl(0, "Label", { fg = c.sapphire })
vim.api.nvim_set_hl(0, "Operator", { fg = c.sky })
vim.api.nvim_set_hl(0, "Exception", { fg = c.mauve, bold = true })
vim.api.nvim_set_hl(0, "Function", { fg = c.blue, bold = true })
vim.api.nvim_set_hl(0, "Identifier", { fg = c.text })
vim.api.nvim_set_hl(0, "String", { fg = c.green })
vim.api.nvim_set_hl(0, "Character", { fg = c.teal })
vim.api.nvim_set_hl(0, "Number", { fg = c.peach })
vim.api.nvim_set_hl(0, "Boolean", { fg = c.peach, bold = true })
vim.api.nvim_set_hl(0, "Constant", { fg = c.peach })
vim.api.nvim_set_hl(0, "Type", { fg = c.teal })
vim.api.nvim_set_hl(0, "PreProc", { fg = c.pink })
vim.api.nvim_set_hl(0, "Special", { fg = c.pink })
vim.api.nvim_set_hl(0, "Comment", { fg = c.overlay1, italic = true })
vim.api.nvim_set_hl(0, "Error", { fg = c.red, bold = true })
vim.api.nvim_set_hl(0, "Todo", { fg = "#ffffff", bg = c.lavender, bold = true })

-- Treesitter Links
vim.api.nvim_set_hl(0, "@keyword", { fg = c.mauve, bold = true })
vim.api.nvim_set_hl(0, "@function", { fg = c.blue, bold = true })
vim.api.nvim_set_hl(0, "@string", { fg = c.green })
vim.api.nvim_set_hl(0, "@comment", { fg = c.overlay1, italic = true })
vim.api.nvim_set_hl(0, "@type", { fg = c.teal })
vim.api.nvim_set_hl(0, "@variable", { fg = c.text })
vim.api.nvim_set_hl(0, "@constant", { fg = c.peach })
