import {
  initialize,
  AudioClip,
  AudioTrack,
  type ActivationContext,
  type DataModelObject,
  type Handle,
} from "@ableton-extensions/sdk";

import * as fs from "node:fs/promises";

import { detectSoundSegments } from "./silence.js";
import { buildWarpMap } from "./warp.js";
import { planPieces } from "./plan.js";

// Verbose evaluation logging (detection levels, gap distribution, read-back).
// Flip to false once the grain/detection tuning feels right.
const DEBUG = true;
const dbg = (...a: unknown[]) => {
  if (DEBUG) console.log("[clip-tools]", ...a);
};
const f = (n: number, d = 3) => n.toFixed(d);
const db = (linear: number) => (linear > 0 ? 20 * Math.log10(linear) : -Infinity);

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

// Each level is a keepFraction (see planPieces): the fraction of gaps that
// become cuts, largest first. Higher = more slices. Tuning knobs — counts
// depend on the clip's own gap structure, not a fixed number.
const GRAIN_LEVELS = [
  { id: "clip-tools.slice.gentle", label: "SLICE AT GAPS (GENTLE)", keepFraction: 0.15 },
  { id: "clip-tools.slice.medium", label: "SLICE AT GAPS (MEDIUM)", keepFraction: 0.45 },
  { id: "clip-tools.slice.aggressive", label: "SLICE AT GAPS (AGGRESSIVE)", keepFraction: 1.0 },
] as const;

type Ctx = ReturnType<typeof initialize>;

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");

  for (const level of GRAIN_LEVELS) {
    context.commands.registerCommand(level.id, (arg: unknown) => {
      void sliceClip(context, arg as Handle, level.keepFraction).catch((e) =>
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

async function sliceClip(context: Ctx, handle: Handle, keepFraction: number) {
  const clip = context.getObjectFromHandle(handle, AudioClip);
  const track = resolveTrack(clip);
  if (!track) {
    console.error(`[clip-tools] couldn't find the AudioTrack owning clip "${clip.name}".`);
    return;
  }

  // Cache anything we log AFTER the clear: clearClipsInRange removes this clip,
  // so the handle is dangling by read-back time and its getters throw.
  const clipName = clip.name;

  const secPerBeat = 60 / context.application.song.tempo;
  const decoded = await decode(clip.filePath);
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) =>
    decoded.getChannelData(i),
  );

  const warp = buildWarpMap(clip.warpMarkers, decoded.sampleRate, decoded.duration, secPerBeat);

  // Two coordinate systems for the new pieces' markers, chosen by warp state:
  //
  //  - Warped clip: the real warp markers give the (possibly non-linear)
  //    seconds<->beat map, and content beats align to arrangement beats 1:1.
  //
  //  - Unwarped clip: read-back PROVES Live places a new unwarped clip's beat-0
  //    warp marker at the FILE-SECOND equal to the startMarker value we pass
  //    (send 8.195 → warp marker lands at 8.195s). So for unwarped clips the
  //    marker value is literally a file-second, not a beat in any tempo grid.
  //    Pass seconds directly (identity). buildWarpMap / the clip's own native
  //    beat grid (e.g. 32 beats over 21.943s) is only used to locate the content
  //    WINDOW in seconds; it must NOT scale the marker values, or Live reads the
  //    too-large beat numbers as seconds past the file end and clamps + stretches.
  const arrSpan = clip.endTime - clip.startTime;
  const markerSpan = clip.endMarker - clip.startMarker;

  let secToMarker: (s: number) => number;
  let markerToSec: (m: number) => number;
  let markerToArrangement: number;
  if (clip.warping) {
    secToMarker = warp.secToBeat;
    markerToSec = warp.beatToSec;
    markerToArrangement = markerSpan !== 0 ? arrSpan / markerSpan : 1;
  } else {
    // Geometry maps the clip's native markers -> the file-seconds it plays, just
    // to bound the detection window; the new pieces' markers are plain seconds.
    const secPerMarker = markerSpan !== 0 ? (arrSpan * secPerBeat) / markerSpan : secPerBeat;
    markerToSec = (m) => m * secPerMarker;
    secToMarker = (s) => s; // marker value == file second
    markerToArrangement = 1 / secPerBeat; // arrangement beats per content second
  }

  const startSec = markerToSec(clip.startMarker);
  const endSec = markerToSec(clip.endMarker);
  const detection = detectSoundSegments(channels, decoded.sampleRate);
  const { pieces, gaps } = planPieces(
    detection.segments,
    {
      startSec,
      endSec,
      startTime: clip.startTime,
      startMarker: secToMarker(startSec),
      markerToArrangement,
      filePath: clip.filePath,
    },
    secToMarker,
    keepFraction,
  );

  // ---- evaluation logging ------------------------------------------------
  dbg(`"${clip.name}" keepFraction=${keepFraction}`);
  dbg(
    `  geom: warping=${clip.warping}  ` +
      `mapping=${clip.warping ? "warp-beats" : "seconds-as-markers"}  ` +
      `arr ${f(clip.startTime)}..${f(clip.endTime)}  markers ${f(clip.startMarker)}..${f(clip.endMarker)}  ` +
      `file ${f(decoded.duration)}s  window-sec ${f(startSec)}..${f(endSec)}  ` +
      `markerToArr=${f(markerToArrangement)}`,
  );
  dbg(
    `  detect: floor ${f(db(detection.noiseFloor), 1)}dB  ` +
      `threshold ${f(db(detection.threshold), 1)}dB  ` +
      `${detection.segments.length} sound segments → ${gaps.length} gaps`,
  );
  if (gaps.length) {
    const cut = gaps.filter((g) => g.kept).length;
    const sorted = [...gaps].sort((a, b) => b.durSec - a.durSec);
    dbg(
      `  cuts: ${cut}/${gaps.length} gaps kept → ${pieces.length} pieces. ` +
        `gap durations (s, desc): ${sorted.map((g) => (g.kept ? "▸" : "") + f(g.durSec, 2)).join(" ")}`,
    );
  }

  if (pieces.length < 2) {
    console.log(`[clip-tools] "${clip.name}": no gaps to cut at this grain.`);
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
    const results = await context.withinTransaction(() =>
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

    // ---- read back: intended vs what Live actually created (warp correctness) ----
    // global = arrangement position; in-clip = content offset into the sample.
    // A "✗" flags where the two diverge (the start-marker shuffle bug).
    if (DEBUG) {
      const created = results.slice(1) as (AudioClip<"1.0.0"> | null)[];
      dbg(`read-back "${clipName}" (intended → actual):`);
      created.forEach((c, i) => {
        const p = pieces[i]!;
        if (!c) return dbg(`  [${i}] FAILED`);
        const ok = Math.abs(c.startMarker - p.startMarker) < 1e-3;
        // The created clip's OWN ratio (arr duration / marker span) reveals which
        // beat grid Live actually gave it — the missing fact for the marker units.
        const cMarkerSpan = c.endMarker - c.startMarker;
        const cRatio = cMarkerSpan !== 0 ? c.duration / cMarkerSpan : NaN;
        dbg(
          `  [${i}] ${ok ? "✓" : "✗"} global-start ${f(p.startTime)}→${f(c.startTime)}  ` +
            `in-clip-start ${f(p.startMarker)}→${f(c.startMarker)}  ` +
            `(in-clip-end ${f(p.endMarker)}→${f(c.endMarker)}  dur ${f(p.duration)}→${f(c.duration)})  ` +
            `[new clip: warping=${c.warping} dur/markerSpan=${f(cRatio)} ` +
            `loop=${c.looping}/${f(c.loopStart)}..${f(c.loopEnd)} ` +
            `wm=${c.warpMarkers.map((m) => `(${f(m.sampleTime)},${f(m.beatTime)})`).join("")}]`,
        );
      });
    }
  });
}
