// Level Balance: match every clip to a common RMS — quieter clips up, louder clips
// down — trivial volume matching without a compressor. Runs last (after
// split/strip), on the actual clips that exist on the track in the selection.
//
// No per-clip gain API exists (SDK 1.0.0-beta.0), and installed extensions can't
// read source files (fs sandbox), so a boost is applied destructively: render the
// clip (renderPreFxAudio — as-heard, warp/fades baked in), multiply the PCM, write
// a float32 WAV to the temp dir, importIntoProject, and replace the clip. Stopgap
// until clip gain lands. See the level-balance design spec.

import { initialize, AudioClip, AudioTrack } from "@ableton-extensions/sdk";

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { renderWindow } from "./render.js";
import { detectSoundSegments } from "./silence.js";
import { sniffPcm, scalePcm } from "./audioFile.js";
import type { Settings } from "./settings.js";
import { debug } from "./debug.js";

type Ctx = ReturnType<typeof initialize>;

export interface LevelRange {
  track: AudioTrack<"1.0.0">;
  startBeat: number;
  endBeat: number;
}

const EPS_DB = 0.01;
const lin2db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const db2lin = (db: number) => Math.pow(10, db / 20);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface Measured {
  clip: AudioClip<"1.0.0">;
  track: AudioTrack<"1.0.0">;
  buffer: Buffer; // the rendered file, scaled in place for the boost
  rmsDb: number; // content-gated RMS, dBFS
  peakDb: number; // true sample peak, dBFS
}

// Content-gated RMS (over detected sound segments) + true peak (over all samples).
// Returns null for a clip with no content — silent clips aren't boosted.
function measure(channels: Float32Array[], sampleRate: number): { rms: number; peak: number } | null {
  const det = detectSoundSegments(channels, sampleRate);
  if (!det.segments.length) return null;

  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i] ?? 0);
      if (a > peak) peak = a;
    }
  }

  let sumSq = 0;
  let n = 0;
  const len = channels[0]?.length ?? 0;
  for (const seg of det.segments) {
    const s = Math.max(0, Math.floor(seg.start * sampleRate));
    const e = Math.min(len, Math.ceil(seg.end * sampleRate));
    for (const ch of channels) {
      for (let i = s; i < e; i++) {
        const v = ch[i] ?? 0;
        sumSq += v * v;
      }
      n += e - s;
    }
  }
  if (!n) return null;
  return { rms: Math.sqrt(sumSq / n), peak };
}

// Resolve the unique audio clips overlapping any range.
function resolveClips(ranges: LevelRange[]): { clip: AudioClip<"1.0.0">; track: AudioTrack<"1.0.0"> }[] {
  const seen = new Set<AudioClip<"1.0.0">>();
  const out: { clip: AudioClip<"1.0.0">; track: AudioTrack<"1.0.0"> }[] = [];
  for (const r of ranges) {
    for (const c of r.track.arrangementClips) {
      if (c instanceof AudioClip && c.startTime < r.endBeat && c.endTime > r.startBeat && !seen.has(c)) {
        seen.add(c);
        out.push({ clip: c, track: r.track });
      }
    }
  }
  return out;
}

export async function applyLevel(
  context: Ctx,
  ranges: LevelRange[],
  settings: Settings,
  update?: (text: string, pct: number) => void | Promise<void>,
): Promise<void> {
  const clips = resolveClips(ranges);
  if (clips.length < 2) {
    console.log("[clipify] level: need at least 2 clips to match.");
    return;
  }

  // Live provides tempDirectory when installed; fall back to storageDirectory
  // (always set) so dev runs and any odd host still work.
  const tempDir = context.environment.tempDirectory ?? context.environment.storageDirectory;
  if (!tempDir) {
    console.error("[clipify] level: no writable directory available.");
    return;
  }
  await fs.mkdir(tempDir, { recursive: true }).catch(() => {}); // host sets the path but may not create it

  // Measure every clip (one render each, PCM held for the boost step).
  const measured: Measured[] = [];
  for (let i = 0; i < clips.length; i++) {
    await update?.(`Measuring ${i + 1}/${clips.length}…`, 60 + (i / clips.length) * 20);
    const { clip, track } = clips[i]!;
    const { channels, sampleRate, buffer } = await renderWindow(context, track, clip.startTime, clip.endTime);
    const m = measure(channels, sampleRate);
    if (!m) continue; // silent clip — skip
    measured.push({ clip, track, buffer, rmsDb: lin2db(m.rms), peakDb: lin2db(m.peak) });
  }
  if (measured.length < 2) return;

  // Common RMS target every clip can reach without its peak passing the ceiling:
  // T = min over clips of (ceiling − crest). The peakiest clip lands exactly at the
  // ceiling; louder clips come down, quieter ones go up. None clip by construction.
  const target = Math.min(...measured.map((m) => settings.ceilingDb - (m.peakDb - m.rmsDb)));

  const moves = measured
    .map((m) => ({ m, gainDb: clamp(target - m.rmsDb, -settings.maxChangeDb, settings.maxChangeDb) }))
    .filter((x) => Math.abs(x.gainDb) > EPS_DB);

  for (let i = 0; i < moves.length; i++) {
    await update?.(`Leveling ${i + 1}/${moves.length}…`, 80 + (i / moves.length) * 20);
    await reRender(context, moves[i]!.m, moves[i]!.gainDb, tempDir, i);
  }

  debug.log(`level: target ${target.toFixed(1)}dB, moved ${moves.length}/${measured.length} clips`);
}

// Scale the rendered file's PCM in place (keeping its exact WAV/AIFF format), write
// it to the temp dir, import it into the project, and replace the clip with the
// imported file at the same position.
async function reRender(
  context: Ctx,
  m: Measured,
  gainDb: number,
  tempDir: string,
  idx: number,
): Promise<void> {
  const scaled = scalePcm(m.buffer, db2lin(gainDb));
  const ext = sniffPcm(m.buffer).container === "aiff" ? "aif" : "wav";
  const tmpPath = path.join(tempDir, `clipify-level-${idx}.${ext}`);
  await fs.writeFile(tmpPath, scaled);
  const imported = await context.resources.importIntoProject(tmpPath);
  await fs.unlink(tmpPath).catch(() => {}); // importIntoProject copied it in; scratch file no longer needed

  const { clip, track } = m;
  const snap = { startTime: clip.startTime, name: clip.name, color: clip.color, muted: clip.muted };

  await context.withinTransaction(() => track.deleteClip(clip));
  const nc = await context.withinTransaction(() =>
    track.createAudioClip({ filePath: imported, startTime: snap.startTime, isWarped: false }),
  );
  context.withinTransaction(() => {
    nc.name = snap.name;
    nc.color = snap.color;
    nc.muted = snap.muted;
  });

  debug.log(`level "${snap.name}" ${gainDb >= 0 ? "+" : ""}${gainDb.toFixed(1)}dB`);
}
