-- ==============================================================================
-- NVW • Shared WebTUI Colorscheme Builder
-- Maps a WebTUI palette table to Neovim highlight groups so the native Neovim
-- colors stay 100% in sync with the browser WebTUI theme.
-- ==============================================================================

local M = {}

-- palette keys expected:
--   bg, bg_alt, bg_soft, surface, surface_bright, line
--   fg, fg_dim, fg_faint, comment
--   red, green, yellow, blue, magenta, cyan, orange, accent
function M.apply(name, background, p)
  vim.cmd("highlight clear")
  if vim.fn.exists("syntax_on") == 1 then
    vim.cmd("syntax reset")
  end
  vim.g.colors_name = name
  vim.opt.background = background

  local function hl(group, opts)
    vim.api.nvim_set_hl(0, group, opts)
  end

  -- Editor base
  hl("Normal", { fg = p.fg, bg = p.bg })
  hl("NormalFloat", { fg = p.fg, bg = p.bg_alt })
  hl("FloatBorder", { fg = p.surface, bg = p.bg_alt })
  hl("SignColumn", { bg = p.bg })
  hl("LineNr", { fg = p.surface_bright, bg = p.bg })
  hl("CursorLineNr", { fg = p.accent, bg = p.surface, bold = true })
  hl("CursorLine", { bg = p.surface })
  hl("ColorColumn", { bg = p.surface })
  hl("EndOfBuffer", { fg = p.line, bg = p.bg })
  hl("NonText", { fg = p.line })
  hl("Whitespace", { fg = p.line })

  -- Windows & statusline
  hl("StatusLine", { fg = p.fg, bg = p.surface, bold = true })
  hl("StatusLineNC", { fg = p.comment, bg = p.bg_alt })
  hl("StatusLineMode", { fg = p.bg, bg = p.accent, bold = true })
  hl("StatusLineInfo", { fg = p.fg_dim, bg = p.surface })
  hl("VertSplit", { fg = p.surface, bg = p.bg })
  hl("WinSeparator", { fg = p.surface, bg = p.bg })
  hl("TabLine", { fg = p.comment, bg = p.bg_alt })
  hl("TabLineSel", { fg = p.accent, bg = p.surface, bold = true })
  hl("TabLineFill", { bg = p.bg_alt })

  -- Menus & selection
  hl("Pmenu", { fg = p.fg, bg = p.bg_alt })
  hl("PmenuSel", { fg = p.bg, bg = p.accent, bold = true })
  hl("PmenuSbar", { bg = p.surface })
  hl("PmenuThumb", { bg = p.comment })
  hl("Visual", { bg = p.surface_bright })
  hl("Search", { fg = p.bg, bg = p.cyan })
  hl("IncSearch", { fg = p.bg, bg = p.accent })
  hl("MatchParen", { fg = p.accent, bold = true })

  -- Diagnostics
  hl("DiagnosticError", { fg = p.red })
  hl("DiagnosticWarn", { fg = p.yellow })
  hl("DiagnosticInfo", { fg = p.blue })
  hl("DiagnosticHint", { fg = p.cyan })

  -- Syntax
  hl("Statement", { fg = p.magenta, bold = true })
  hl("Keyword", { fg = p.magenta, bold = true })
  hl("Conditional", { fg = p.magenta, bold = true })
  hl("Repeat", { fg = p.magenta, bold = true })
  hl("Label", { fg = p.blue })
  hl("Operator", { fg = p.cyan })
  hl("Exception", { fg = p.magenta, bold = true })
  hl("Function", { fg = p.blue, bold = true })
  hl("Identifier", { fg = p.fg })
  hl("String", { fg = p.green })
  hl("Character", { fg = p.cyan })
  hl("Number", { fg = p.orange })
  hl("Boolean", { fg = p.orange, bold = true })
  hl("Constant", { fg = p.orange })
  hl("Type", { fg = p.yellow })
  hl("PreProc", { fg = p.magenta })
  hl("Special", { fg = p.magenta })
  hl("Comment", { fg = p.comment, italic = true })
  hl("Error", { fg = p.red, bold = true })
  hl("Todo", { fg = p.bg, bg = p.accent, bold = true })

  -- Treesitter
  hl("@keyword", { fg = p.magenta, bold = true })
  hl("@function", { fg = p.blue, bold = true })
  hl("@function.call", { fg = p.blue })
  hl("@string", { fg = p.green })
  hl("@comment", { fg = p.comment, italic = true })
  hl("@type", { fg = p.yellow })
  hl("@variable", { fg = p.fg })
  hl("@constant", { fg = p.orange })
  hl("@number", { fg = p.orange })
  hl("@boolean", { fg = p.orange })
  hl("@operator", { fg = p.cyan })
  hl("@punctuation.bracket", { fg = p.fg_dim })
  hl("@punctuation.delimiter", { fg = p.fg_dim })
end

return M
