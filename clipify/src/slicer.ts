// "Slice at gaps": split an audio clip into separate clips at the quiet gaps
// between phrases, in place. A cut lands in the MIDDLE of each gap, so every piece
// keeps its audio (plus padding) and the timeline stays tiled. The split is
// clearClipsInRange(t, t) — a zero-width clear — so each piece keeps the original
// clip's warp, fades, and gain.

import {
  initialize,
  AudioClip,
  AudioTrack,
  type DataModelObject,
  type Handle,
} from "@ableton-extensions/sdk";

import * as fs from "node:fs/promises";

import { detectSoundSegments, type Detection } from "./silence.js";
import { planCuts } from "./plan.js";
import { buildWarpMap } from "./warp.js";
import { debug } from "./debug.js";

type Ctx = ReturnType<typeof initialize>;

const MIN_WARP_MARKERS = 2; // fewer than this = treat as unwarped (constant rate)

// lazy import so a heavy/failing decoder can't block activation
async function decode(filePath: string) {
  const { default: decodeAudio } = await import("audio-decode");
  return decodeAudio(await fs.readFile(filePath));
}

function resolveTrack(obj: DataModelObject<"1.0.0">): AudioTrack<"1.0.0"> | null {
  let cur: DataModelObject<"1.0.0"> | null = obj.parent;
  while (cur) {
    if (cur instanceof AudioTrack) return cur;
    cur = cur.parent;
  }
  return null;
}

// the clip's file window plus a file-second -> arrangement-beat mapping
interface CutMapping {
  startSec: number;
  endSec: number;
  secToArrBeat: (s: number) => number;
}

export class ClipSlicer {
  private readonly clip: AudioClip<"1.0.0">;
  private readonly track: AudioTrack<"1.0.0"> | null;

  constructor(
    private readonly context: Ctx,
    handle: Handle,
    private readonly keepFraction: number,
  ) {
    this.clip = context.getObjectFromHandle(handle, AudioClip);
    this.track = resolveTrack(this.clip);
  }

  async run(): Promise<void> {
    const { clip, track } = this;
    if (!track) {
      console.error(`[clip-tools] couldn't find the AudioTrack owning clip "${clip.name}".`);
      return;
    }

    const decoded = await decode(clip.filePath);
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) =>
      decoded.getChannelData(i),
    );

    const map = this.buildMapping();
    const detection = detectSoundSegments(channels, decoded.sampleRate);
    const { cutBeats, gaps } = planCuts(
      detection.segments,
      map.startSec,
      map.endSec,
      map.secToArrBeat,
      this.keepFraction,
    );

    this.logEvaluation(decoded.duration, map, detection, gaps, cutBeats);

    if (cutBeats.length === 0) {
      console.log(`[clip-tools] "${clip.name}": no gaps to cut at this grain.`);
      return;
    }
    console.log(`[clip-tools] Slicing "${clip.name}" into ${cutBeats.length + 1} clips.`);
    await this.split(track, cutBeats);
  }

  // file-second -> arrangement-beat. The clip plays file region [startSec, endSec];
  // unwarped advances at a constant rate, warped follows the clip's warp curve
  // (anchored to the clip's endpoints). Cuts on heavy non-linear warp are approximate.
  private buildMapping(): CutMapping {
    const { clip } = this;
    const secPerBeat = 60 / this.context.application.song.tempo;
    const arrSpan = clip.endTime - clip.startTime;
    const markerSpan = clip.endMarker - clip.startMarker;
    const secPerMarker = markerSpan !== 0 ? (arrSpan * secPerBeat) / markerSpan : secPerBeat;
    const startSec = clip.startMarker * secPerMarker;
    const endSec = clip.endMarker * secPerMarker;

    const useWarp = clip.warping && clip.warpMarkers.length >= MIN_WARP_MARKERS;
    const warp = buildWarpMap(
      clip.warpMarkers,
      secPerBeat,
      useWarp ? [{ sec: startSec, beat: 0 }, { sec: endSec, beat: arrSpan }] : undefined,
    );
    const secToArrBeat = useWarp
      ? (s: number) => clip.startTime + (warp.secToBeat(s) - warp.secToBeat(startSec))
      : (s: number) => clip.startTime + (s - startSec) / secPerBeat;

    return { startSec, endSec, secToArrBeat };
  }

  private async split(track: AudioTrack<"1.0.0">, cutBeats: number[]): Promise<void> {
    const { context } = this;
    await context.ui.withinProgressDialog("Slicing clip…", {}, async (update) => {
      await update(`Splitting at ${cutBeats.length} points…`, 50);
      await context.withinTransaction(() =>
        Promise.all(
          cutBeats.map((b) =>
            track.clearClipsInRange(b, b).catch((e: unknown) => {
              console.error(`[clip-tools] split @ ${debug.fmt(b)} failed:`, e);
              return null;
            }),
          ),
        ),
      );
    });
  }

  // detection levels + gap distribution to evaluate a slice
  private logEvaluation(
    fileDur: number,
    map: CutMapping,
    detection: Detection,
    gaps: { durSec: number; kept: boolean }[],
    cutBeats: number[],
  ): void {
    if (!debug.enabled) return;
    const { clip } = this;
    debug.log(
      `slice "${clip.name}" keepFraction=${this.keepFraction}  warping=${clip.warping}  ` +
        `arr ${debug.fmt(clip.startTime)}..${debug.fmt(clip.endTime)}  ` +
        `window-sec ${debug.fmt(map.startSec)}..${debug.fmt(map.endSec)}  file ${debug.fmt(fileDur)}s`,
    );
    debug.log(
      `  detect: floor ${debug.db(detection.noiseFloor)}dB threshold ${debug.db(detection.threshold)}dB  ` +
        `${detection.segments.length} segments → ${gaps.length} gaps`,
    );
    if (gaps.length) {
      const sorted = [...gaps].sort((a, b) => b.durSec - a.durSec);
      debug.log(
        `  cuts: ${gaps.filter((g) => g.kept).length}/${gaps.length} kept → ${cutBeats.length + 1} pieces  ` +
          `gaps(s): ${sorted.map((g) => (g.kept ? "▸" : "") + debug.fmt(g.durSec, 2)).join(" ")}`,
      );
    }
  }
}
