// Get a track's audio for analysis. Installed extensions run under Node's
// filesystem permission sandbox, so reading a clip's source file (clip.filePath)
// is denied — only host-sanctioned dirs are allowed. renderPreFxAudio writes a WAV
// into the extension's own temp directory, which we CAN read, so all audio
// analysis goes through here.
//
// Bonus: the rendered audio is already in arrangement time (warp/fades/clip-gain
// baked in), so file-second↔beat mapping collapses to a linear rate at the current
// tempo — no warp curve, no per-clip mapping.

import { initialize, AudioTrack } from "@ableton-extensions/sdk";

import * as fs from "node:fs/promises";

type Ctx = ReturnType<typeof initialize>;

export interface RenderedAudio {
  channels: Float32Array[];
  sampleRate: number;
  durSec: number; // length of the rendered window, seconds
}

// Render [startBeat, endBeat) of the track's pre-FX arrangement audio and decode it.
// The returned buffer represents exactly that beat window; local second 0 is
// startBeat. Map back with: beat = startBeat + localSec * tempo / 60.
export async function renderWindow(
  context: Ctx,
  track: AudioTrack<"1.0.0">,
  startBeat: number,
  endBeat: number,
): Promise<RenderedAudio> {
  const wavPath = await context.resources.renderPreFxAudio(track, startBeat, endBeat);
  const { default: decodeAudio } = await import("audio-decode");
  const decoded = await decodeAudio(await fs.readFile(wavPath));
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) =>
    decoded.getChannelData(i),
  );
  return {
    channels,
    sampleRate: decoded.sampleRate,
    durSec: (channels[0]?.length ?? 0) / decoded.sampleRate,
  };
}
