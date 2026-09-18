# I am submitting a new Community Plugin

## Repo URL
https://github.com/mannaa04/canvas-smooth-linker

## Release Checklist
- [x] I have tested the plugin on a Windows desktop with Obsidian 1.13.7.
- [x] The release tag matches `version` in `manifest.json` (1.3.0), and the release includes `main.js`, `manifest.json` and `styles.css`.
- [x] The plugin is not obfuscated: `main.ts`, `esbuild.config.mjs` and `tsconfig.json` are in the repo, and `main.js` is built from source by CI.
- [x] No network requests, no telemetry, no `innerHTML`; nothing leaves the vault.

## What the plugin does
Turns internal links inside Canvas cards into PowerPoint-style hyperlinks: clicking
`[[MyCanvas.canvas#nodeId|label]]` smoothly pans and zooms the canvas viewport (~350 ms, easeInOutQuad,
scale 1.2) to center the target node, in the same tab and without entering edit mode.

Also included: a hierarchical right-click menu for link text (color / size / bold / italic / underline),
a floating style panel with color swatches, HEX input, saved custom colors and a font-size slider
(styles are written into the link alias so they travel with the file and support Ctrl+Z), "Copy card
link" in the node context menu, Markdown/math rendering inside link labels, and suppression of note
hover previews on canvas links. Everything is toggleable in settings.

## Notes for reviewers
- Canvas exposes no public API for its viewport or its node context menus, so the plugin uses the
  internal `setViewport()` and the node `showMenu()` extension point. Both are always behind feature
  detection with a fallback chain (`setViewport` -> direct field write -> `panTo` -> DOM transform)
  plus a runtime self-correction pass; if none is available the plugin does nothing and never throws.
- Viewport math was verified against Obsidian 1.13.7 by reading its Canvas implementation directly.
  The repo ships a regression suite (`npm test`, 68 assertions across four version conventions) and the
  built `main.js` was additionally smoke-tested by loading it against a stubbed Obsidian API.
- All DOM listeners go through `registerDomEvent` / `registerEvent` and are removed on unload;
  observers and child components are released when cards leave the DOM.
