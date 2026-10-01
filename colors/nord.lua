-- Nord for Neovim (WebTUI official palette)
local ok, builder = pcall(require, "nvw_theme_builder")
if not ok then return end
builder.apply("nord", "dark", {
  bg = "#2e3440", bg_alt = "#292e39", bg_soft = "#3b4252",
  surface = "#3b4252", surface_bright = "#434c5e", line = "#4c566a",
  fg = "#eceff4", fg_dim = "#e5e9f0", fg_faint = "#d8dee9", comment = "#4c566a",
  red = "#bf616a", green = "#a3be8c", yellow = "#ebcb8b",
  blue = "#81a1c1", magenta = "#b48ead", cyan = "#88c0d0",
  orange = "#d08770", accent = "#88c0d0",
})
