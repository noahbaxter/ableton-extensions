// Find quiet gaps (breaths, spaces between words/phrases) and return the SOUND
// segments between them. Pure DSP on decoded PCM. Runs at the finest grain;
// plan.ts decides which gaps actually become cuts.

export interface DetectParams {
  noiseFloorPercentile: number; // RMS percentile treated as the noise floor
  thresholdMarginDb: number; // dB above the floor still counted as quiet (higher = more gaps)
  absoluteFloor: number; // hard RMS floor so near-silent audio doesn't read room tone as sound
  smoothingWindows: number; // median-filter width (windows) to kill lone spikes inside a gap
  minSilenceDuration: number; // min quiet stretch (s) to count as a gap
  minSegmentDuration: number; // drop sound segments shorter than this (s)
  padding: number; // grow each segment this much (s) per side to keep transients/breath tails
  windowSize: number; // RMS window, samples
}

export interface Segment {
  start: number; // seconds
  end: number; // seconds
}

// Every slice detects the same segments; plan.ts sets the grain.
export const DETECT_PARAMS: DetectParams = {
  noiseFloorPercentile: 0.1,
  thresholdMarginDb: 9, // ~2.8x the noise floor
  absoluteFloor: 0.025, // ~ -32 dBFS
  smoothingWindows: 3,
  minSilenceDuration: 0.045,
  minSegmentDuration: 0.03,
  padding: 0.015,
  windowSize: 1024,
};

// per-window RMS across all channels
function windowRms(channels: Float32Array[], windowSize: number): number[] {
  const length = channels[0]?.length ?? 0;
  const out: number[] = [];
  for (let i = 0; i < length; i += windowSize) {
    const end = Math.min(i + windowSize, length);
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

// value at percentile p (0..1), nearest-rank
function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx]!;
}

// sliding median over `width` windows (odd); width <= 1 is a no-op
function medianFilter(values: number[], width: number): number[] {
  if (width <= 1) return values;
  const h = Math.floor(width / 2);
  return values.map((_, i) => {
    const win = values.slice(Math.max(0, i - h), Math.min(values.length, i + h + 1));
    win.sort((a, b) => a - b);
    return win[Math.floor(win.length / 2)]!;
  });
}

export interface Detection {
  segments: Segment[]; // sound regions to keep, seconds
  noiseFloor: number; // measured floor, linear RMS
  threshold: number; // "quiet" cutoff used, linear RMS
  rms: number[]; // smoothed per-window RMS (lets candidates.ts probe gap depth)
  windowDur: number; // seconds per RMS window
}

export function detectSoundSegments(
  channels: Float32Array[],
  sampleRate: number,
  p: DetectParams = DETECT_PARAMS,
): Detection {
  if (!channels.length || !channels[0]?.length) {
    return { segments: [], noiseFloor: 0, threshold: 0, rms: [], windowDur: p.windowSize / sampleRate };
  }

  const totalDur = channels[0].length / sampleRate;
  const windowDur = p.windowSize / sampleRate;
  const minSilenceWindows = Math.ceil(p.minSilenceDuration / windowDur);

  const rms = medianFilter(windowRms(channels, p.windowSize), p.smoothingWindows);

  // quiet = a margin above the noise floor, but never below absoluteFloor
  const noiseFloor = percentile(rms, p.noiseFloorPercentile);
  const threshold = Math.max(noiseFloor * Math.pow(10, p.thresholdMarginDb / 20), p.absoluteFloor);
  const quiet = rms.map((v) => v < threshold);

  // runs of quiet windows long enough to qualify as a gap
  const gaps: Segment[] = [];
  let runStart = -1;
  for (let i = 0; i <= quiet.length; i++) {
    const isQuiet = i < quiet.length && quiet[i];
    if (isQuiet) {
      if (runStart === -1) runStart = i;
    } else if (runStart !== -1) {
      if (i - runStart >= minSilenceWindows) {
        gaps.push({ start: runStart * windowDur, end: i * windowDur });
      }
      runStart = -1;
    }
  }

  // sound = the timeline minus the gaps
  const sounds: Segment[] = [];
  let cursor = 0;
  for (const g of gaps) {
    if (g.start > cursor) sounds.push({ start: cursor, end: g.start });
    cursor = g.end;
  }
  if (cursor < totalDur) sounds.push({ start: cursor, end: totalDur });

  // pad, clamp, drop fragments, then merge any segments that now overlap
  const padded = sounds
    .map((s) => ({
      start: Math.max(0, s.start - p.padding),
      end: Math.min(totalDur, s.end + p.padding),
    }))
    .filter((s) => s.end - s.start >= p.minSegmentDuration);

  const merged: Segment[] = [];
  for (const s of padded) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  return { segments: merged, noiseFloor, threshold, rms, windowDur };
}
