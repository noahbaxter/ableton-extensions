# Clipify

An Ableton Live 12 extension for chopping audio takes. Right-click an arrangement
audio clip (or a time selection on an audio track) → **Clipify…** to open a popup
that previews the cuts over a waveform and splits the clip at the quiet gaps —
for turning a vocal take into individually-editable pieces.

## Slice & Strip popup

- **MODE** — **MACRO** separates groups of sound with real silence between them
  (phrase level); **MICRO** separates individual audio events (word/transient
  level). Each mode keeps its own **Sensitivity**; the slider swaps between them.
- **STRIP SILENCE** — **Off** just slices; **Deactivate** / **Delete** also isolate
  the noise-floor stretches (including leading/trailing silence) and mute or remove
  them. The **Silence** slider grows each stripped zone from the dead-quiet middle
  out to the full gap.
- Cuts keep a note's decay tail with that note and the pre-note breath with the
  *following* note, and snap to the nearest zero crossing so splits don't click.
- Controls persist across runs (`clipify-settings.json` in the storage directory).

A standalone **Split at Nearest 0 Crossing** acts on the cursor (no time range).

## How it works

Each cut is an in-place split (`clearClipsInRange(t, t)`), so every piece keeps the
original clip's warp, fades, gain, and pitch. Heavy DSP runs once in the extension;
the popup does the interactive selection; then the splits and strip apply as one
grouped undo.

```
silence.ts     PCM         ──▶ sound segments + RMS   (amplitude detection)
candidates.ts  segments    ──▶ cut candidates         (gaps, deep-silence extent, zero-cross snap)
envelope.ts    PCM         ──▶ waveform peaks          (popup canvas)
mapping.ts     file-second ──▶ arrangement beat        (warp curve, or constant rate)
popup.html     candidates  ──▶ chosen cuts + strips    (mode / sensitivity / strip — interactive)
slicer.ts      orchestrates decode → popup → apply
```

`extension.ts` registers the right-click commands; `settings.ts` persists the popup
state; `debug.ts` holds the gated evaluation logging.

## Build & run

Needs Node ≥ 24.14.1 (the script finds one).

```sh
./build.sh run      # build + launch in Live's Extension Host (dev mode)
./build.sh dev      # dev bundle only
./build.sh          # production .ablx in dist/
```

Live 12 Beta must be running with Developer Mode on; Ctrl-C and re-run per change.
`run` does a warm-up launch first to work around Live's cold-start handshake (which
otherwise needs two runs), and passes a `.clipify-dev/` storage directory so
settings persist in dev.

## Tuning

- `DETECT_PARAMS` (`silence.ts`) — detection thresholds and gates.
- `DEEP_MARGIN_DB` (`candidates.ts`) — how close to the noise floor counts as silence.
- threshold mappings in `popup.html` (`thresholdFor`) — per-mode sensitivity curves.
- `debug` (`debug.ts`) — `new Debug(true)` → `false` to silence logging.

## Known limitation

On clips with heavy non-linear warp, cut *positions* are approximate: the
file-second → beat mapping interpolates the clip's warp markers, which Live reports
for only part of the clip.
