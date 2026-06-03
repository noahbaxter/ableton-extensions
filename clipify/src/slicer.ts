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
import { buildCandidates, type Candidate } from "./candidates.js";
import { buildEnvelope } from "./envelope.js";
import { buildClipMapping } from "./mapping.js";
import { loadSettings, saveSettings, type Settings } from "./settings.js";
import { computeSelection, type Portions } from "./select.js";
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

interface Prepared {
  candidates: Candidate[];
  envelope: number[]; // empty unless requested
  noiseFloor: number;
}

// Decode the clip and build the cut candidates over the operating window. Shared
// by the interactive popup and the headless commands (envelope is popup-only).
async function prepare(context: Ctx, target: Target, withEnvelope: boolean): Promise<Prepared> {
  const { clip, winStartBeat, winEndBeat } = target;

  const decoded = await decode(clip.filePath);
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) =>
    decoded.getChannelData(i),
  );

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
  const envelope = withEnvelope
    ? buildEnvelope(channels, decoded.sampleRate, winStartSec, winEndSec)
    : [];

  debug.log(
    `prepare "${clip.name}" warping=${clip.warping}  ` +
      `win-beat ${debug.fmt(winStartBeat)}..${debug.fmt(winEndBeat)}  ` +
      `floor ${debug.db(detection.noiseFloor)}dB  ${candidates.length} candidate gaps`,
  );

  return { candidates, envelope, noiseFloor: detection.noiseFloor };
}

export async function runSliceStrip(context: Ctx, target: Target): Promise<void> {
  const { clip, track, winStartBeat, winEndBeat } = target;
  const prep = await prepare(context, target, true);
  const settings = await loadSettings(context.environment.storageDirectory);

  const data = {
    meta: { subtitle: `${clip.name}  ${debug.fmt(winStartBeat, 1)}–${debug.fmt(winEndBeat, 1)}` },
    envelope: prep.envelope,
    // RMS noise floor scaled toward full-scale for a rough canvas reference line
    noiseFloorLevel: Math.min(1, prep.noiseFloor * 4),
    candidates: prep.candidates,
    defaults: settings,
  };
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const html = popupHtml.replace("__DATA__", json);

  let resultStr: string;
  try {
    resultStr = await context.ui.showModalDialog(`data:text/html,${encodeURIComponent(html)}`, 560, 470);
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

// Headless command: run the chosen portions with the last-saved settings, no popup.
export async function runHeadless(context: Ctx, target: Target, portions: Portions): Promise<void> {
  const { clip, track } = target;
  const settings = await loadSettings(context.environment.storageDirectory);
  const prep = await prepare(context, target, false);

  const sel = computeSelection(prep.candidates, settings, portions);
  if (!sel.cutBeats.length) {
    console.log(`[clipify] "${clip.name}": nothing to do.`);
    return;
  }
  // a strip needs an action; if the saved one is "off", fall back to a safe deactivate
  const stripAction = portions.strip
    ? settings.strip === "off"
      ? "deactivate"
      : settings.strip
    : "off";

  await applyCuts(context, track, {
    action: "apply",
    cutBeats: sel.cutBeats,
    strips: sel.strips,
    stripAction,
  });
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
    // withinTransaction is synchronous (no awaiting inside), so to group ops into one
    // undo step we initiate them all and return Promise.all. Splits are one step;
    // the strip is a second step (it needs the post-split clips, so it can't share
    // the transaction — collapsing only works without an await between them).
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

    await update(`${action === "delete" ? "Deleting" : "Deactivating"} ${strips.length} silence region(s)…`, 80);
    // the silence clips now exist; resolve them by start beat
    const clips = strips
      .map((r) => {
        const c = findClipAt(track, r.start);
        if (!c) console.error(`[clipify] no clip to strip @ ${debug.fmt(r.start)}`);
        return c;
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    if (action === "delete") {
      // all deletes in one transaction → one undo step
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
      // mutes are synchronous → one transaction, one undo step
      context.withinTransaction(() => {
        for (const c of clips) c.muted = true;
      });
    }
  });
}

function findClipAt(track: AudioTrack<"1.0.0">, beat: number) {
  return [...track.arrangementClips].find((c) => Math.abs(c.startTime - beat) < 1e-3) ?? null;
}
