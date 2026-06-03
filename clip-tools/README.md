# Clip Tools

An Ableton Live 12 extension. Right-click an arrangement audio clip → **Slice at
Gaps** to split it into separate clips at the quiet gaps between phrases — for
chopping a vocal take into individually-editable pieces.

Three grain levels set how aggressively it cuts:

| Level      | Cuts                                |
|------------|-------------------------------------|
| Gentle     | largest ~15% of gaps (phrase level) |
| Medium     | larger ~45% of gaps (sub-phrase)    |
| Aggressive | every detected gap (word level)     |

## How it works

Each cut is an in-place split (`clearClipsInRange(t, t)`), so every piece keeps the
original clip's warp, fades, gain, and pitch.

`ClipSlicer` (`slicer.ts`) runs one slice over three pure transforms:

```
silence.ts   PCM         ──▶ sound segments      (amplitude detection)
plan.ts      segments    ──▶ cut points          (rank gaps by size, keepFraction)
warp.ts      file-second ──▶ arrangement beat    (warp curve, or constant rate)
```

`extension.ts` registers the right-click commands; `debug.ts` holds the gated
evaluation logging.

## Build & run

Needs Node ≥ 24.14.1 (the script finds one).

```sh
./build.sh run      # build + launch in Live's Extension Host (dev mode)
./build.sh dev      # dev bundle only
./build.sh          # production .ablx in dist/
```

Live 12 Beta must be running with Developer Mode on; Ctrl-C and re-run per change.

## Tuning

- `DETECT_PARAMS` (`silence.ts`) — detection thresholds and gates.
- `GRAIN_LEVELS` (`extension.ts`) — per-level `keepFraction`.
- `debug` (`debug.ts`) — `new Debug(true)` → `false` to silence logging.

## Known limitation

On clips with heavy non-linear warp, cut *positions* are approximate: the
file-second → beat mapping interpolates the clip's warp markers, which Live reports
for only part of the clip.
