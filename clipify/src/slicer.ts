// Slice & Strip: open the popup over a clip (or a time selection within one),
// then apply the cuts and strip the silence the user chose.
//
// Heavy DSP runs once here (decode → detect → candidates → envelope); the popup
// does the interactive mode/sensitivity/strip selection (showModalDialog is
// one-shot, no round-trips); then we apply: zero-width splits at each cut beat,
// and for each strip region either mute the isolated silence clip or clear it.
// Cut positions are snapped to zero crossings in candidates.ts so splits are clean.

import { initialize, AudioClip, AudioTrack } from "@ableton-extensions/sdk";

import * as fs from "node:fs/promises";

import { detectSoundSegments } from "./silence.js";
import { buildCandidates } from "./candidates.js";
import { buildEnvelope } from "./envelope.js";
import { buildClipMapping } from "./mapping.js";
import { loadSettings, saveSettings, type Settings } from "./settings.js";
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
  cutBeats?: number[];
  strips?: { start: number; end: number }[];
  stripAction?: "off" | "deactivate" | "delete";
  settings?: Settings;
}

// lazy import so a heavy/failing decoder can't block activation
async function decode(filePath: string) {
  const { default: decodeAudio } = await import("audio-decode");
  return decodeAudio(await fs.readFile(filePath));
}

export async function runSliceStrip(context: Ctx, target: Target): Promise<void> {
  const { clip, track, winStartBeat, winEndBeat } = target;

  const decoded = await decode(clip.filePath);
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) =>
    decoded.getChannelData(i),
  );

  // file-second <-> arrangement-beat mapping, then the operating window in seconds
  const { secToArrBeat, beatToClipSec } = buildClipMapping(clip, context.application.song.tempo);
  const winStartSec = beatToClipSec(winStartBeat);
  const winEndSec = beatToClipSec(winEndBeat);

  const detection = detectSoundSegments(channels, decoded.sampleRate);
  const candidates = buildCandidates(detection, {
    startSec: winStartSec,
    endSec: winEndSec,
    secToArrBeat,
    channels,
    sampleRate: decoded.sampleRate,
  });
  const envelope = buildEnvelope(channels, decoded.sampleRate, winStartSec, winEndSec);

  debug.log(
    `slice-strip "${clip.name}" warping=${clip.warping}  ` +
      `win-beat ${debug.fmt(winStartBeat)}..${debug.fmt(winEndBeat)}  ` +
      `win-sec ${debug.fmt(winStartSec)}..${debug.fmt(winEndSec)}  ` +
      `floor ${debug.db(detection.noiseFloor)}dB  ${candidates.length} candidate gaps`,
  );

  const settings = await loadSettings(context.environment.storageDirectory);
  const data = {
    meta: { subtitle: `${clip.name}  ${debug.fmt(winStartBeat, 1)}–${debug.fmt(winEndBeat, 1)}` },
    envelope,
    // RMS noise floor scaled toward full-scale for a rough canvas reference line
    noiseFloorLevel: Math.min(1, detection.noiseFloor * 4),
    candidates,
    defaults: settings,
  };
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const html = popupHtml.replace("__DATA__", json);

  let resultStr: string;
  try {
    resultStr = await context.ui.showModalDialog(`data:text/html,${encodeURIComponent(html)}`, 560, 400);
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

  if (result.action !== "apply" || !result.cutBeats?.length) {
    console.log(`[clipify] "${clip.name}": nothing to slice.`);
    return;
  }

  await applyCuts(context, track, result);
}

function dedupe(beats: number[]): number[] {
  const sorted = [...beats].sort((a, b) => a - b);
  return sorted.filter((b, i) => i === 0 || b - sorted[i - 1]! > DEDUPE_BEATS);
}

async function applyCuts(
  context: Ctx,
  track: AudioTrack<"1.0.0">,
  result: ApplyResult,
): Promise<void> {
  const cuts = dedupe(result.cutBeats ?? []);
  const strips = result.strips ?? [];
  const action = result.stripAction ?? "off";

  console.log(
    `[clipify] Slicing into ${cuts.length + 1} clips` +
      (strips.length && action !== "off" ? `, ${action} ${strips.length} silence region(s).` : "."),
  );

  const stripping = strips.length > 0 && action !== "off";

  await context.ui.withinProgressDialog("Clipify…", {}, async (update) => {
    await update(`Splitting at ${cuts.length} points…`, 40);
    // One transaction so the splits and the silence-disable land as a single,
    // grouped undo step (splits first, then strip).
    await context.withinTransaction(async () => {
      await Promise.all(
        cuts.map((b) =>
          track.clearClipsInRange(b, b).catch((e: unknown) => {
            console.error(`[clipify] split @ ${debug.fmt(b)} failed:`, e);
            return null;
          }),
        ),
      );
      if (stripping) {
        // Resolve the silence clips by start beat now (after the splits): deleting
        // one re-indexes the arrangement, so beat lookups go stale mid-loop, but
        // clip references hold.
        const clips = strips.map((r) => {
          const c = findClipAt(track, r.start);
          if (!c) console.error(`[clipify] no clip to strip @ ${debug.fmt(r.start)}`);
          return c;
        });
        if (action === "delete") {
          for (const c of clips) {
            if (c) await track.deleteClip(c).catch((e: unknown) => console.error("[clipify] delete failed:", e));
          }
        } else {
          for (const c of clips) if (c) c.muted = true;
        }
      }
    });
  });
}

function findClipAt(track: AudioTrack<"1.0.0">, beat: number) {
  return [...track.arrangementClips].find((c) => Math.abs(c.startTime - beat) < 1e-3) ?? null;
}
