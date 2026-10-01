-- Gruvbox Dark for Neovim (WebTUI official palette)
local ok, builder = pcall(require, "nvw_theme_builder")
if not ok then return end
builder.apply("gruvbox-dark", "dark", {
  bg = "#282828", bg_alt = "#1d2021", bg_soft = "#32302f",
  surface = "#3c3836", surface_bright = "#504945", line = "#665c54",
  fg = "#ebdbb2", fg_dim = "#d5c4a1", fg_faint = "#bdae93", comment = "#928374",
  red = "#fb4934", green = "#b8bb26", yellow = "#fabd2f",
  blue = "#83a598", magenta = "#d3869b", cyan = "#8ec07c",
  orange = "#fe8019", accent = "#fabd2f",
})
