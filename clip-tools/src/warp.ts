// Maps file-seconds to beats from a clip's warp markers (non-linear), or linear
// tempo when the clip is unwarped.

const BEAT_EPSILON = 1e-6; // beats this close are the same warp point

export type WarpPt = { sec: number; beat: number };

export interface WarpMap {
  secToBeat: (s: number) => number;
}

// `anchors` pin the curve to the clip's endpoints: Live reports markers for only
// part of a clip, so without them the curve extrapolates past the clip end. An
// anchor on the same beat as a real marker is dropped.
export function buildWarpMap(
  markers: { sampleTime: number; beatTime: number }[],
  secPerBeat: number,
  anchors?: WarpPt[],
): WarpMap {
  if (!markers || markers.length < 2) return { secToBeat: (s) => s / secPerBeat };

  const realBeats = markers.map((m) => m.beatTime);
  const pts: WarpPt[] = markers
    .map((m) => ({ sec: m.sampleTime, beat: m.beatTime }))
    .concat((anchors ?? []).filter((a) => !realBeats.some((b) => Math.abs(b - a.beat) < BEAT_EPSILON)))
    .sort((a, b) => a.sec - b.sec);

  return {
    secToBeat: (s) => {
      let i = 0;
      while (i < pts.length - 2 && s > pts[i + 1]!.sec) i++;
      const lo = pts[i]!;
      const hi = pts[i + 1]!;
      const span = hi.sec - lo.sec;
      const frac = span === 0 ? 0 : (s - lo.sec) / span;
      return lo.beat + frac * (hi.beat - lo.beat);
    },
  };
}
