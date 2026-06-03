// Turn detected sound segments into the contiguous clip pieces to create.
// Pure math, no SDK — given the sounds + the clip's window, decide where to cut.
//
// Detection (silence.ts) runs at the finest grain. Here we decide which of those
// gaps actually become cuts, by ranking gaps on duration and keeping only the
// ones above a grain-controlled significance cutoff. Bigger gaps = higher-level
// (phrase) boundaries; smaller gaps = word/syllable boundaries.

import type { Segment } from "./silence.js";

/** The clip's content window, and where it sits in the arrangement. */
export interface ClipWindow {
  startSec: number; // content window into the file (seconds)
  endSec: number;
  startTime: number; // arrangement position at startMarker (beats)
  startMarker: number; // content/marker offset at startTime (marker-beats)
  /** Arrangement beats per content-marker beat. 1 for a warped clip (content
   *  beats lock to arrangement beats); ≠1 for an unwarped clip whose native
   *  marker grid differs from the project grid, or a stretched/looped clip. */
  markerToArrangement: number;
  filePath: string;
}

export interface Piece {
  filePath: string;
  startMarker: number; // file offset (beats)
  endMarker: number;
  duration: number; // beats
  startTime: number; // arrangement position (beats)
}

export interface PlanResult {
  pieces: Piece[];
  /** Every gap between sounds, with whether it became a cut — for evaluation. */
  gaps: { durSec: number; kept: boolean }[];
}

/**
 * Cuts land in the MIDDLE of each gap between sounds, so every piece keeps its
 * audio (plus padding) and the window stays fully tiled in its original place.
 *
 * `keepFraction` in (0,1] selects how many of the gaps become cuts, by keeping
 * the LARGEST gaps first (rank-based, so the grain tiers stay well separated
 * even when gap sizes are bimodal — phrase gaps vs word gaps):
 *   1   -> cut at every detected gap (finest / most slices)
 *   ~.4 -> the larger ~40% of gaps (sub-phrase)
 *   ~.2 -> only the largest ~20% (phrase level)
 * At least one cut is always kept. Returns fewer than 2 pieces when there's
 * nothing worth cutting.
 */
export function planPieces(
  sounds: Segment[],
  win: ClipWindow,
  secToBeat: (s: number) => number,
  keepFraction: number,
): PlanResult {
  // Restrict the detected sounds to the clip's used window into the file.
  const windowed = sounds
    .map((s) => ({ start: Math.max(s.start, win.startSec), end: Math.min(s.end, win.endSec) }))
    .filter((s) => s.end - s.start > 0);
  if (windowed.length <= 1) return { pieces: [], gaps: [] };

  // The gap between each pair of adjacent sounds; the cut lands at its midpoint.
  const gaps = windowed.slice(0, -1).map((s, i) => ({
    mid: (s.end + windowed[i + 1]!.start) / 2,
    dur: Math.max(1e-6, windowed[i + 1]!.start - s.end),
  }));

  // Keep the largest `keepFraction` of gaps. The duration at that rank becomes
  // the cutoff; gaps at or above it are cut (ties included, so >= rather than >).
  const sortedDur = gaps.map((g) => g.dur).sort((a, b) => a - b);
  const idx = Math.min(
    sortedDur.length - 1,
    Math.max(0, Math.floor((1 - keepFraction) * (sortedDur.length - 1))),
  );
  const keepDur = sortedDur[idx]!;

  const cutsSec = gaps.filter((g) => g.dur >= keepDur).map((g) => g.mid);
  const boundsSec = [win.startSec, ...cutsSec, win.endSec];

  const pieces: Piece[] = [];
  for (let i = 0; i < boundsSec.length - 1; i++) {
    const startMarker = secToBeat(boundsSec[i]!);
    const endMarker = secToBeat(boundsSec[i + 1]!);
    pieces.push({
      filePath: win.filePath,
      startMarker,
      endMarker,
      // Arrangement length/position scale from content markers through the
      // clip's real ratio (1 for warped clips, ≠1 for unwarped/stretched ones).
      duration: (endMarker - startMarker) * win.markerToArrangement,
      startTime: win.startTime + (startMarker - win.startMarker) * win.markerToArrangement,
    });
  }

  return {
    pieces,
    gaps: gaps.map((g) => ({ durSec: g.dur, kept: g.dur >= keepDur })),
  };
}
