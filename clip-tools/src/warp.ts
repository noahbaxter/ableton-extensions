// File-time <-> beat mapping from a clip's warp markers (the real, possibly
// non-linear mapping), with a linear-tempo fallback for unwarped clips.
// Pure math, no SDK — takes a plain marker array so it's easy to test.

export type WarpPt = { sec: number; beat: number };

export interface WarpMap {
  mode: "warp-markers" | "tempo-fallback";
  unit: "samples" | "seconds" | "n/a";
  pts: WarpPt[];
  secToBeat: (s: number) => number;
  beatToSec: (b: number) => number;
}

/**
 * Builds a file-second <-> beat mapping from the clip's warp markers. Falls back
 * to linear tempo when a clip has no usable warp markers (unwarped clips).
 * `sampleTime` units are auto-detected: Live may report seconds or samples, so
 * we sniff by magnitude vs the file length.
 */
export function buildWarpMap(
  markers: { sampleTime: number; beatTime: number }[],
  sampleRate: number,
  fileDurSec: number,
  secPerBeat: number,
): WarpMap {
  if (!markers || markers.length < 2) {
    return {
      mode: "tempo-fallback",
      unit: "n/a",
      pts: [],
      secToBeat: (s) => s / secPerBeat,
      beatToSec: (b) => b * secPerBeat,
    };
  }

  const maxST = Math.max(...markers.map((m) => m.sampleTime));
  const inSamples = maxST > fileDurSec * 4;
  const pts: WarpPt[] = markers
    .map((m) => ({ sec: inSamples ? m.sampleTime / sampleRate : m.sampleTime, beat: m.beatTime }))
    .sort((a, b) => a.sec - b.sec);

  const lerp = (x: number, k: "sec" | "beat", v: "sec" | "beat") => {
    let i = 0;
    while (i < pts.length - 2 && x > pts[i + 1]![k]) i++;
    const lo = pts[i]!;
    const hi = pts[i + 1]!;
    const span = hi[k] - lo[k];
    const frac = span === 0 ? 0 : (x - lo[k]) / span;
    return lo[v] + frac * (hi[v] - lo[v]);
  };

  return {
    mode: "warp-markers",
    unit: inSamples ? "samples" : "seconds",
    pts,
    secToBeat: (s) => lerp(s, "sec", "beat"),
    beatToSec: (b) => lerp(b, "beat", "sec"),
  };
}
