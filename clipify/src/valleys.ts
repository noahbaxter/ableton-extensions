// Find natural cut points INSIDE a sound segment: the dip where one event releases
// and the next attacks (the pause between syllables/words). A dip only counts if it
// is deep enough relative to its neighbouring peaks AND lasts a minimum time — a
// brief dip is the sound's own amplitude wobble, not a gap. The depth/width here are
// MEASURED; the keep/discard decision lives in select.ts so the popup can tune it.

export interface Valley {
  timeSec: number; // dip centre, seconds from the envelope (segment) start
  depthRatio: number; // 0..1 — fall from the lower neighbouring peak toward the floor
  widthSec: number; // width of the dip measured at half-depth
}

export interface ValleyParams {
  windowSize: number; // fine RMS window, samples (~5 ms) so 30–40 ms dips resolve
}

export const VALLEY_PARAMS: ValleyParams = { windowSize: 256 }; // ~5.8 ms @ 44.1k

// Core, pure, testable on a plain energy envelope.
export function valleysInEnvelope(env: number[], windowDur: number, floor: number): Valley[] {
  const n = env.length;
  if (n < 3) return [];

  // candidate dips: strict interior local minima
  const found: (Valley & { a: number; b: number })[] = [];
  for (let i = 1; i < n - 1; i++) {
    const m = env[i]!;
    const isMin = m <= env[i - 1]! && m <= env[i + 1]! && (m < env[i - 1]! || m < env[i + 1]!);
    if (!isMin) continue;

    // highest point on each side (within the segment); the lower of the two governs
    // the dip. A running max — not a climb to the nearest local peak — so per-window
    // flutter can't strand the reference on a micro-bump inside the quiet stretch.
    let leftPeak = m;
    for (let j = i - 1; j >= 0; j--) leftPeak = Math.max(leftPeak, env[j]!);
    let rightPeak = m;
    for (let j = i + 1; j < n; j++) rightPeak = Math.max(rightPeak, env[j]!);
    const peakRef = Math.min(leftPeak, rightPeak);
    if (peakRef <= floor) continue; // no real hump around the dip

    const depthRatio = Math.max(0, Math.min(1, (peakRef - m) / (peakRef - floor)));

    // width at half-depth (half-way from the peak down to the minimum)
    const half = (peakRef + m) / 2;
    let a = i;
    while (a > 0 && env[a - 1]! <= half) a--;
    let b = i;
    while (b < n - 1 && env[b + 1]! <= half) b++;

    found.push({
      a,
      b,
      depthRatio,
      widthSec: (b - a + 1) * windowDur,
      timeSec: ((a + b) / 2 + 0.5) * windowDur,
    });
  }

  // merge dips whose half-depth spans overlap; keep the deepest
  found.sort((x, y) => y.depthRatio - x.depthRatio);
  const kept: (Valley & { a: number; b: number })[] = [];
  for (const v of found) {
    if (kept.some((k) => v.a <= k.b && k.a <= v.b)) continue;
    kept.push(v);
  }
  return kept
    .sort((x, y) => x.timeSec - y.timeSec)
    .map(({ timeSec, depthRatio, widthSec }) => ({ timeSec, depthRatio, widthSec }));
}

// per-window RMS across all channels over [startSec, endSec)
function windowRms(
  channels: Float32Array[],
  sampleRate: number,
  startSec: number,
  endSec: number,
  windowSize: number,
): number[] {
  const i0 = Math.max(0, Math.floor(startSec * sampleRate));
  const i1 = Math.min(channels[0]?.length ?? 0, Math.ceil(endSec * sampleRate));
  const out: number[] = [];
  for (let i = i0; i < i1; i += windowSize) {
    const end = Math.min(i + windowSize, i1);
    let sumSq = 0;
    let count = 0;
    for (let j = i; j < end; j++) {
      for (const ch of channels) {
        const v = ch[j] ?? 0;
        sumSq += v * v;
      }
      count += channels.length;
    }
    out.push(count ? Math.sqrt(sumSq / count) : 0);
  }
  return out;
}

export function findValleys(
  channels: Float32Array[],
  sampleRate: number,
  startSec: number,
  endSec: number,
  floor: number,
  p: ValleyParams = VALLEY_PARAMS,
): Valley[] {
  const windowDur = p.windowSize / sampleRate;
  const env = windowRms(channels, sampleRate, startSec, endSec, p.windowSize);
  return valleysInEnvelope(env, windowDur, floor).map((v) => ({
    ...v,
    timeSec: startSec + v.timeSec,
  }));
}
