// The one place cuts and strip regions are decided, from candidates + settings.
// Used by the headless commands (Split / Strip / Quick) AND the popup (which only
// renders the result + draw fractions). No selection logic lives in the popup.

import type { Candidate, Extent } from "./candidates.js";
import type { Settings } from "./settings.js";

export interface Portions {
  split: boolean; // cut phrase edges (keep silence)
  strip: boolean; // strip silence (or, in CONTENT mode, the sound)
}

export interface Selection {
  cutBeats: number[];
  strips: { start: number; end: number }[];
  drawCuts: number[]; // window fractions [0,1] of every cut (for the canvas)
  drawStrips: { f0: number; f1: number }[]; // window fractions of each strip region
}

export interface ValleyCut {
  cutBeat: number; // arrangement beat of the dip
  cutFrac: number; // window fraction [0,1] of the dip (for the canvas)
  depthRatio: number; // 0..1, fall toward the floor relative to neighbouring peaks
  widthSec: number; // dip width at half-depth
  segLevelDb: number; // level (dB above floor) of the segment this valley sits in
}

const EPS = 0.001;

const geom = (a: number, b: number, u: number) => a * Math.pow(b / a, u);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function thresholdFor(mode: Settings["mode"], s: number): number {
  if (mode === "MACRO") return s < 0.5 ? geom(1.5, 0.7, s / 0.5) : geom(0.7, 0.1, (s - 0.5) / 0.5);
  return s < 0.5 ? geom(0.5, 0.02, s / 0.5) : geom(0.02, 0.006, (s - 0.5) / 0.5);
}

// strip zone (beats + fractions): 0.5 = the silence extent (= the split cut),
// <0.5 shrinks inward, >0.5 extends out toward the neighbouring notes
function zone(c: Candidate, ext: Extent, sil: number) {
  if (sil >= 0.5) {
    const u = (sil - 0.5) / 0.5;
    return {
      b0: lerp(ext.cutBeat, c.gapStartBeat, u),
      b1: lerp(ext.deepEndBeat, c.gapEndBeat, u),
      f0: lerp(ext.cutFrac, c.gapStartFrac, u),
      f1: lerp(ext.deepEndFrac, c.gapEndFrac, u),
    };
  }
  const k = ((0.5 - sil) / 0.5) * 0.7;
  const mB = (ext.cutBeat + ext.deepEndBeat) / 2;
  const mF = (ext.cutFrac + ext.deepEndFrac) / 2;
  return {
    b0: lerp(ext.cutBeat, mB, k),
    b1: lerp(ext.deepEndBeat, mB, k),
    f0: lerp(ext.cutFrac, mF, k),
    f1: lerp(ext.deepEndFrac, mF, k),
  };
}

// Cull: a sound segment quieter than cullDb (dB above the floor) folds into the
// surrounding silence — the gaps on either side of it merge into one expanded gap, so
// every transform downstream sees fewer, bigger silences instead of a new region.
// Default cullDb=0 is a no-op (every real segment is > 0 dB above the floor). The
// segment between gap `prev` and gap `c` is culled iff prev.nextLevelDb < cullDb. A
// culled first/last segment has no gap on its outer side, so after merging the head
// and tail gaps are extended to the window edge to fold those in too.
function mergeCulledGaps(cands: Candidate[], cullDb: number, winStartBeat: number, winEndBeat: number): Candidate[] {
  if (cullDb <= 0) return cands;
  const out: Candidate[] = [];
  for (const c of cands) {
    const prev = out[out.length - 1];
    if (prev && prev.nextLevelDb != null && prev.nextLevelDb < cullDb) {
      // merged silence runs from prev's start edge to c's end edge; where a source gap
      // has no deep silence its cut point is a midpoint, so fall back to the gap edge.
      const span = (pe: Extent, ce: Extent): Extent => ({
        hasDeep: true,
        cutBeat: pe.hasDeep ? pe.cutBeat : prev.gapStartBeat,
        cutFrac: pe.hasDeep ? pe.cutFrac : prev.gapStartFrac,
        deepEndBeat: ce.hasDeep ? ce.deepEndBeat : c.gapEndBeat,
        deepEndFrac: ce.hasDeep ? ce.deepEndFrac : c.gapEndFrac,
      });
      out[out.length - 1] = {
        ...prev,
        durSec: prev.durSec + c.durSec,
        edge: prev.edge || c.edge,
        gapEndFrac: c.gapEndFrac,
        gapEndBeat: c.gapEndBeat,
        quiet: span(prev.quiet, c.quiet),
        silence: span(prev.silence, c.silence),
        nextLevelDb: c.nextLevelDb,
      };
    } else {
      out.push(c);
    }
  }

  // a culled FIRST segment (clip opens on content, no leading-silence gap) has no gap
  // to fold back into → extend the head gap out to the window start. Likewise the tail.
  const first = out[0];
  if (first && first.prevLevelDb != null && first.prevLevelDb < cullDb) {
    out[0] = {
      ...first,
      gapStartBeat: winStartBeat,
      gapStartFrac: 0,
      quiet: { ...first.quiet, hasDeep: true, cutBeat: winStartBeat, cutFrac: 0 },
      silence: { ...first.silence, hasDeep: true, cutBeat: winStartBeat, cutFrac: 0 },
      prevLevelDb: null,
    };
  }
  const last = out[out.length - 1];
  if (last && last.nextLevelDb != null && last.nextLevelDb < cullDb) {
    out[out.length - 1] = {
      ...last,
      gapEndBeat: winEndBeat,
      gapEndFrac: 1,
      quiet: { ...last.quiet, hasDeep: true, deepEndBeat: winEndBeat, deepEndFrac: 1 },
      silence: { ...last.silence, hasDeep: true, deepEndBeat: winEndBeat, deepEndFrac: 1 },
      nextLevelDb: null,
    };
  }
  return out;
}

export function computeSelection(
  rawCands: Candidate[],
  s: Settings,
  p: Portions,
  winStartBeat: number,
  winEndBeat: number,
  valleys: ValleyCut[] = [],
): Selection {
  const thresh = thresholdFor(s.mode, s.mode === "MACRO" ? s.sensMacro : s.sensMicro);
  const cands = mergeCulledGaps(rawCands, s.cullDb, winStartBeat, winEndBeat);
  const sel: Selection = { cutBeats: [], strips: [], drawCuts: [], drawStrips: [] };
  const cut = (beat: number, frac: number) => {
    sel.cutBeats.push(beat);
    sel.drawCuts.push(frac);
  };
  const strip = (b0: number, b1: number, f0: number, f1: number) => {
    cut(b0, f0);
    cut(b1, f1);
    sel.strips.push({ start: b0, end: b1 });
    sel.drawStrips.push({ f0, f1 });
  };

  const eligible = cands.filter(
    (c) => c.edge || (c.durSec >= thresh && (s.mode !== "MACRO" || c.quiet.hasDeep)),
  );

  // CONTENT strip: cut at the (quiet) silence boundaries and strip the SOUND between them
  if (p.strip && s.thresh === "content") {
    let pb = winStartBeat;
    let pf = 0;
    for (const c of eligible.filter((c) => c.quiet.hasDeep).sort((a, b) => a.quiet.cutBeat - b.quiet.cutBeat)) {
      if (c.quiet.cutFrac - pf > EPS) strip(pb, c.quiet.cutBeat, pf, c.quiet.cutFrac);
      pb = c.quiet.deepEndBeat;
      pf = c.quiet.deepEndFrac;
    }
    if (1 - pf > EPS) strip(pb, winEndBeat, pf, 1);
    return sel;
  }

  const atEnd = s.cutAt !== "start";
  const atStart = s.cutAt !== "end";
  for (const c of eligible) {
    const ext = s.thresh === "silence" ? c.silence : c.quiet;
    if (p.strip && ext.hasDeep) {
      const z = zone(c, ext, s.silence);
      strip(z.b0, z.b1, z.f0, z.f1);
    } else if (p.split) {
      if (!ext.hasDeep) {
        cut(ext.cutBeat, ext.cutFrac);
      } else {
        if (atEnd && ext.cutFrac > EPS) cut(ext.cutBeat, ext.cutFrac);
        if (atStart && ext.deepEndFrac < 1 - EPS) cut(ext.deepEndBeat, ext.deepEndFrac);
      }
    }
  }

  // Stage 3 — intra-segment valley cuts (split only; never a strip region). Additive:
  // depthRatio is clamped to [0,1], so the default valleyDepth of 1 admits nothing
  // (strict >, since a dip to the floor clamps to exactly 1) — a no-op until the depth
  // knob is lowered.
  if (p.split) {
    const minWidthSec = s.valleyMinWidthMs / 1000;
    for (const v of valleys) {
      const inCulledSeg = s.cullDb > 0 && v.segLevelDb < s.cullDb;
      if (!inCulledSeg && v.depthRatio > s.valleyDepth && v.widthSec >= minWidthSec)
        cut(v.cutBeat, v.cutFrac);
    }
  }
  return sel;
}
