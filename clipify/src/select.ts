// The one place cuts and strip regions are decided, from candidates + settings.
// Used by the headless commands (Split / Strip / Quick) AND the popup (which only
// renders the result + draw fractions). No selection logic lives in the popup.

import type { Candidate, EdgeContext, Extent } from "./candidates.js";
import type { Settings } from "./settings.js";
import { placeEdge, type EdgeParams } from "./edge.js";

export interface Portions {
  split: boolean; // cut phrase edges (keep silence)
  strip: boolean; // strip silence (or, in CONTENT mode, the sound)
}

export interface Selection {
  cutBeats: number[];
  strips: { start: number; end: number }[];
  drawCuts: number[]; // window fractions [0,1] of every cut (for the canvas)
  drawStrips: { f0: number; f1: number }[]; // window fractions of each strip region
  drawSegments: number[]; // window fractions of the segment boundaries (always shown)
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

function thresholdFor(mode: Settings["mode"], s: number): number {
  if (mode === "MACRO") return s < 0.5 ? geom(1.5, 0.7, s / 0.5) : geom(0.7, 0.1, (s - 0.5) / 0.5);
  return s < 0.5 ? geom(0.5, 0.02, s / 0.5) : geom(0.02, 0.006, (s - 0.5) / 0.5);
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
        folded: true,
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
      folded: true,
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
      folded: true,
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
  edge?: EdgeContext,
): Selection {
  const thresh = thresholdFor(s.mode, s.mode === "MACRO" ? s.sensMacro : s.sensMicro);
  const cands = mergeCulledGaps(rawCands, s.cullDb, winStartBeat, winEndBeat);
  const sel: Selection = { cutBeats: [], strips: [], drawCuts: [], drawStrips: [], drawSegments: [] };
  const cut = (beat: number, frac: number) => {
    sel.cutBeats.push(beat);
    sel.drawCuts.push(frac);
  };
  const strip = (b0: number, b1: number, f0: number, f1: number) => {
    // boundaries are real cuts at apply (to isolate the region), but on the canvas a
    // strip is shown by its fill alone — not as slice lines — so the two read apart.
    sel.cutBeats.push(b0, b1);
    sel.strips.push({ start: b0, end: b1 });
    sel.drawStrips.push({ f0, f1 });
  };

  const eligible = cands.filter(
    (c) => c.edge || c.folded || (c.durSec >= thresh && (s.mode !== "MACRO" || c.quiet.hasDeep)),
  );

  // segment boundaries (always drawn, independent of which operations are on): the
  // active-threshold silence edges of every eligible gap — the points where one
  // detected chunk ends and the next begins.
  for (const c of eligible) {
    const ext = s.thresh === "silence" ? c.silence : c.quiet;
    if (ext.cutFrac > EPS && ext.cutFrac < 1 - EPS) sel.drawSegments.push(ext.cutFrac);
    if (ext.hasDeep && ext.deepEndFrac > EPS && ext.deepEndFrac < 1 - EPS) sel.drawSegments.push(ext.deepEndFrac);
  }

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
      // Strip region = the silence to remove. Its start edge rides the previous note's
      // release, its end edge rides the next note's attack. The Edge knob walks each
      // along the envelope; with no context (tests) or amount 0 it stays on the boundary.
      let b0 = ext.cutBeat, f0 = ext.cutFrac;
      let b1 = ext.deepEndBeat, f1 = ext.deepEndFrac;
      let collapsed = false;
      if (edge && s.stripEdge !== 0 && ext.cutSec != null && ext.deepEndSec != null) {
        const ep: EdgeParams = { mode: s.stripEdgeMode, amount: s.stripEdge, clampMs: s.stripEdgeClampMs };
        const lvl = s.thresh === "silence" ? edge.silenceThresh : edge.quietThresh;
        const startSec = placeEdge(ext.cutSec, -1, lvl, edge, ep); // sound to the LEFT
        const endSec = placeEdge(ext.deepEndSec, 1, lvl, edge, ep); // sound to the RIGHT
        if (endSec > startSec) {
          b0 = edge.secToArrBeat(startSec); f0 = Math.max(0, Math.min(1, edge.frac(startSec)));
          b1 = edge.secToArrBeat(endSec); f1 = Math.max(0, Math.min(1, edge.frac(endSec)));
        } else {
          // loosened past the point of having anything to strip: drop this region
          // entirely rather than snapping back to the full detected silence.
          collapsed = true;
        }
      }
      if (!collapsed) {
        // edge-pin: a strip reaching a window edge goes fully to it, no leftover sliver.
        if (c.gapStartFrac <= EPS) { b0 = winStartBeat; f0 = 0; }
        if (c.gapEndFrac >= 1 - EPS) { b1 = winEndBeat; f1 = 1; }
        if (f1 - f0 > EPS) strip(b0, b1, f0, f1);
      }
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
    const valleyDepth = s.mode === "MACRO" ? s.valleyDepthMacro : s.valleyDepthMicro;
    const minWidthSec = s.valleyMinWidthMs / 1000;
    for (const v of valleys) {
      const inCulledSeg = s.cullDb > 0 && v.segLevelDb < s.cullDb;
      if (!inCulledSeg && v.depthRatio > valleyDepth && v.widthSec >= minWidthSec)
        cut(v.cutBeat, v.cutFrac);
    }
  }
  return sel;
}
