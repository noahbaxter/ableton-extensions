# Clipify — Backlog

## Todo

- Fades into stripped silence — blocked: SDK 1.0.0 has no fade API
- Multi-clip time selections — only handles the clip under the selection start
- Nest context-menu items under a submenu — blocked: SDK menus are flat
- More clip tools — normalize, trim-to-content, dedupe takes, batch rename/recolor

## Done

- Slice & Strip popup — waveform preview, MACRO/MICRO modes, sensitivity slider
- Per-mode sensitivity — MACRO and MICRO each remember their own setting
- Strip silence — isolate noise-floor zones and deactivate or delete them
- Catch leading/trailing silence, not just gaps between sounds
- Breath-aware cuts — keep pre-note breath with the following note
- Zero-crossing snapping — cuts (and standalone Split at Nearest 0 Crossing)
- Persist popup settings across runs (storageDirectory)
- One grouped undo for splits + strip
- Warped-clip slicing, in-place splits (keep warp/fades/gain/pitch)
- Rename clip-tools → Clipify
