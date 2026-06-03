// Clip time mapping shared by the slicer and the standalone zero-crossing split.
// Converts between a clip's file-seconds and the arrangement timeline. The
// sec→beat direction is warp-aware (follows the clip's warp curve); the inverse
// is a linear average rate, so beat→sec under heavy warp is approximate (see
// README "Known limitation").

import type { AudioClip } from "@ableton-extensions/sdk";

import { buildWarpMap } from "./warp.js";

const MIN_WARP_MARKERS = 2; // fewer than this = treat as unwarped (constant rate)

export interface ClipMapping {
  clipStartSec: number; // file-second the clip starts playing
  clipEndSec: number; // file-second the clip stops playing
  secToArrBeat: (s: number) => number; // file-second -> arrangement beat (warp aware)
  beatToClipSec: (b: number) => number; // arrangement beat -> file-second (linear)
}

export function buildClipMapping(clip: AudioClip<"1.0.0">, tempo: number): ClipMapping {
  const secPerBeat = 60 / tempo;
  const arrSpan = clip.endTime - clip.startTime;
  const markerSpan = clip.endMarker - clip.startMarker;
  const secPerMarker = markerSpan !== 0 ? (arrSpan * secPerBeat) / markerSpan : secPerBeat;
  const clipStartSec = clip.startMarker * secPerMarker;
  const clipEndSec = clip.endMarker * secPerMarker;

  const useWarp = clip.warping && clip.warpMarkers.length >= MIN_WARP_MARKERS;
  const warp = buildWarpMap(
    clip.warpMarkers,
    secPerBeat,
    useWarp ? [{ sec: clipStartSec, beat: 0 }, { sec: clipEndSec, beat: arrSpan }] : undefined,
  );
  const secToArrBeat = useWarp
    ? (s: number) => clip.startTime + (warp.secToBeat(s) - warp.secToBeat(clipStartSec))
    : (s: number) => clip.startTime + (s - clipStartSec) / secPerBeat;

  const secPerArrBeat = arrSpan !== 0 ? (clipEndSec - clipStartSec) / arrSpan : secPerBeat;
  const beatToClipSec = (b: number) => clipStartSec + (b - clip.startTime) * secPerArrBeat;

  return { clipStartSec, clipEndSec, secToArrBeat, beatToClipSec };
}
