// Strip edge placement: nudge a strip region's inner edge along the event's own
// attack/release envelope. Two engines (Level, Time) compared behind one bipolar knob.
// Pure DSP over detection rms[]; amount 0 = the detected boundary (no change).

export type EdgeMode = "level" | "time";

export interface EdgeCtx {
  rms: number[]; // detection per-window RMS, decoded-buffer indexing
  windowDur: number; // seconds per window
  quietThresh: number; // linear level of the "quiet" boundary
  silenceThresh: number; // linear level of the "silence" boundary
  noiseFloor: number; // linear floor
}

export interface EdgeParams {
  mode: EdgeMode;
  amount: number; // -1..+1, 0 = center. + = tighten (into sound), - = loosen (toward floor)
  clampMs: number; // 0 = off; Level mode only, caps travel
}

// Both are starting points to tune by feel in Live, not load-bearing.
const LEVEL_MAX_DB = 18; // amount ±1 -> ±18 dB offset from the boundary
const TIME_REF_DB = 12; // attack/release span = boundary -> floor + this dB

const clampIdx = (i: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, i));

// soundDir: +1 if the adjacent sound is to the RIGHT of the boundary (end edge / next
// attack), -1 if to the LEFT (start edge / prev release). boundaryLevel is the linear
// level the boundary sits on (the active detection threshold). Returns edge in seconds.
export function placeEdge(
  boundarySec: number,
  soundDir: 1 | -1,
  boundaryLevel: number,
  ctx: EdgeCtx,
  p: EdgeParams,
): number {
  if (p.amount === 0) return boundarySec;
  const raw =
    p.mode === "level"
      ? walkLevel(boundarySec, soundDir, boundaryLevel, ctx, p)
      : walkTime(boundarySec, soundDir, ctx, p);
  // keep the edge inside the decoded window. walkLevel is already index-clamped, but
  // walkTime scales a span by the amount and can overshoot past 0 or the window end.
  const maxSec = ctx.rms.length * ctx.windowDur;
  return Math.max(0, Math.min(maxSec, raw));
}

function walkLevel(
  boundarySec: number,
  soundDir: 1 | -1,
  boundaryLevel: number,
  ctx: EdgeCtx,
  p: EdgeParams,
): number {
  const { rms, windowDur } = ctx;
  const n = rms.length;
  if (n === 0) return boundarySec;
  const target = boundaryLevel * Math.pow(10, (p.amount * LEVEL_MAX_DB) / 20);
  let i = clampIdx(Math.round(boundarySec / windowDur), 0, n - 1);
  // tighten (amount>0): step toward the sound until the envelope reaches the higher target.
  // loosen (amount<0): step away from the sound until the envelope falls to the lower target.
  const step = (p.amount > 0 ? soundDir : -soundDir) as 1 | -1;
  if (p.amount > 0) {
    while (i + step >= 0 && i + step < n && (rms[i] ?? Infinity) < target) i += step;
  } else {
    while (i + step >= 0 && i + step < n && (rms[i] ?? 0) > target) i += step;
  }
  let edge = i * windowDur;
  if (p.clampMs > 0) {
    const cap = p.clampMs / 1000;
    edge = Math.max(boundarySec - cap, Math.min(boundarySec + cap, edge));
  }
  return edge;
}

function walkTime(boundarySec: number, soundDir: 1 | -1, ctx: EdgeCtx, p: EdgeParams): number {
  const { rms, windowDur, noiseFloor } = ctx;
  const n = rms.length;
  if (n === 0) return boundarySec;
  const refLevel = noiseFloor * Math.pow(10, TIME_REF_DB / 20);
  let i = clampIdx(Math.round(boundarySec / windowDur), 0, n - 1);
  let spanWin = 0;
  while (i + soundDir >= 0 && i + soundDir < n && (rms[i] ?? Infinity) < refLevel) {
    i += soundDir;
    spanWin++;
  }
  const span = spanWin * windowDur;
  return boundarySec + p.amount * span * soundDir;
}
