import {
  initialize,
  AudioClip,
  AudioTrack,
  DataModelObject,
  type ActivationContext,
  type ArrangementSelection,
} from "@ableton-extensions/sdk";

import { runSliceStrip, runHeadless, type Target } from "./slicer.js";
import type { Portions } from "./select.js";
import { splitAtZeroCrossing } from "./splitZero.js";

type Ctx = ReturnType<typeof initialize>;

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");

  // Interactive Slice & Strip popup — windowed to the time selection, across every
  // clip it overlaps
  registerClipifyCommand(context, "clipify.sliceStrip", "Config", (targets) =>
    runSliceStrip(context, targets),
  );

  // Headless commands — apply the portion(s) with the last-saved settings, no popup
  const headless: { id: string; label: string; portions: Portions }[] = [
    { id: "clipify.split", label: "Slice", portions: { split: true, strip: false } },
    { id: "clipify.strip", label: "Strip", portions: { split: false, strip: true } },
    { id: "clipify.quick", label: "Auto", portions: { split: true, strip: true } },
  ];
  for (const { id, label, portions } of headless) {
    registerClipifyCommand(context, id, label, (targets) => runHeadless(context, targets, portions));
  }

  // Standalone split at nearest zero crossing — cursor only, not a time range
  context.commands.registerCommand("clipify.splitZero", (arg: unknown) => {
    const sel = asSelection(arg);
    if (!sel || sel.time_selection_end > sel.time_selection_start) return; // range → ignore
    const hit = clipUnderCursor(context, sel);
    if (hit) {
      void splitAtZeroCrossing(context, hit.clip, hit.track, hit.point).catch((e) =>
        console.error("[clipify] splitZero:", fmtErr(e)),
      );
    }
  });
  context.ui.registerContextMenuAction(
    "AudioTrack.ArrangementSelection",
    "Split 0-cross",
    "clipify.splitZero",
  );
}

// Register a command once, on the arrangement time-selection scope. One menu entry,
// unified behaviour: a time selection windows the action; just a cursor (no range)
// targets the whole clip.
function registerClipifyCommand(
  context: Ctx,
  id: string,
  label: string,
  run: (targets: Target[]) => Promise<void>,
): void {
  context.commands.registerCommand(id, (arg: unknown) => {
    const targets = resolveTargets(context, arg);
    console.log(`[clipify] ${id}: ${targets.length} target(s)`);
    if (targets.length) void run(targets).catch((e) => console.error(`[clipify] ${id}:`, fmtErr(e)));
  });
  context.ui.registerContextMenuAction("AudioTrack.ArrangementSelection", label, id);
}

// console.error on a raw rejection prints "undefined" when the value isn't an Error;
// surface the type/stack so failures are diagnosable.
function fmtErr(e: unknown): string {
  return e instanceof Error ? (e.stack ?? e.message) : `non-Error rejection: ${typeof e} → ${String(e)}`;
}

function asSelection(arg: unknown): ArrangementSelection | null {
  return arg && typeof arg === "object" && "time_selection_start" in arg
    ? (arg as ArrangementSelection)
    : null;
}

// The audio clip under the selection's cursor (time_selection_start). Works with
// just a cursor — no range needed; only fails if the cursor isn't on an audio clip.
function clipUnderCursor(
  context: Ctx,
  sel: ArrangementSelection,
): { track: AudioTrack<"1.0.0">; clip: AudioClip<"1.0.0">; point: number } | null {
  const point = sel.time_selection_start;
  const tracks = sel.selected_lanes
    .map((h) => context.getObjectFromHandle(h, DataModelObject))
    .filter((o): o is AudioTrack<"1.0.0"> => o instanceof AudioTrack);

  for (const track of tracks) {
    const clip = [...track.arrangementClips].find(
      (c): c is AudioClip<"1.0.0"> =>
        c instanceof AudioClip && c.startTime <= point && c.endTime >= point + 1e-4,
    );
    if (clip) return { track, clip, point };
  }
  console.log("[clipify] Place the cursor on an audio clip.");
  return null;
}

// Clipify needs a real time selection. Every audio clip the selection overlaps
// becomes a target, each windowed to the intersection — so a selection that starts
// or ends in empty space, or spans several clips, still works. (Selecting a clip
// head selects its full range → that one clip.) A bare cursor does nothing here;
// that's what Split at Nearest 0 Crossing is for.
function resolveTargets(context: Ctx, arg: unknown): Target[] {
  const sel = asSelection(arg);
  if (!sel || !(sel.time_selection_end > sel.time_selection_start)) return [];
  const start = sel.time_selection_start;
  const end = sel.time_selection_end;

  const tracks = sel.selected_lanes
    .map((h) => context.getObjectFromHandle(h, DataModelObject))
    .filter((o): o is AudioTrack<"1.0.0"> => o instanceof AudioTrack);

  const targets: Target[] = [];
  for (const track of tracks) {
    for (const clip of track.arrangementClips) {
      if (clip instanceof AudioClip && clip.endTime > start && clip.startTime < end) {
        targets.push({
          clip,
          track,
          winStartBeat: Math.max(clip.startTime, start),
          winEndBeat: Math.min(clip.endTime, end),
        });
      }
    }
  }
  targets.sort((a, b) => a.winStartBeat - b.winStartBeat);
  if (!targets.length) console.log("[clipify] No audio clip in the time selection.");
  return targets;
}
