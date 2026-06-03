// Decide cut beats and strip regions from the candidates + settings, for the
// headless commands (Split / Strip / Quick). This MIRRORS selectCuts() in
// popup.html — keep the two in sync until they're consolidated (see BACKLOG).

import type { Candidate } from "./candidates.js";
import type { Settings } from "./settings.js";

export interface Portions {
  split: boolean; // cut phrase edges (keep silence)
  strip: boolean; // strip the silence in detected gaps
}

export interface Selection {
  cutBeats: number[];
  strips: { start: number; end: number }[];
}

const EPS = 0.001;

const geom = (a: number, b: number, u: number) => a * Math.pow(b / a, u);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// gap-duration threshold (seconds): each mode's sweet spot sits at the slider centre
function thresholdFor(mode: Settings["mode"], s: number): number {
  if (mode === "MACRO") return s < 0.5 ? geom(1.5, 0.7, s / 0.5) : geom(0.7, 0.1, (s - 0.5) / 0.5);
  return s < 0.5 ? geom(0.5, 0.02, s / 0.5) : geom(0.02, 0.006, (s - 0.5) / 0.5);
}

// strip zone (beats): 0.5 = deep-silence extent, <0.5 shrinks inward, >0.5 extends out
function zone(c: Candidate, sil: number): { b0: number; b1: number } {
  if (sil >= 0.5) {
    const u = (sil - 0.5) / 0.5;
    return { b0: lerp(c.cutBeat, c.gapStartBeat, u), b1: lerp(c.deepEndBeat, c.gapEndBeat, u) };
  }
  const k = ((0.5 - sil) / 0.5) * 0.7;
  const mB = (c.cutBeat + c.deepEndBeat) / 2;
  return { b0: lerp(c.cutBeat, mB, k), b1: lerp(c.deepEndBeat, mB, k) };
}

export function computeSelection(cands: Candidate[], s: Settings, p: Portions): Selection {
  const thresh = thresholdFor(s.mode, s.mode === "MACRO" ? s.sensMacro : s.sensMicro);
  const atEnd = s.cutAt !== "start";
  const atStart = s.cutAt !== "end";
  const cutBeats: number[] = [];
  const strips: { start: number; end: number }[] = [];

  for (const c of cands) {
    const eligible = c.edge || (c.durSec >= thresh && (s.mode !== "MACRO" || c.hasDeep));
    if (!eligible) continue;

    if (p.strip && c.hasDeep) {
      const z = zone(c, s.silence);
      cutBeats.push(z.b0, z.b1);
      strips.push({ start: z.b0, end: z.b1 });
    } else if (p.split) {
      if (!c.hasDeep) {
        cutBeats.push(c.cutBeat);
      } else {
        if (atEnd && c.cutFrac > EPS) cutBeats.push(c.cutBeat);
        if (atStart && c.deepEndFrac < 1 - EPS) cutBeats.push(c.deepEndBeat);
      }
    }
  }
  return { cutBeats, strips };
}
