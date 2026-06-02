// Turn detected sound segments into the contiguous clip pieces to create.
// Pure math, no SDK — given the sounds + the clip's window, decide where to cut.

import type { Segment } from "./silence.js";

/** The clip's content window, and where it sits in the arrangement. */
export interface ClipWindow {
  startSec: number; // content window into the file (seconds)
  endSec: number;
  startTime: number; // arrangement position of the clip start (beats)
  startMarker: number; // file offset of the clip start (beats)
  filePath: string;
}

export interface Piece {
  filePath: string;
  startMarker: number; // file offset (beats)
  endMarker: number;
  duration: number; // beats
  startTime: number; // arrangement position (beats)
}

/**
 * Cuts land in the MIDDLE of each gap between sounds, so every piece keeps its
 * audio (plus padding) and the window stays fully tiled in its original place.
 * Returns fewer than 2 pieces when there's nothing worth cutting.
 */
export function planPieces(
  sounds: Segment[],
  win: ClipWindow,
  secToBeat: (s: number) => number,
): Piece[] {
  // Restrict the detected sounds to the clip's used window into the file.
  const windowed = sounds
    .map((s) => ({ start: Math.max(s.start, win.startSec), end: Math.min(s.end, win.endSec) }))
    .filter((s) => s.end - s.start > 0);
  if (windowed.length <= 1) return [];

  const cutsSec: number[] = [];
  for (let i = 0; i < windowed.length - 1; i++) {
    cutsSec.push((windowed[i]!.end + windowed[i + 1]!.start) / 2);
  }
  const boundsSec = [win.startSec, ...cutsSec, win.endSec];

  const pieces: Piece[] = [];
  for (let i = 0; i < boundsSec.length - 1; i++) {
    const startMarker = secToBeat(boundsSec[i]!);
    const endMarker = secToBeat(boundsSec[i + 1]!);
    pieces.push({
      filePath: win.filePath,
      startMarker,
      endMarker,
      duration: endMarker - startMarker,
      startTime: win.startTime + (startMarker - win.startMarker),
    });
  }
  return pieces;
}
