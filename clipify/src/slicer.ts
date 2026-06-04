// Slice & Strip: decode every clip the time selection overlaps, preview them in the
// popup, then apply the chosen splits/strips to each.
//
// Heavy DSP runs here (decode → detect → candidates → envelope), optionally sharing
// one noise floor across clips; the popup does the interactive selection
// (showModalDialog is one-shot, no round-trips); then we apply per clip: zero-width
// splits at each cut beat, and for each strip region mute/clear the isolated clip
// (or the whole clip when it never rises above threshold). Cuts snap to zero
// crossings in candidates.ts so splits are clean.

import { initialize, AudioClip, AudioTrack } from "@ableton-extensions/sdk";

import { detectSoundSegments, smoothedRms, floorFromRms, segmentLevelDb } from "./silence.js";
import { buildCandidates, type Candidate, type EdgeContext } from "./candidates.js";
import { findValleys } from "./valleys.js";
import { snapToZeroCrossing } from "./zeroCross.js";
import { buildEnvelope } from "./envelope.js";
import { renderWindow } from "./render.js";
import { applyLevel, type LevelRange } from "./level.js";
import { loadSettings, saveSettings, type Settings } from "./settings.js";
import { computeSelection, type Portions, type ValleyCut } from "./select.js";
import { debug } from "./debug.js";
import popupHtml from "./popup.html";

type Ctx = ReturnType<typeof initialize>;

const DEDUPE_BEATS = 1e-4; // cut beats closer than this collapse to one

export interface Target {
  clip: AudioClip<"1.0.0">;
  track: AudioTrack<"1.0.0">;
  winStartBeat: number; // operating window, arrangement beats
  winEndBeat: number;
}

interface ApplyResult {
  action: string;
  settings?: Settings;
}

interface ClipPrep {
  target: Target;
  candidates: Candidate[];
  edge: EdgeContext;
  valleys: ValleyCut[];
  envelope: number[]; // empty unless requested
  noiseFloor: number;
  hasContent: boolean; // false when the whole window is below threshold
  durSec: number;
}

// Render every target's window and build its cut candidates. The render is in
// arrangement time, so it IS the window — local second 0 maps to winStartBeat and
// the beat conversion is a linear tempo rate. When avgAcrossClips is set and
// there's more than one clip, all clips share one noise floor pooled from their RMS,
// so a quiet clip is judged against the same bar as a loud one (and gets stripped
// whole if it never rises above it).
async function prepareAll(
  context: Ctx,
  targets: Target[],
  withEnvelope: boolean,
  avgAcrossClips: boolean,
): Promise<ClipPrep[]> {
  const beatPerSec = context.application.song.tempo / 60;
  const rendered = [];
  for (const target of targets) {
    debug.log(`render "${target.clip.name}" [${debug.fmt(target.winStartBeat)}..${debug.fmt(target.winEndBeat)}]`);
    const { channels, sampleRate, durSec } = await renderWindow(
      context,
      target.track,
      target.winStartBeat,
      target.winEndBeat,
    );
    rendered.push({
      target,
      channels,
      sampleRate,
      durSec,
      secToArrBeat: (s: number) => target.winStartBeat + s * beatPerSec,
    });
  }

  let sharedFloor: number | undefined;
  if (avgAcrossClips && rendered.length > 1) {
    sharedFloor = floorFromRms(rendered.flatMap((d) => smoothedRms(d.channels)));
  }

  return rendered.map((d) => {
    const detection = detectSoundSegments(d.channels, d.sampleRate, undefined, sharedFloor);
    const { candidates, edge } = buildCandidates(detection, {
      startSec: 0,
      endSec: d.durSec,
      secToArrBeat: d.secToArrBeat,
      channels: d.channels,
      sampleRate: d.sampleRate,
    });
    const span = d.durSec || 1;
    const valleys: ValleyCut[] = detection.segments.flatMap((seg) => {
      const segLevelDb = segmentLevelDb(detection.rms, detection.windowDur, seg.start, seg.end, detection.noiseFloor);
      return findValleys(d.channels, d.sampleRate, seg.start, seg.end, detection.noiseFloor).map((v) => {
        const t = snapToZeroCrossing(d.channels, d.sampleRate, v.timeSec);
        return { cutBeat: d.secToArrBeat(t), cutFrac: t / span, depthRatio: v.depthRatio, widthSec: v.widthSec, segLevelDb };
      });
    });
    debug.log(
      `prepare "${d.target.clip.name}"  floor ${debug.db(detection.noiseFloor)}dB  ` +
        `${detection.segments.length} segments  ${candidates.length} gaps  ${valleys.length} valleys`,
    );
    return {
      target: d.target,
      candidates,
      edge,
      valleys,
      envelope: withEnvelope ? buildEnvelope(d.channels, d.sampleRate, 0, d.durSec) : [],
      noiseFloor: detection.noiseFloor,
      hasContent: detection.segments.length > 0,
      durSec: d.durSec,
    };
  });
}

export async function runSliceStrip(context: Ctx, targets: Target[]): Promise<void> {
  const settings = await loadSettings(context.environment.storageDirectory);
  const preps = await prepareAll(context, targets, true, settings.avgAcrossClips);

  const spanStartBeat = Math.min(...targets.map((t) => t.winStartBeat));
  const spanEndBeat = Math.max(...targets.map((t) => t.winEndBeat));
  const data = {
    clips: preps.map((p) => ({
      name: p.target.clip.name,
      winStartBeat: p.target.winStartBeat,
      winEndBeat: p.target.winEndBeat,
      envelope: p.envelope,
      // RMS noise floor scaled toward full-scale for a rough canvas reference line
      noiseFloorLevel: Math.min(1, p.noiseFloor * 4),
      candidates: p.candidates,
      valleys: p.valleys,
      hasContent: p.hasContent,
      edge: {
        rms: p.edge.rms,
        windowDur: p.edge.windowDur,
        quietThresh: p.edge.quietThresh,
        silenceThresh: p.edge.silenceThresh,
        noiseFloor: p.edge.noiseFloor,
        durSec: p.durSec,
      },
    })),
    spanStartBeat,
    spanEndBeat,
    defaults: settings,
  };
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const html = popupHtml.replace("__DATA__", json);

  let resultStr: string;
  try {
    resultStr = await context.ui.showModalDialog(`data:text/html,${encodeURIComponent(html)}`, 520, 540);
  } catch {
    return; // dialog dismissed
  }

  let result: ApplyResult;
  try {
    result = JSON.parse(resultStr) as ApplyResult;
  } catch {
    return;
  }
  if (result.settings) void saveSettings(context.environment.storageDirectory, result.settings);
  if (result.action !== "apply") return;

  const s = result.settings ?? settings;
  await applyMany(context, preps, s, { split: s.splitOn, strip: s.stripOn }, s.levelOn);
}

// Headless command: run the chosen portions with the last-saved settings, no popup.
export async function runHeadless(
  context: Ctx,
  targets: Target[],
  portions: Portions,
): Promise<void> {
  const settings = await loadSettings(context.environment.storageDirectory);
  const preps = await prepareAll(context, targets, false, settings.avgAcrossClips);
  await applyMany(context, preps, settings, portions, false);
}

function dedupe(beats: number[]): number[] {
  const sorted = [...beats].sort((a, b) => a - b);
  return sorted.filter((b, i) => i === 0 || b - sorted[i - 1]! > DEDUPE_BEATS);
}

interface Job {
  track: AudioTrack<"1.0.0">;
  cuts: number[];
  strips: { start: number; end: number }[];
  deleteWhole?: AudioClip<"1.0.0">; // clip is fully below threshold — strip it entirely
}

// Turn each prepared clip into a selection, then apply them all under one dialog.
// Splits/strips run first; LEVEL (when on) runs last over the clips that now exist.
async function applyMany(
  context: Ctx,
  preps: ClipPrep[],
  settings: Settings,
  portions: Portions,
  level: boolean,
): Promise<void> {
  const action: "off" | "deactivate" | "delete" = portions.strip ? settings.stripAction : "off";

  const jobs: Job[] = [];
  for (const p of preps) {
    if (portions.strip && !p.hasContent) {
      // whole window is silence/quiet — remove the clip outright
      jobs.push({ track: p.target.track, cuts: [], strips: [], deleteWhole: p.target.clip });
      continue;
    }
    const sel = computeSelection(
      p.candidates,
      settings,
      portions,
      p.target.winStartBeat,
      p.target.winEndBeat,
      p.valleys,
      p.edge,
    );
    if (sel.cutBeats.length) {
      jobs.push({ track: p.target.track, cuts: dedupe(sel.cutBeats), strips: sel.strips });
    }
  }
  if (!jobs.length && !level) {
    console.log("[clipify] nothing to do.");
    return;
  }

  const totalCuts = jobs.reduce((n, j) => n + j.cuts.length, 0);
  const totalStrips = jobs.reduce((n, j) => n + j.strips.length + (j.deleteWhole ? 1 : 0), 0);
  console.log(
    `[clipify] ${jobs.length} clip(s): ${totalCuts} cuts` +
      (action !== "off" && totalStrips ? `, ${action} ${totalStrips} region(s)` : "") +
      (level ? ", level" : "") + ".",
  );

  await context.ui.withinProgressDialog("Clipify…", {}, async (update) => {
    for (let i = 0; i < jobs.length; i++) {
      const pct = level ? Math.round((i / jobs.length) * 55) : Math.round((i / jobs.length) * 100);
      await update(`Clip ${i + 1} of ${jobs.length}…`, pct);
      await applyJob(context, jobs[i]!, action);
    }
    if (level) {
      const ranges: LevelRange[] = preps.map((p) => ({
        track: p.target.track,
        startBeat: p.target.winStartBeat,
        endBeat: p.target.winEndBeat,
      }));
      await applyLevel(context, ranges, settings, update);
    }
  });
}

// Apply one clip's cuts/strips. Splits are one undo step; the strip a second (it
// needs the post-split clips, so it can't share the transaction).
async function applyJob(context: Ctx, job: Job, action: "off" | "deactivate" | "delete"): Promise<void> {
  const { track, cuts, strips } = job;

  // whole-clip strip (clip never rises above threshold)
  if (job.deleteWhole) {
    if (action === "delete") {
      await context
        .withinTransaction(() => track.deleteClip(job.deleteWhole!))
        .catch((e: unknown) => console.error("[clipify] delete whole clip failed:", e));
    } else {
      context.withinTransaction(() => (job.deleteWhole!.muted = true));
    }
    return;
  }

  const stripping = strips.length > 0 && action !== "off";

  await context.withinTransaction(() =>
    Promise.all(
      cuts.map((b) =>
        track.clearClipsInRange(b, b).catch((e: unknown) => {
          console.error(`[clipify] split @ ${debug.fmt(b)} failed:`, e);
          return null;
        }),
      ),
    ),
  );

  if (!stripping) return;

  // the silence clips now exist; resolve them by start beat
  const clips = strips
    .map((r) => {
      const c = findClipAt(track, r.start);
      if (!c) console.error(`[clipify] no clip to strip @ ${debug.fmt(r.start)}`);
      return c;
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  if (action === "delete") {
    await context.withinTransaction(() =>
      Promise.all(
        clips.map((c) =>
          track.deleteClip(c).catch((e: unknown) => {
            console.error("[clipify] delete failed:", e);
            return null;
          }),
        ),
      ),
    );
  } else {
    context.withinTransaction(() => {
      for (const c of clips) c.muted = true;
    });
  }
}

function findClipAt(track: AudioTrack<"1.0.0">, beat: number) {
  return [...track.arrangementClips].find((c) => Math.abs(c.startTime - beat) < 1e-3) ?? null;
}
