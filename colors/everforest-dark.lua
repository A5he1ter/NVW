-- Everforest Dark for Neovim (WebTUI official palette)
local ok, builder = pcall(require, "nvw_theme_builder")
if not ok then return end
builder.apply("everforest-dark", "dark", {
  bg = "#2d353b", bg_alt = "#232a2e", bg_soft = "#343f44",
  surface = "#343f44", surface_bright = "#3d484d", line = "#475258",
  fg = "#d3c6aa", fg_dim = "#9da9a0", fg_faint = "#859289", comment = "#7a8478",
  red = "#e67e80", green = "#a7c080", yellow = "#dbbc7f",
  blue = "#7fbbb3", magenta = "#d699b6", cyan = "#83c092",
  orange = "#e69875", accent = "#a7c080",
})
