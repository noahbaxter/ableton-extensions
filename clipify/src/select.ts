// Decide cut beats and strip regions from the candidates + settings, for the
// headless commands (Split / Strip / Quick). This MIRRORS selectCuts() in
// popup.html — keep the two in sync until they're consolidated (see BACKLOG).

import type { Candidate, Extent } from "./candidates.js";
import type { Settings } from "./settings.js";

export interface Portions {
  split: boolean; // cut phrase edges (keep silence)
  strip: boolean; // strip silence (or, in CONTENT mode, the sound)
}

export interface Selection {
  cutBeats: number[];
  strips: { start: number; end: number }[];
}

const EPS = 0.001;

const geom = (a: number, b: number, u: number) => a * Math.pow(b / a, u);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function thresholdFor(mode: Settings["mode"], s: number): number {
  if (mode === "MACRO") return s < 0.5 ? geom(1.5, 0.7, s / 0.5) : geom(0.7, 0.1, (s - 0.5) / 0.5);
  return s < 0.5 ? geom(0.5, 0.02, s / 0.5) : geom(0.02, 0.006, (s - 0.5) / 0.5);
}

// strip zone (beats): 0.5 = the silence extent (= the split cut), <0.5 shrinks inward,
// >0.5 extends out toward the neighbouring notes
function zone(ext: Extent, gapStartBeat: number, gapEndBeat: number, sil: number) {
  if (sil >= 0.5) {
    const u = (sil - 0.5) / 0.5;
    return { b0: lerp(ext.cutBeat, gapStartBeat, u), b1: lerp(ext.deepEndBeat, gapEndBeat, u) };
  }
  const k = ((0.5 - sil) / 0.5) * 0.7;
  const mB = (ext.cutBeat + ext.deepEndBeat) / 2;
  return { b0: lerp(ext.cutBeat, mB, k), b1: lerp(ext.deepEndBeat, mB, k) };
}

export function computeSelection(
  cands: Candidate[],
  s: Settings,
  p: Portions,
  winStartBeat: number,
  winEndBeat: number,
): Selection {
  const thresh = thresholdFor(s.mode, s.mode === "MACRO" ? s.sensMacro : s.sensMicro);
  const cutBeats: number[] = [];
  const strips: { start: number; end: number }[] = [];

  const eligible = cands.filter(
    (c) => c.edge || (c.durSec >= thresh && (s.mode !== "MACRO" || c.quiet.hasDeep)),
  );

  // CONTENT strip: cut at the (quiet) silence boundaries and strip the SOUND between them
  if (p.strip && s.thresh === "content") {
    let prevEnd = winStartBeat;
    for (const c of eligible.filter((c) => c.quiet.hasDeep).sort((a, b) => a.quiet.cutBeat - b.quiet.cutBeat)) {
      if (c.quiet.cutBeat - prevEnd > EPS) {
        cutBeats.push(prevEnd, c.quiet.cutBeat);
        strips.push({ start: prevEnd, end: c.quiet.cutBeat });
      }
      prevEnd = c.quiet.deepEndBeat;
    }
    if (winEndBeat - prevEnd > EPS) {
      cutBeats.push(prevEnd, winEndBeat);
      strips.push({ start: prevEnd, end: winEndBeat });
    }
    return { cutBeats, strips };
  }

  const atEnd = s.cutAt !== "start";
  const atStart = s.cutAt !== "end";
  for (const c of eligible) {
    const ext = s.thresh === "silence" ? c.silence : c.quiet;
    if (p.strip && ext.hasDeep) {
      const z = zone(ext, c.gapStartBeat, c.gapEndBeat, s.silence);
      cutBeats.push(z.b0, z.b1);
      strips.push({ start: z.b0, end: z.b1 });
    } else if (p.split) {
      if (!ext.hasDeep) {
        cutBeats.push(ext.cutBeat);
      } else {
        if (atEnd && ext.cutFrac > EPS) cutBeats.push(ext.cutBeat);
        if (atStart && ext.deepEndFrac < 1 - EPS) cutBeats.push(ext.deepEndBeat);
      }
    }
  }
  return { cutBeats, strips };
}
