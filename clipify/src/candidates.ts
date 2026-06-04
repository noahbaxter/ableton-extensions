// Turn detected gaps into cut candidates the popup/commands select from.
//
// For each gap between two sound segments we precompute its silence extent at two
// thresholds — QUIET (down to the noise floor) and SILENCE (true digital silence,
// ~-60 dB) — in both window fractions (canvas) and arrangement beats (applying).
// The active threshold drives BOTH the split cut and the strip region, so they stay
// locked together. CONTENT mode reuses the QUIET extents but strips the sound
// between them instead of the silence.
//
// Cut placement keeps a note's decay tail with that note and the pre-note
// breath/noise with the FOLLOWING note: the slice sits at the start of the deep
// silence, so everything after it rides forward.

import type { EdgeCtx } from "./edge.js";
import type { Detection } from "./silence.js";
import { segmentLevelDb } from "./silence.js";
import { snapToZeroCrossing } from "./zeroCross.js";

const QUIET_MARGIN_DB = 9; // RMS within this of the noise floor counts as "quiet"
export const SILENCE_LEVEL = Math.pow(10, -78 / 20); // ~-78 dBFS, digital silence; room tone passes
const MIN_DEEP_SEC = 0.03; // a deep stretch shorter than this isn't worth stripping

// silence extent at one threshold, resolved to fractions and beats
export interface Extent {
  hasDeep: boolean; // a real silence stretch exists at this threshold
  cutFrac: number; // silence start (slice point); midpoint when no silence
  deepEndFrac: number; // silence end
  cutBeat: number;
  deepEndBeat: number;
  // raw decoded-buffer seconds for the edge engine; optional only because hand-built
  // Extent literals in tests omit them. Always set on the real buildCandidates path.
  cutSec?: number;
  deepEndSec?: number;
}

// Everything select.ts needs to walk the envelope and convert a result back to
// canvas fractions / arrangement beats. Built once per window alongside the candidates.
export interface EdgeContext extends EdgeCtx {
  frac: (sec: number) => number;
  secToArrBeat: (sec: number) => number;
}

export interface Candidate {
  durSec: number; // gap length
  edge: boolean; // leading/trailing silence (window edge) — stripped, never plain-sliced
  gapStartFrac: number; // gap start = previous note's edge
  gapEndFrac: number; // gap end = next note's edge
  gapStartBeat: number;
  gapEndBeat: number;
  quiet: Extent; // noise-floor silence
  silence: Extent; // true digital silence
  prevLevelDb: number | null; // sound segment before this gap (null = window edge)
  nextLevelDb: number | null; // sound segment after this gap
  folded?: boolean; // cull merged/extended this gap → it's real silence, always eligible
}

interface Window {
  startSec: number;
  endSec: number;
  secToArrBeat: (s: number) => number;
  channels: Float32Array[]; // PCM, for zero-crossing snapping
  sampleRate: number;
}

// extent of the silence inside a gap: first..last window at/below `thresh`. Unlike a
// longest-contiguous-run, this tolerates brief blips so the whole quiet span is one region.
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

export function buildCandidates(
  detection: Detection,
  win: Window,
): { candidates: Candidate[]; edge: EdgeContext } {
  const { segments, rms, windowDur, noiseFloor } = detection;

  const span = win.endSec - win.startSec || 1;
  const frac = (s: number) => (s - win.startSec) / span;
  const quietThresh = noiseFloor * Math.pow(10, QUIET_MARGIN_DB / 20);

  // The edge context depends only on the window + detection, not the candidates, so it
  // is the same whether or not any gaps survive. Build it once, return it on every path.
  const edge: EdgeContext = {
    rms,
    windowDur,
    noiseFloor,
    quietThresh,
    silenceThresh: SILENCE_LEVEL,
    frac,
    secToArrBeat: win.secToArrBeat,
  };

  if (segments.length <= 1) return { candidates: [], edge };

  const snap = (s: number) => snapToZeroCrossing(win.channels, win.sampleRate, s);

  const extentAt = (gapStart: number, gapEnd: number, thresh: number): Extent => {
    const ext = deepExtent(rms, windowDur, gapStart, gapEnd, thresh);
    const hasDeep = !!ext && ext.end - ext.start >= MIN_DEEP_SEC;
    const cutSec = snap(hasDeep ? ext!.start : (gapStart + gapEnd) / 2);
    const deepEndSec = hasDeep ? snap(ext!.end) : cutSec;
    return {
      hasDeep,
      cutFrac: frac(cutSec),
      deepEndFrac: frac(deepEndSec),
      cutBeat: win.secToArrBeat(cutSec),
      deepEndBeat: win.secToArrBeat(deepEndSec),
      cutSec,
      deepEndSec,
    };
  };

  // sound segments clipped to the operating window
  const segs = segments
    .map((s) => ({ start: Math.max(s.start, win.startSec), end: Math.min(s.end, win.endSec) }))
    .filter((s) => s.end - s.start > 0);
  if (!segs.length) return { candidates: [], edge };

  // each sound segment's level (dB above the floor) — tags the gaps so cull can decide
  // which segments fold into silence
  const segLevels = segs.map((sg) => segmentLevelDb(rms, windowDur, sg.start, sg.end, noiseFloor));
  const levelOf = (i: number): number | null => (i >= 0 && i < segLevels.length ? segLevels[i]! : null);

  // gaps: leading silence (window → first sound), gaps between sounds, trailing silence
  const gaps: { start: number; end: number; edge: boolean; prevIdx: number; nextIdx: number }[] = [];
  if (segs[0]!.start - win.startSec >= MIN_DEEP_SEC) {
    gaps.push({ start: win.startSec, end: segs[0]!.start, edge: true, prevIdx: -1, nextIdx: 0 });
  }
  for (let i = 0; i < segs.length - 1; i++) {
    gaps.push({ start: segs[i]!.end, end: segs[i + 1]!.start, edge: false, prevIdx: i, nextIdx: i + 1 });
  }
  const lastSeg = segs[segs.length - 1]!;
  if (win.endSec - lastSeg.end >= MIN_DEEP_SEC) {
    gaps.push({ start: lastSeg.end, end: win.endSec, edge: true, prevIdx: segs.length - 1, nextIdx: -1 });
  }

  const out: Candidate[] = [];
  for (const gap of gaps) {
    const durSec = gap.end - gap.start;
    if (durSec <= 0) continue;
    const gapStartSec = snap(gap.start);
    const gapEndSec = snap(gap.end);
    out.push({
      durSec,
      edge: gap.edge,
      gapStartFrac: frac(gapStartSec),
      gapEndFrac: frac(gapEndSec),
      gapStartBeat: win.secToArrBeat(gapStartSec),
      gapEndBeat: win.secToArrBeat(gapEndSec),
      quiet: extentAt(gap.start, gap.end, quietThresh),
      silence: extentAt(gap.start, gap.end, SILENCE_LEVEL),
      prevLevelDb: levelOf(gap.prevIdx),
      nextLevelDb: levelOf(gap.nextIdx),
    });
  }
  return { candidates: out, edge };
}
