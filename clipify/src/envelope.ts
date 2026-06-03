// Downsample decoded PCM to a peak-per-bucket envelope for the popup's waveform.
// Peaks are absolute sample values in [0, 1], one per horizontal pixel-ish bucket
// across the operating window [startSec, endSec].

export function buildEnvelope(
  channels: Float32Array[],
  sampleRate: number,
  startSec: number,
  endSec: number,
  buckets = 800,
): number[] {
  const length = channels[0]?.length ?? 0;
  const start = Math.max(0, Math.floor(startSec * sampleRate));
  const end = Math.min(length, Math.ceil(endSec * sampleRate));
  const span = Math.max(1, end - start);
  const out: number[] = new Array(buckets).fill(0);

  for (let b = 0; b < buckets; b++) {
    const i0 = start + Math.floor((b * span) / buckets);
    const i1 = start + Math.floor(((b + 1) * span) / buckets);
    let peak = 0;
    for (let i = i0; i < i1; i++) {
      for (const ch of channels) {
        const v = Math.abs(ch[i] ?? 0);
        if (v > peak) peak = v;
      }
    }
    out[b] = peak;
  }
  return out;
}
