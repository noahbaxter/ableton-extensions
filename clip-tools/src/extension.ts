import {
  initialize,
  AudioClip,
  AudioTrack,
  type ActivationContext,
  type DataModelObject,
  type Handle,
} from "@ableton-extensions/sdk";

import * as fs from "node:fs/promises";

import { detectSoundSegments, paramsForSensitivity } from "./silence.js";
import { buildWarpMap } from "./warp.js";
import { planPieces } from "./plan.js";

// Loaded lazily so a heavy/failing decoder import can never block activation.
async function decode(filePath: string) {
  const { default: decodeAudio } = await import("audio-decode");
  return decodeAudio(await fs.readFile(filePath));
}

// ---------------------------------------------------------------------------
// "SLICE AT GAPS" — right-click an audio clip.
//
// Splits the clip into contiguous pieces at the quiet gaps between phrases.
// Nothing is removed: cuts land in the MIDDLE of each gap, so every piece keeps
// its audio (plus a little silence padding) and the timeline stays fully tiled
// in its original position. File<->beat mapping uses the clip's warp markers
// (real, possibly non-linear), falling back to constant tempo when unwarped.
// ---------------------------------------------------------------------------

const SENSITIVITY_LEVELS = [
  { id: "clip-tools.slice.gentle", label: "SLICE AT GAPS (GENTLE)", sensitivity: 0.75 },
  { id: "clip-tools.slice.medium", label: "SLICE AT GAPS (MEDIUM)", sensitivity: 0.9 },
  { id: "clip-tools.slice.aggressive", label: "SLICE AT GAPS (AGGRESSIVE)", sensitivity: 0.99 },
] as const;

type Ctx = ReturnType<typeof initialize>;

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");

  for (const level of SENSITIVITY_LEVELS) {
    context.commands.registerCommand(level.id, (arg: unknown) => {
      void sliceClip(context, arg as Handle, level.sensitivity).catch((e) =>
        console.error("[clip-tools] slice failed:", e),
      );
    });
    context.ui.registerContextMenuAction("AudioClip", level.label, level.id);
  }
}

/** Walk up the object hierarchy until we hit the owning AudioTrack. */
function resolveTrack(obj: DataModelObject<"1.0.0">): AudioTrack<"1.0.0"> | null {
  let cur: DataModelObject<"1.0.0"> | null = obj.parent;
  while (cur) {
    if (cur instanceof AudioTrack) return cur;
    cur = cur.parent;
  }
  return null;
}

async function sliceClip(context: Ctx, handle: Handle, sensitivity: number) {
  const clip = context.getObjectFromHandle(handle, AudioClip);
  const track = resolveTrack(clip);
  if (!track) {
    console.error(`[clip-tools] couldn't find the AudioTrack owning clip "${clip.name}".`);
    return;
  }

  const secPerBeat = 60 / context.application.song.tempo;
  const decoded = await decode(clip.filePath);
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) =>
    decoded.getChannelData(i),
  );

  const warp = buildWarpMap(clip.warpMarkers, decoded.sampleRate, decoded.duration, secPerBeat);
  const sounds = detectSoundSegments(
    channels,
    decoded.sampleRate,
    paramsForSensitivity(sensitivity),
  );
  const pieces = planPieces(sounds, {
    startSec: warp.beatToSec(clip.startMarker),
    endSec: warp.beatToSec(clip.endMarker),
    startTime: clip.startTime,
    startMarker: clip.startMarker,
    filePath: clip.filePath,
  }, warp.secToBeat);

  if (pieces.length < 2) {
    console.log(`[clip-tools] "${clip.name}": no gaps to cut at this sensitivity.`);
    return;
  }
  console.log(`[clip-tools] Slicing "${clip.name}" into ${pieces.length} clips.`);

  // Documented transaction form: a synchronous withinTransaction callback that
  // dispatches the clear + every create up front and returns a single
  // Promise.all (awaited via the dialog). createAudioTrack groups into one undo
  // step this way; createAudioClip does NOT yet (confirmed beta.0 SDK limitation
  // — audio clip creation can't collapse, MIDI clips can), so this currently
  // yields N+1 undo steps and becomes one for free once the SDK is fixed.
  // withinProgressDialog here is only the progress UI, not undo-related.
  const isWarped = clip.warping;
  await context.ui.withinProgressDialog("Slicing clip…", {}, async (update) => {
    await update(`Slicing into ${pieces.length} clips…`, 50);
    await context.withinTransaction(() =>
      Promise.all([
        track.clearClipsInRange(clip.startTime, clip.endTime),
        ...pieces.map((p, i) =>
          track
            .createAudioClip({
              filePath: p.filePath,
              startTime: p.startTime,
              duration: p.duration,
              isWarped,
              loopSettings: {
                looping: isWarped,
                startMarker: p.startMarker,
                endMarker: p.endMarker,
                loopStart: p.startMarker,
                loopEnd: p.endMarker,
              },
            })
            .catch((e: unknown) => {
              console.error(`[clip-tools] piece #${i} failed:`, e);
              return null;
            }),
        ),
      ]),
    );
  });
}
