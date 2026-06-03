// Standalone "Split at nearest 0 crossing": split a clip at one point (the time
// selection start), snapped to the nearest zero crossing so the cut is clean.

import { initialize, AudioClip, AudioTrack } from "@ableton-extensions/sdk";

import * as fs from "node:fs/promises";

import { buildClipMapping } from "./mapping.js";
import { snapToZeroCrossing } from "./zeroCross.js";
import { debug } from "./debug.js";

type Ctx = ReturnType<typeof initialize>;

async function decode(filePath: string) {
  const { default: decodeAudio } = await import("audio-decode");
  return decodeAudio(await fs.readFile(filePath));
}

export async function splitAtZeroCrossing(
  context: Ctx,
  clip: AudioClip<"1.0.0">,
  track: AudioTrack<"1.0.0">,
  splitBeat: number,
): Promise<void> {
  const decoded = await decode(clip.filePath);
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) =>
    decoded.getChannelData(i),
  );

  const { secToArrBeat, beatToClipSec } = buildClipMapping(clip, context.application.song.tempo);
  const splitSec = beatToClipSec(splitBeat);
  const snappedSec = snapToZeroCrossing(channels, decoded.sampleRate, splitSec);
  const snappedBeat = secToArrBeat(snappedSec);

  debug.log(
    `split-zero "${clip.name}" beat ${debug.fmt(splitBeat)} -> ${debug.fmt(snappedBeat)} ` +
      `(sec ${debug.fmt(splitSec)} -> ${debug.fmt(snappedSec)})`,
  );

  await context.withinTransaction(() => track.clearClipsInRange(snappedBeat, snappedBeat));
}
