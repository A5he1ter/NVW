-- Osmium for Neovim (WebTUI official palette)
local ok, builder = pcall(require, "nvw_theme_builder")
if not ok then return end
builder.apply("osmium", "dark", {
  bg = "#1f1d2d", bg_alt = "#14131e", bg_soft = "#242336",
  surface = "#242336", surface_bright = "#353553", line = "#494764",
  fg = "#c8d5f1", fg_dim = "#949bb9", fg_faint = "#747a9c", comment = "#747a9c",
  red = "#e55376", green = "#c9de96", yellow = "#e9d39c",
  blue = "#9abfe8", magenta = "#d9a1e8", cyan = "#9abfe8",
  orange = "#ebb17b", accent = "#9abfe8",
})
