import {
  initialize,
  AudioClip,
  AudioTrack,
  DataModelObject,
  type ActivationContext,
  type ArrangementSelection,
  type Handle,
} from "@ableton-extensions/sdk";

import { runSliceStrip, type Target } from "./slicer.js";
import { splitAtZeroCrossing } from "./splitZero.js";

type Ctx = ReturnType<typeof initialize>;

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");

  // Slice & Strip popup — from a clip or a time selection within one
  context.commands.registerCommand("clipify.sliceStrip", (arg: unknown) => {
    const target = resolveTarget(context, arg);
    if (target) void runSliceStrip(context, target).catch((e) => console.error("[clipify]", e));
  });
  context.ui.registerContextMenuAction("AudioClip", "Clipify…", "clipify.sliceStrip");
  context.ui.registerContextMenuAction(
    "AudioTrack.ArrangementSelection",
    "Clipify…",
    "clipify.sliceStrip",
  );

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

function walkToTrack(obj: DataModelObject<"1.0.0">): AudioTrack<"1.0.0"> | null {
  let cur: DataModelObject<"1.0.0"> | null = obj.parent;
  while (cur) {
    if (cur instanceof AudioTrack) return cur;
    cur = cur.parent;
  }
  return null;
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

// Either a time selection (window to the range, or the whole clip if just a
// cursor) or a clip handle (whole clip).
function resolveTarget(context: Ctx, arg: unknown): Target | null {
  const sel = asSelection(arg);
  if (sel) {
    const hit = clipUnderCursor(context, sel);
    if (!hit) return null;
    const { clip, track } = hit;
    const hasRange = sel.time_selection_end > sel.time_selection_start;
    return {
      clip,
      track,
      winStartBeat: hasRange ? Math.max(clip.startTime, sel.time_selection_start) : clip.startTime,
      winEndBeat: hasRange ? Math.min(clip.endTime, sel.time_selection_end) : clip.endTime,
    };
  }

  const clip = context.getObjectFromHandle(arg as Handle, AudioClip);
  const track = walkToTrack(clip);
  if (!track) {
    console.error(`[clipify] couldn't find the AudioTrack owning clip "${clip.name}".`);
    return null;
  }
  return { clip, track, winStartBeat: clip.startTime, winEndBeat: clip.endTime };
}
