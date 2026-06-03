// Standalone "Split at nearest 0 crossing": split a clip at one point (the time
// selection start), snapped to the nearest zero crossing so the cut is clean.

import { initialize, AudioClip, AudioTrack } from "@ableton-extensions/sdk";

import { renderWindow } from "./render.js";
import { snapToZeroCrossing } from "./zeroCross.js";
import { debug } from "./debug.js";

type Ctx = ReturnType<typeof initialize>;

const MARGIN_SEC = 0.05; // render this much each side of the cursor — room for the ±5ms snap

export async function splitAtZeroCrossing(
  context: Ctx,
  clip: AudioClip<"1.0.0">,
  track: AudioTrack<"1.0.0">,
  splitBeat: number,
): Promise<void> {
  const beatPerSec = context.application.song.tempo / 60;
  const marginBeats = MARGIN_SEC * beatPerSec;
  const renderStart = Math.max(clip.startTime, splitBeat - marginBeats);
  const renderEnd = Math.min(clip.endTime, splitBeat + marginBeats);

  const { channels, sampleRate } = await renderWindow(context, track, renderStart, renderEnd);

  const cursorSec = (splitBeat - renderStart) / beatPerSec; // cursor's offset into the render
  const snappedSec = snapToZeroCrossing(channels, sampleRate, cursorSec);
  const snappedBeat = renderStart + snappedSec * beatPerSec;

  debug.log(
    `split-zero "${clip.name}" beat ${debug.fmt(splitBeat)} -> ${debug.fmt(snappedBeat)} ` +
      `(local sec ${debug.fmt(cursorSec)} -> ${debug.fmt(snappedSec)})`,
  );

  await context.withinTransaction(() => track.clearClipsInRange(snappedBeat, snappedBeat));
}
