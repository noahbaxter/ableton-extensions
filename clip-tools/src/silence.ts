// Gap detection: find the quiet sections (breaths / spaces between words & phrases)
// and return the SOUND segments in between. Pure DSP, no SDK — operates on decoded
// PCM so it's easy to reason about and swap the metric later.

export interface DetectParams {
  /** RMS below this (linear, 0..1) counts as "quiet". Higher = more counts as a gap. */
  rmsThreshold: number;
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
 * "Confidence" / sensitivity knob in [0,1].
 *   0  -> only cuts at long, very quiet gaps (few slices)
 *   1  -> cuts at short, subtler gaps (many slices)
 * Everything else is derived from this single number.
 */
export function paramsForSensitivity(s: number): DetectParams {
  const t = Math.min(1, Math.max(0, s));
  const lerp = (a: number, b: number) => a + (b - a) * t;
  return {
    rmsThreshold: lerp(0.004, 0.045), // ~ -48 dBFS .. -27 dBFS
    minSilenceDuration: lerp(0.35, 0.07),
    minSegmentDuration: lerp(0.3, 0.05),
    padding: 0.02,
    windowSize: 1024,
  };
}

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

/**
 * Returns the SOUND segments (the parts to keep as individual clips), in seconds.
 * Found by locating qualifying silence gaps and taking the audio between them.
 */
export function detectSoundSegments(
  channels: Float32Array[],
  sampleRate: number,
  p: DetectParams,
): Segment[] {
  if (!channels.length || !channels[0]?.length) return [];

  const totalDur = channels[0].length / sampleRate;
  const windowDur = p.windowSize / sampleRate;
  const minSilenceWindows = Math.ceil(p.minSilenceDuration / windowDur);

  const rms = windowRms(channels, p.windowSize);
  const quiet = rms.map((v) => v < p.rmsThreshold);

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
  return merged;
}
