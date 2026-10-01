-- Vitesse Dark for Neovim (WebTUI official palette)
local ok, builder = pcall(require, "nvw_theme_builder")
if not ok then return end
builder.apply("vitesse-dark", "dark", {
  bg = "#121212", bg_alt = "#0e0e0e", bg_soft = "#2f363d",
  surface = "#2f363d", surface_bright = "#393a34", line = "#444d56",
  fg = "#dbd7ca", fg_dim = "#c9c8c0", fg_faint = "#b8bab7", comment = "#758575",
  red = "#cb7676", green = "#4d9375", yellow = "#e6cc77",
  blue = "#6394bf", magenta = "#d9739f", cyan = "#5eaab5",
  orange = "#d4976c", accent = "#4d9375",
})
