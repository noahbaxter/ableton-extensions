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
import { planPieces } from "./plan.js";

// Evaluation logging (detection levels, gap distribution, create read-back).
// Flip to false once placement is solid for both warped and unwarped clips.
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
// in its original position. New-piece markers are passed as file-seconds; see
// the mapping note below and CUT_DETECTION_STRATEGY.md.
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

  const secPerBeat = 60 / context.application.song.tempo;
  const decoded = await decode(clip.filePath);
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) =>
    decoded.getChannelData(i),
  );

  // New-piece markers are passed as plain FILE-SECONDS (identity): read-back
  // proves Live anchors a new clip's beat-0 warp marker at the file-second equal
  // to the startMarker value we pass, so the marker is a second, not a beat in
  // any tempo grid. The clip's geometry only maps its native markers -> the
  // file-seconds it plays, to bound the detection window. (Warped clips still
  // mis-play because Live auto-warps the new clip — see CUT_DETECTION_STRATEGY.md.)
  const arrSpan = clip.endTime - clip.startTime;
  const markerSpan = clip.endMarker - clip.startMarker;
  const secPerMarker = markerSpan !== 0 ? (arrSpan * secPerBeat) / markerSpan : secPerBeat;
  const markerToSec = (m: number) => m * secPerMarker;
  const secToMarker = (s: number) => s; // marker value == file second
  const markerToArrangement = 1 / secPerBeat; // arrangement beats per content second

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
  dbg(
    `slice "${clip.name}" keepFraction=${keepFraction}  warping=${clip.warping}  ` +
      `arr ${f(clip.startTime)}..${f(clip.endTime)}  markers ${f(clip.startMarker)}..${f(clip.endMarker)}  ` +
      `file ${f(decoded.duration)}s  window-sec ${f(startSec)}..${f(endSec)}`,
  );
  dbg(
    `  detect: floor ${f(db(detection.noiseFloor), 1)}dB threshold ${f(db(detection.threshold), 1)}dB  ` +
      `${detection.segments.length} segments → ${gaps.length} gaps`,
  );
  if (gaps.length) {
    const sorted = [...gaps].sort((a, b) => b.durSec - a.durSec);
    dbg(
      `  cuts: ${gaps.filter((g) => g.kept).length}/${gaps.length} kept → ${pieces.length} pieces  ` +
        `gaps(s): ${sorted.map((g) => (g.kept ? "▸" : "") + f(g.durSec, 2)).join(" ")}`,
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
  // Always CREATE unwarped: that path places the right content at the right spot
  // (markers == file-seconds, file tempo preserved). Creating warped instead lets
  // Live auto-warp the new clip to a bogus grid and misread our second-markers.
  // For a warped source we then flip warp back ON per piece — enabling warp on an
  // already-correct clip changes tempo-follow, not which audio region it plays.
  const sourceWarped = clip.warping;
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
              isWarped: false,
              loopSettings: {
                looping: false,
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
    const created = results.slice(1) as (AudioClip<"1.0.0"> | null)[];

    // Restore warp on the (correctly-placed) unwarped pieces for a warped source.
    if (sourceWarped) {
      await update("Restoring warp…", 80);
      await context.withinTransaction(() => {
        for (const c of created) if (c) c.warping = true;
        return Promise.resolve();
      });
    }

    // ---- read back: intended vs what Live actually created ----
    // in-clip = content offset into the sample. "✗" = markers diverge. The new
    // clip's warp markers (wm) reveal the grid Live assigned — the key signal for
    // the warped case, where Live auto-warps and our second-markers get misread.
    if (DEBUG) {
      dbg(`  read-back (intended → actual):`);
      created.forEach((c, i) => {
        const p = pieces[i]!;
        if (!c) return dbg(`    [${i}] FAILED`);
        const ok = Math.abs(c.startMarker - p.startMarker) < 1e-3 ? "✓" : "✗";
        dbg(
          `    [${i}] ${ok} arr ${f(p.startTime)}→${f(c.startTime)}  ` +
            `in-clip ${f(p.startMarker)}→${f(c.startMarker)}..${f(c.endMarker)}  ` +
            `[new warp=${c.warping} wm=${c.warpMarkers.map((m) => `(${f(m.sampleTime, 2)},${f(m.beatTime, 2)})`).join("")}]`,
        );
      });
    }
  });
}
