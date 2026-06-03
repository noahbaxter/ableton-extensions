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

  // Interactive Slice & Strip popup — whole clip, or windowed to a time selection
  registerClipifyCommand(context, "clipify.sliceStrip", "Clipify…", (target) =>
    runSliceStrip(context, target),
  );

  // Headless commands — apply the portion(s) with the last-saved settings, no popup
  const headless: { id: string; label: string; portions: Portions }[] = [
    { id: "clipify.split", label: "Clipify – Split", portions: { split: true, strip: false } },
    { id: "clipify.strip", label: "Clipify – Strip", portions: { split: false, strip: true } },
    { id: "clipify.quick", label: "Clipify Quick", portions: { split: true, strip: true } },
  ];
  for (const { id, label, portions } of headless) {
    registerClipifyCommand(context, id, label, (target) => runHeadless(context, target, portions));
  }

  // Standalone split at nearest zero crossing — cursor only, not a time range
  context.commands.registerCommand("clipify.splitZero", (arg: unknown) => {
    const sel = asSelection(arg);
    if (!sel || sel.time_selection_end > sel.time_selection_start) return; // range → ignore
    const hit = clipUnderCursor(context, sel);
    if (hit) {
      void splitAtZeroCrossing(context, hit.clip, hit.track, hit.point).catch((e) =>
        console.error("[clipify]", e),
      );
    }
  });
  context.ui.registerContextMenuAction(
    "AudioTrack.ArrangementSelection",
    "Split at Nearest 0 Crossing",
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
  run: (target: Target) => Promise<void>,
): void {
  context.commands.registerCommand(id, (arg: unknown) => {
    const target = resolveTarget(context, arg);
    if (target) void run(target).catch((e) => console.error("[clipify]", e));
  });
  context.ui.registerContextMenuAction("AudioTrack.ArrangementSelection", label, id);
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

// Clipify needs a real time selection — windowed to its range (selecting the clip
// head gives the whole clip). A bare cursor (no range) does nothing here; that's
// what Split at Nearest 0 Crossing is for.
function resolveTarget(context: Ctx, arg: unknown): Target | null {
  const sel = asSelection(arg);
  if (!sel || !(sel.time_selection_end > sel.time_selection_start)) return null;
  const hit = clipUnderCursor(context, sel);
  if (!hit) return null;
  const { clip, track } = hit;
  return {
    clip,
    track,
    winStartBeat: Math.max(clip.startTime, sel.time_selection_start),
    winEndBeat: Math.min(clip.endTime, sel.time_selection_end),
  };
}
