# Cut-point detection strategy

How "SLICE AT GAPS" decides where to cut. Two independent axes: **detection**
(find every sound segment) and **grouping** (decide which gaps become cuts).
This is the part that works well — keep it. Placement/selection is separate and
is where the breakage came from (see "Deferred / hazards").

## Axis 1 — detection (amplitude): find ALL sound segments, finest grain

Pure DSP on decoded PCM (`silence.ts`), no SDK. Sensitivity-INDEPENDENT — every
slice detects the same word-level segments; grain only changes which gaps cut.

- Per-window RMS, `windowSize = 1024` samples (~23 ms @ 44.1 k).
- **Median-filter the RMS envelope** (`smoothingWindows = 3`). Kills lone loud
  spikes inside a gap that would otherwise split it into sub-threshold runs and
  make the gap disappear.
- **Adaptive threshold:** `max(noiseFloor * 10^(marginDb/20), absoluteFloor)`.
  - `noiseFloor` = 10th-percentile RMS — quiet relative to THIS recording.
  - `marginDb = 9` (~2.8×) above the floor.
  - `absoluteFloor = 0.025` (~-32 dBFS) — REQUIRED. On clean audio the noise
    floor is ~0, so the adaptive term alone lands near -70 dB and treats room
    tone / tails as sound → over-segmentation. The floor governs clean material;
    the adaptive term only takes over when the real floor is higher (noisy).
- Fine fixed gates so detection always reaches word level:
  `minSilenceDuration = 0.045 s`, `minSegmentDuration = 0.03 s`, `padding = 0.015 s`.

Output: sound segments (seconds) + the levels used (for logging).

## Axis 2 — grouping (time): which gaps become cuts

In `plan.ts`. The gap (silence duration) between two sounds tells you the
boundary level: big gaps = phrase boundaries, small gaps = word/syllable.

- Compute the gap duration between each pair of adjacent sounds.
- **Rank-based selection:** keep the largest `keepFraction` of gaps as cuts
  (cut at gap midpoints). Rank/percentile — NOT a duration threshold — because
  speech gaps are bimodal (long phrase gaps + short word gaps, little between),
  so a value threshold makes gentle/medium collapse together. Ranking guarantees
  the tiers stay separated by construction.
- Cut at the MIDDLE of each kept gap so every piece keeps its audio + padding and
  the timeline stays fully tiled in place. Nothing removed.

Grain presets (`keepFraction`, higher = more cuts; tune freely — counts depend on
the clip's own gap structure, not fixed numbers):

| Level      | keepFraction |
|------------|--------------|
| GENTLE     | 0.15         |
| MEDIUM     | 0.45         |
| AGGRESSIVE | 1.0          |

## Evaluation logging (`DEBUG` flag in extension.ts)

Enough to judge a slice without opening Live:
- `detect:` noise floor (dB), threshold (dB), #segments, #gaps.
- `cuts:` kept/total gaps, resulting pieces, full gap-duration list (desc) with
  `▸` marking which became cuts — shows WHY each grain cut where it did.
- `read-back:` intended→actual global-start, in-clip-start, end, duration per
  piece — proves placement/warp correctness.

## Placement — marker coordinate systems

`createAudioClip` takes `startMarker`/`endMarker` "in beats" but offers NO way to
set the new clip's warp markers, so the *grid* those beats live in is decided by
the new clip, not by us. Confirmed by reading back each created clip's
`warpMarkers`:

- **Markers are file-seconds (identity).** A new clip places its beat-0 warp
  marker at the FILE-SECOND equal to the `startMarker` value we pass (send
  `8.195` → warp marker lands at `8.195 s`). So `extension.ts` passes
  `secToMarker = identity` (marker == second), uses the clip's geometry
  (`arrSpan*secPerBeat / markerSpan`) only to bound the detection window, and
  scales arrangement by `markerToArrangement = 1/secPerBeat`. Sending the clip's
  native beats instead made Live read the too-large numbers as seconds past the
  file end → start-marker clamp + content stretch.

**Always create pieces UNWARPED**, then restore warp afterward for a warped
source. Creating with `isWarped: true` directly makes Live auto-warp the new
clip and snap the file to a "musical" length (observed `wm = (0,0)(21.943,32)`
→ 32 beats / 8 bars / 87.5 BPM for a 120 BPM file), which then reads our
second-markers as beats → content shifted. The unwarped create has no such
auto-warp, so it places content exactly.

The whole mapping is **linear** — one `secPerMarker` ratio for the window,
file-seconds as markers, constant `1/secPerBeat` for arrangement. That is exact
for a clip whose content plays at a constant rate:

- **Unwarped source — SOLVED.** Create unwarped; the new clips keep the file's
  tempo grid (read-back `wm` = 120 BPM) and the second-markers land correctly.

- **Warped source, no/linear warp — SOLVED.** Create the pieces unwarped
  (correct content), then set `clip.warping = true` on each created clip in a
  follow-up transaction. Enabling warp on an already-correct clip changes
  tempo-follow, not which sample region plays, so the new `wm` comes out at the
  file's real tempo, not the 87.5 auto-warp grid. Transparent at matching tempo;
  matters when the project tempo differs. (Costs +1 "Warped" undo per piece —
  property sets don't collapse in beta.0, same as the audio-clip creates.)

## Deferred / hazards (NOT done yet)

- **Non-linear warp (multiple warp markers) — BROKEN.** The linear mapping above
  assumes a constant content rate. A clip with real warp markers bends tempo
  *within* the clip, so file-second ↔ arrangement-beat is non-linear and the
  whole pipeline goes wrong: the detection window lands on the wrong file region,
  each cut's arrangement position/duration is computed at the wrong rate, and the
  warp-restore re-auto-warps linearly instead of reproducing the source curve.
  Fix path: drive the window and per-cut arrangement mapping through the real
  warp curve (`buildWarpMap` in `warp.ts`, retained for exactly this) — map each
  cut's file-second through warp → content-beat → arrangement-beat, rather than
  the constant ratio. Works today only for no-warp or a single linear warp.
- **Selection scope** (slice only the time selection, not the whole clip).
  Requires mapping an arrangement range into the clip's content-marker space.
- **Undo grouping.** `createAudioClip` cannot collapse into one undo step in SDK
  1.0.0-beta.0 (confirmed by Ableton; MIDI clips can, audio can't). A slice is
  N+1 undo steps until the SDK is fixed. Code already uses the documented form.

## Tuning knobs

- `DETECT_PARAMS` in `silence.ts` — detection.
- `GRAIN_LEVELS[].keepFraction` in `extension.ts` — grain.
- `DEBUG` in `extension.ts` — evaluation logging on/off.
