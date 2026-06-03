// Pick which silent gaps become cuts and where they land in the arrangement.
// The largest `keepFraction` of gaps become cuts — ranked, not a fixed duration
// threshold, so grain tiers stay separated when gaps are bimodal (phrase vs word).
// Each cut lands at its gap's midpoint.

import type { Segment } from "./silence.js";

const MIN_GAP_SEC = 1e-6; // floor so a zero-width gap can't break the ranking

export interface PlanResult {
  cutBeats: number[]; // cut positions, arrangement beats
  gaps: { durSec: number; kept: boolean }[]; // every gap + whether it was cut (logging)
}

// `secToArrBeat` places a file-second on the arrangement timeline. `keepFraction`
// in (0,1]: 1 cuts every gap, ~.4 the larger ~40%, ~.2 only the largest ~20%.
export function planCuts(
  sounds: Segment[],
  startSec: number,
  endSec: number,
  secToArrBeat: (s: number) => number,
  keepFraction: number,
): PlanResult {
  // clip the sounds to the clip's window into the file
  const windowed = sounds
    .map((s) => ({ start: Math.max(s.start, startSec), end: Math.min(s.end, endSec) }))
    .filter((s) => s.end - s.start > 0);
  if (windowed.length <= 1) return { cutBeats: [], gaps: [] };

  // gap and its midpoint between each adjacent pair of sounds
  const gaps = windowed.slice(0, -1).map((s, i) => ({
    mid: (s.end + windowed[i + 1]!.start) / 2,
    dur: Math.max(MIN_GAP_SEC, windowed[i + 1]!.start - s.end),
  }));

  // cutoff = the gap duration at the keepFraction rank; gaps >= it are cut
  const sortedDur = gaps.map((g) => g.dur).sort((a, b) => a - b);
  const idx = Math.min(
    sortedDur.length - 1,
    Math.max(0, Math.floor((1 - keepFraction) * (sortedDur.length - 1))),
  );
  const keepDur = sortedDur[idx]!;

  const cutBeats = gaps.filter((g) => g.dur >= keepDur).map((g) => secToArrBeat(g.mid));

  return {
    cutBeats,
    gaps: gaps.map((g) => ({ durSec: g.dur, kept: g.dur >= keepDur })),
  };
}
