// Turn detected gaps into cut candidates the popup can select from.
//
// For each gap between two sound segments we precompute:
//   - how long it is and how deep it goes (the popup ranks on these),
//   - whether it contains a real noise-floor stretch (so it can be stripped),
//   - the slice point, the deep-silence extent, and the full gap bounds — in BOTH
//     window fractions (for the canvas) and arrangement beats (for applying).
//
// The popup's silence-sensitivity slider grows the strip region from the deep
// extent (just the dead-quiet middle) out toward the full gap (right up to the
// neighbouring notes), so it lives between the deep and gap bounds we hand it.
//
// Cut placement keeps a note's decay tail with that note and the pre-note
// breath/noise with the FOLLOWING note: the slice sits at the start of the deep
// silence, so everything after it — the silence and the inhale before the next
// transient — rides forward.

import type { Detection } from "./silence.js";
import { snapToZeroCrossing } from "./zeroCross.js";

const DEEP_MARGIN_DB = 9; // RMS within this of the noise floor counts as true silence
const MIN_DEEP_SEC = 0.03; // a deep stretch shorter than this isn't worth stripping

export interface Candidate {
  durSec: number; // gap length
  hasDeep: boolean; // gap holds a real noise-floor stretch (strippable)
  edge: boolean; // leading/trailing silence (window edge) — stripped, never plain-sliced
  // window fractions [0,1]
  cutFrac: number; // slice point = start of the deep silence
  deepEndFrac: number; // end of the deep silence
  gapStartFrac: number; // gap start = previous note's edge
  gapEndFrac: number; // gap end = next note's edge
  // arrangement beats
  cutBeat: number;
  deepEndBeat: number;
  gapStartBeat: number;
  gapEndBeat: number;
}

interface Window {
  startSec: number; // file-second of the operating window start
  endSec: number; // file-second of the operating window end
  secToArrBeat: (s: number) => number;
  channels: Float32Array[]; // PCM, for zero-crossing snapping
  sampleRate: number;
}

// extent of the silence inside a gap: first..last window at/below `thresh`.
// Unlike a longest-contiguous-run, this tolerates brief blips (a click, a stray
// breath) so the whole quiet span is treated as one region instead of slivers.
function deepExtent(
  rms: number[],
  windowDur: number,
  gapStart: number,
  gapEnd: number,
  thresh: number,
): { start: number; end: number } | null {
  const i0 = Math.max(0, Math.floor(gapStart / windowDur));
  const i1 = Math.min(rms.length, Math.ceil(gapEnd / windowDur));
  let first = -1;
  let last = -1;
  for (let i = i0; i < i1; i++) {
    if ((rms[i] ?? Infinity) <= thresh) {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) return null;
  return { start: first * windowDur, end: (last + 1) * windowDur };
}

export function buildCandidates(detection: Detection, win: Window): Candidate[] {
  const { segments, rms, windowDur, noiseFloor } = detection;
  if (segments.length <= 1) return [];

  const span = win.endSec - win.startSec || 1;
  const frac = (s: number) => (s - win.startSec) / span;
  const snap = (s: number) => snapToZeroCrossing(win.channels, win.sampleRate, s);
  const deepThresh = noiseFloor * Math.pow(10, DEEP_MARGIN_DB / 20);

  // sound segments clipped to the operating window
  const segs = segments
    .map((s) => ({ start: Math.max(s.start, win.startSec), end: Math.min(s.end, win.endSec) }))
    .filter((s) => s.end - s.start > 0);
  if (!segs.length) return [];

  // gaps to consider: leading silence (window → first sound), the gaps between
  // sounds, and trailing silence (last sound → window). The edge gaps are how we
  // catch silence at the very start and end, not just between cut points.
  const gaps: { start: number; end: number; edge: boolean }[] = [];
  if (segs[0]!.start - win.startSec >= MIN_DEEP_SEC) {
    gaps.push({ start: win.startSec, end: segs[0]!.start, edge: true });
  }
  for (let i = 0; i < segs.length - 1; i++) {
    gaps.push({ start: segs[i]!.end, end: segs[i + 1]!.start, edge: false });
  }
  const lastSeg = segs[segs.length - 1]!;
  if (win.endSec - lastSeg.end >= MIN_DEEP_SEC) {
    gaps.push({ start: lastSeg.end, end: win.endSec, edge: true });
  }

  const out: Candidate[] = [];
  for (const gap of gaps) {
    const gapStart = gap.start;
    const gapEnd = gap.end;
    const durSec = gapEnd - gapStart;
    if (durSec <= 0) continue;

    const ext = deepExtent(rms, windowDur, gapStart, gapEnd, deepThresh);
    const hasDeep = !!ext && ext.end - ext.start >= MIN_DEEP_SEC;

    // slice at the start of the silence (keeps prev tail, gives breath to next note);
    // with no real silence (close events), fall back to the gap midpoint. Snap every
    // boundary to the nearest zero crossing so splits don't click.
    const cutSec = snap(hasDeep ? ext!.start : (gapStart + gapEnd) / 2);
    const deepEndSec = hasDeep ? snap(ext!.end) : cutSec;
    const gapStartSec = snap(gapStart);
    const gapEndSec = snap(gapEnd);

    // a normal slice must land inside the window; edge gaps own the window border
    if (!gap.edge && (cutSec <= win.startSec || cutSec >= win.endSec)) continue;

    out.push({
      durSec,
      hasDeep,
      edge: gap.edge,
      cutFrac: frac(cutSec),
      deepEndFrac: frac(deepEndSec),
      gapStartFrac: frac(gapStartSec),
      gapEndFrac: frac(gapEndSec),
      cutBeat: win.secToArrBeat(cutSec),
      deepEndBeat: win.secToArrBeat(deepEndSec),
      gapStartBeat: win.secToArrBeat(gapStartSec),
      gapEndBeat: win.secToArrBeat(gapEndSec),
    });
  }
  return out;
}
