-- Catppuccin Mocha for Neovim (Official Palette)
vim.cmd("highlight clear")
if vim.fn.exists("syntax_on") == 1 then
  vim.cmd("syntax reset")
end
vim.g.colors_name = "catppuccin-mocha"
vim.opt.background = "dark"

local c = {
  rosewater = "#f5e0dc",
  flamingo = "#f2cdcd",
  pink = "#f5c2e7",
  mauve = "#cba6f7",
  red = "#f38ba8",
  maroon = "#eba0ac",
  peach = "#fab387",
  yellow = "#f9e2af",
  green = "#a6e3a1",
  teal = "#94e2d5",
  sky = "#89dceb",
  sapphire = "#74c7ec",
  blue = "#89b4fa",
  lavender = "#b4befe",
  text = "#cdd6f4",
  subtext1 = "#bac2de",
  subtext0 = "#a6adc8",
  overlay2 = "#9399b2",
  overlay1 = "#7f849c",
  overlay0 = "#6c7086",
  surface2 = "#585b70",
  surface1 = "#45475a",
  surface0 = "#313244",
  base = "#1e1e2e",
  mantle = "#181825",
  crust = "#11111b",
}

-- Editor Base
vim.api.nvim_set_hl(0, "Normal", { fg = c.text, bg = c.base })
vim.api.nvim_set_hl(0, "NormalFloat", { fg = c.text, bg = c.mantle })
vim.api.nvim_set_hl(0, "FloatBorder", { fg = c.surface1, bg = c.mantle })
vim.api.nvim_set_hl(0, "SignColumn", { bg = c.base })
vim.api.nvim_set_hl(0, "LineNr", { fg = c.surface2, bg = c.base })
vim.api.nvim_set_hl(0, "CursorLineNr", { fg = c.lavender, bg = c.surface0, bold = true })
vim.api.nvim_set_hl(0, "CursorLine", { bg = c.surface0 })
vim.api.nvim_set_hl(0, "ColorColumn", { bg = c.surface0 })
vim.api.nvim_set_hl(0, "EndOfBuffer", { fg = c.surface1, bg = c.base })

-- Windows & Statusline
vim.api.nvim_set_hl(0, "StatusLine", { fg = c.text, bg = c.surface0, bold = true })
vim.api.nvim_set_hl(0, "StatusLineNC", { fg = c.overlay0, bg = c.mantle })
vim.api.nvim_set_hl(0, "StatusLineMode", { fg = c.crust, bg = c.blue, bold = true })
vim.api.nvim_set_hl(0, "StatusLineInfo", { fg = c.subtext0, bg = c.surface0 })
vim.api.nvim_set_hl(0, "VertSplit", { fg = c.surface0, bg = c.base })
vim.api.nvim_set_hl(0, "WinSeparator", { fg = c.surface0, bg = c.base })
vim.api.nvim_set_hl(0, "TabLine", { fg = c.overlay0, bg = c.mantle })
vim.api.nvim_set_hl(0, "TabLineSel", { fg = c.blue, bg = c.surface0, bold = true })
vim.api.nvim_set_hl(0, "TabLineFill", { bg = c.mantle })

-- Menus & Selection
vim.api.nvim_set_hl(0, "Pmenu", { fg = c.text, bg = c.mantle })
vim.api.nvim_set_hl(0, "PmenuSel", { fg = c.crust, bg = c.blue, bold = true })
vim.api.nvim_set_hl(0, "PmenuSbar", { bg = c.surface0 })
vim.api.nvim_set_hl(0, "PmenuThumb", { bg = c.overlay0 })
vim.api.nvim_set_hl(0, "Visual", { bg = c.surface1 })
vim.api.nvim_set_hl(0, "Search", { fg = c.crust, bg = c.sky })
vim.api.nvim_set_hl(0, "IncSearch", { fg = c.crust, bg = c.lavender })

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
vim.api.nvim_set_hl(0, "Type", { fg = c.yellow })
vim.api.nvim_set_hl(0, "PreProc", { fg = c.pink })
vim.api.nvim_set_hl(0, "Special", { fg = c.pink })
vim.api.nvim_set_hl(0, "Comment", { fg = c.overlay0, italic = true })
vim.api.nvim_set_hl(0, "Error", { fg = c.red, bold = true })
vim.api.nvim_set_hl(0, "Todo", { fg = c.crust, bg = c.lavender, bold = true })

-- Treesitter Links
vim.api.nvim_set_hl(0, "@keyword", { fg = c.mauve, bold = true })
vim.api.nvim_set_hl(0, "@function", { fg = c.blue, bold = true })
vim.api.nvim_set_hl(0, "@string", { fg = c.green })
vim.api.nvim_set_hl(0, "@comment", { fg = c.overlay0, italic = true })
vim.api.nvim_set_hl(0, "@type", { fg = c.yellow })
vim.api.nvim_set_hl(0, "@variable", { fg = c.text })
vim.api.nvim_set_hl(0, "@constant", { fg = c.peach })
