// Gap detection: find the quiet sections (breaths / spaces between words & phrases)
// and return the SOUND segments in between. Pure DSP, no SDK — operates on decoded
// PCM so it's easy to reason about and swap the metric later.
//
// Detection runs at the FINEST grain (catch every word-level segment). Choosing
// which gaps actually become cuts is a separate, grain-controlled step in plan.ts.

export interface DetectParams {
  /** Which RMS percentile (0..1) is treated as the recording's noise floor. */
  noiseFloorPercentile: number;
  /** How far above the noise floor (dB) still counts as "quiet". Higher = more
   *  gets treated as a gap, so messier audio still yields cuts. */
  thresholdMarginDb: number;
  /** Hard lower bound (linear RMS) for the threshold. On clean audio the noise
   *  floor is near-zero, so the adaptive term would treat room tone / tails as
   *  sound and over-segment; this floor keeps clean material sane. The adaptive
   *  term only takes over when the actual noise floor is higher (noisy audio). */
  absoluteFloor: number;
  /** Median-filter width (in windows, odd) applied to the RMS envelope. Removes
   *  lone loud spikes that would otherwise split a real gap into sub-threshold
   *  runs and make it disappear. */
  smoothingWindows: number;
  /** A quiet stretch must last at least this long (seconds) to be treated as a cut. */
  minSilenceDuration: number;
  /** Drop sound segments shorter than this (seconds) — kills tiny fragments. */
  minSegmentDuration: number;
  /** Grow each sound segment by this much on each side (seconds) so we keep
   *  transients / breath tails and don't cut too tight. */
  padding: number;
  /** RMS analysis window in samples. */
  windowSize: number;
}

export interface Segment {
  start: number; // seconds
  end: number; // seconds
}

/**
 * Fixed, fine detection settings. Sensitivity no longer lives here — every slice
 * detects the same word-level segments; plan.ts decides how many survive as cuts.
 */
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

/** Per-window RMS across all channels. */
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

/** Value at percentile p (0..1) of a list, via nearest-rank on a sorted copy. */
function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx]!;
}

/** Sliding median over `width` windows (odd); width <= 1 is a no-op. */
function medianFilter(values: number[], width: number): number[] {
  if (width <= 1) return values;
  const h = Math.floor(width / 2);
  return values.map((_, i) => {
    const win = values.slice(Math.max(0, i - h), Math.min(values.length, i + h + 1));
    win.sort((a, b) => a - b);
    return win[Math.floor(win.length / 2)]!;
  });
}

/** Result of detection, plus the levels used (for evaluation/logging). */
export interface Detection {
  segments: Segment[]; // sound regions to keep, in seconds
  noiseFloor: number; // measured floor (linear RMS)
  threshold: number; // the "quiet" cutoff actually used (linear RMS)
}

/**
 * Returns the SOUND segments (the parts to keep as individual clips), in seconds,
 * plus the detection levels used. Found by locating qualifying silence gaps and
 * taking the audio between them. The "quiet" threshold is adaptive — a margin
 * above the measured noise floor, bounded below by an absolute floor — so gaps
 * are caught on clean and noisy recordings alike without over-segmenting.
 */
export function detectSoundSegments(
  channels: Float32Array[],
  sampleRate: number,
  p: DetectParams = DETECT_PARAMS,
): Detection {
  if (!channels.length || !channels[0]?.length) {
    return { segments: [], noiseFloor: 0, threshold: 0 };
  }

  const totalDur = channels[0].length / sampleRate;
  const windowDur = p.windowSize / sampleRate;
  const minSilenceWindows = Math.ceil(p.minSilenceDuration / windowDur);

  const rms = medianFilter(windowRms(channels, p.windowSize), p.smoothingWindows);

  // Adaptive threshold: sit `thresholdMarginDb` above the noise floor, so "quiet"
  // means quiet relative to THIS recording — but never below `absoluteFloor`, so
  // a pristine clip (floor ~0) doesn't treat room tone as sound.
  const noiseFloor = percentile(rms, p.noiseFloorPercentile);
  const threshold = Math.max(noiseFloor * Math.pow(10, p.thresholdMarginDb / 20), p.absoluteFloor);
  const quiet = rms.map((v) => v < threshold);

  // Collect qualifying silence gaps (runs of quiet windows that are long enough).
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

  // Sound = the timeline minus the gaps.
  const sounds: Segment[] = [];
  let cursor = 0;
  for (const g of gaps) {
    if (g.start > cursor) sounds.push({ start: cursor, end: g.start });
    cursor = g.end;
  }
  if (cursor < totalDur) sounds.push({ start: cursor, end: totalDur });

  // Pad, clamp, drop fragments, then merge any segments that now overlap.
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
  return { segments: merged, noiseFloor, threshold };
}
