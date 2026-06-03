// Snap a cut time to the nearest near-zero-crossing sample, so splits don't click.
// We mix channels to mono and search a small window around the target for a sign
// change; among the crossings we pick the one closest to the target, and within
// that we take whichever of the two straddling samples sits closer to zero. With
// no sign change in range (e.g. dead silence — already click-free) we fall back to
// the quietest sample, then to the target itself.

const DEFAULT_SEARCH_SEC = 0.005; // ±5 ms

function mix(channels: Float32Array[], i: number): number {
  let s = 0;
  for (const ch of channels) s += ch[i] ?? 0;
  return s;
}

export function snapToZeroCrossing(
  channels: Float32Array[],
  sampleRate: number,
  sec: number,
  searchSec: number = DEFAULT_SEARCH_SEC,
): number {
  const length = channels[0]?.length ?? 0;
  if (!length) return sec;

  const target = Math.round(sec * sampleRate);
  const w = Math.max(1, Math.round(searchSec * sampleRate));
  const lo = Math.max(0, target - w);
  const hi = Math.min(length - 1, target + w);

  let bestCross = -1;
  let bestCrossDist = Infinity;
  let quietest = target;
  let quietestAbs = Infinity;

  let prev = mix(channels, lo);
  for (let i = lo; i <= hi; i++) {
    const v = mix(channels, i);
    const a = Math.abs(v);
    if (a < quietestAbs) {
      quietestAbs = a;
      quietest = i;
    }
    if (i > lo && ((prev <= 0 && v > 0) || (prev >= 0 && v < 0))) {
      // the line between samples i-1 and i hits zero at this fractional index —
      // a cut time is continuous, so we don't need to land on an actual sample
      const denom = Math.abs(prev) + a;
      const cross = denom > 0 ? i - 1 + Math.abs(prev) / denom : i - 1;
      const dist = Math.abs(cross - target);
      if (dist < bestCrossDist) {
        bestCrossDist = dist;
        bestCross = cross;
      }
    }
    prev = v;
  }

  const snapped = bestCross >= 0 ? bestCross : quietest;
  return snapped / sampleRate;
}
