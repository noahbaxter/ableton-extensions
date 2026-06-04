import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSelection, type ValleyCut } from "./select.js";
import type { Settings } from "./settings.js";
import type { EdgeContext } from "./candidates.js";

const base: Settings = {
  mode: "MICRO",
  sensMacro: 0.5,
  sensMicro: 0.7,
  valleyDepthMacro: 1,
  valleyDepthMicro: 1,
  valleyMinWidthMs: 25,
  cullDb: 0,
  splitOn: true,
  cutAt: "both",
  stripOn: false,
  stripAction: "deactivate",
  thresh: "quiet",
  stripEdge: 0,
  stripEdgeMode: "level",
  stripEdgeClampMs: 0,
  levelOn: false,
  levelTarget: "average",
  ceilingDb: -1,
  maxChangeDb: 12,
  avgAcrossClips: true,
};

const valleys: ValleyCut[] = [
  { cutBeat: 5, cutFrac: 0.5, depthRatio: 0.7, widthSec: 0.04, segLevelDb: 30 },
];
const split = { split: true, strip: false };

test("default valleyDepth=1 adds no valley cuts (regression guard)", () => {
  const withV = computeSelection([], base, split, 0, 10, valleys);
  const without = computeSelection([], base, split, 0, 10, []);
  assert.deepEqual(withV.cutBeats, without.cutBeats);
  assert.equal(withV.cutBeats.length, 0);
});

test("a floor-deep valley (depthRatio 1) still does not cut at default depth", () => {
  // a sub-45ms near-silent gap inside one segment drops to the floor → depthRatio
  // clamps to 1; the strict > guard must still reject it at the default valleyDepth=1
  const floorDeep: ValleyCut[] = [{ cutBeat: 5, cutFrac: 0.5, depthRatio: 1, widthSec: 0.04, segLevelDb: 30 }];
  const sel = computeSelection([], base, split, 0, 10, floorDeep);
  assert.equal(sel.cutBeats.length, 0);
});

test("a deep, wide valley cuts when the depth knob is lowered", () => {
  const s = { ...base, valleyDepthMicro: 0.5 };
  const sel = computeSelection([], s, split, 0, 10, valleys);
  assert.deepEqual(sel.cutBeats, [5]);
  assert.deepEqual(sel.drawCuts, [0.5]);
});

test("too-narrow valley is rejected even when deep enough", () => {
  const s = { ...base, valleyDepthMicro: 0.5, valleyMinWidthMs: 25 };
  const narrow: ValleyCut[] = [{ cutBeat: 5, cutFrac: 0.5, depthRatio: 0.9, widthSec: 0.01, segLevelDb: 30 }];
  const sel = computeSelection([], s, split, 0, 10, narrow);
  assert.equal(sel.cutBeats.length, 0);
});

test("valleys are not added when split is off (strip-only)", () => {
  const s = { ...base, valleyDepthMicro: 0.5, stripOn: true };
  const sel = computeSelection([], s, { split: false, strip: true }, 0, 10, valleys);
  assert.equal(sel.cutBeats.length, 0);
});

// Two deep-silence gaps separated by one sound segment. That middle segment is
// gap1.nextLevelDb (== gap2.prevLevelDb); culling it merges the two gaps into one.
const twoGaps = [
  {
    durSec: 0.5, edge: false,
    gapStartFrac: 0.1, gapEndFrac: 0.2, gapStartBeat: 1, gapEndBeat: 2,
    quiet: { hasDeep: true, cutFrac: 0.12, deepEndFrac: 0.18, cutBeat: 1.2, deepEndBeat: 1.8 },
    silence: { hasDeep: true, cutFrac: 0.12, deepEndFrac: 0.18, cutBeat: 1.2, deepEndBeat: 1.8 },
    prevLevelDb: 30, nextLevelDb: 4, // the segment between the two gaps is quiet (4 dB)
  },
  {
    durSec: 0.5, edge: false,
    gapStartFrac: 0.4, gapEndFrac: 0.5, gapStartBeat: 4, gapEndBeat: 5,
    quiet: { hasDeep: true, cutFrac: 0.42, deepEndFrac: 0.48, cutBeat: 4.2, deepEndBeat: 4.8 },
    silence: { hasDeep: true, cutFrac: 0.42, deepEndFrac: 0.48, cutBeat: 4.2, deepEndBeat: 4.8 },
    prevLevelDb: 4, nextLevelDb: 30,
  },
];
const stripOnly = { split: false, strip: true };

test("cull off (cullDb=0): two gaps stay two separate strip regions", () => {
  const s = { ...base, cullDb: 0 };
  const sel = computeSelection(twoGaps as any, s, stripOnly, 0, 10);
  assert.equal(sel.strips.length, 2);
});

test("cull on: gaps around a culled segment merge into one expanded region (no new section)", () => {
  const s = { ...base, cullDb: 10 };
  const sel = computeSelection(twoGaps as any, s, stripOnly, 0, 10);
  assert.equal(sel.strips.length, 1);
  assert.deepEqual(sel.strips[0], { start: 1.2, end: 4.8 });
});

test("cull on: split cuts drop as gaps merge (never increase)", () => {
  const off = computeSelection(twoGaps as any, { ...base, cullDb: 0 }, split, 0, 10);
  const on = computeSelection(twoGaps as any, { ...base, cullDb: 10 }, split, 0, 10);
  assert.ok(on.cutBeats.length < off.cutBeats.length, `on ${on.cutBeats.length} vs off ${off.cutBeats.length}`);
});

test("cull on: a valley inside a culled segment is skipped", () => {
  const s = { ...base, cullDb: 10, valleyDepthMicro: 0.5 };
  const inCulled: ValleyCut[] = [{ cutBeat: 1.5, cutFrac: 0.15, depthRatio: 0.9, widthSec: 0.05, segLevelDb: 4 }];
  const sel = computeSelection([], s, split, 0, 10, inCulled);
  assert.equal(sel.cutBeats.length, 0);
});

test("cull on: a valley inside a kept segment still cuts", () => {
  const s = { ...base, cullDb: 10, valleyDepthMicro: 0.5 };
  const inKept: ValleyCut[] = [{ cutBeat: 3.5, cutFrac: 0.35, depthRatio: 0.9, widthSec: 0.05, segLevelDb: 30 }];
  const sel = computeSelection([], s, split, 0, 10, inKept);
  assert.deepEqual(sel.cutBeats, [3.5]);
});

test("cull off: a valley whose segment level is below the floor (negative dB) still cuts", () => {
  const s = { ...base, valleyDepthMicro: 0.5 }; // cullDb stays 0 → must be a strict no-op
  const v: ValleyCut[] = [{ cutBeat: 3.5, cutFrac: 0.35, depthRatio: 0.9, widthSec: 0.05, segLevelDb: -5 }];
  const sel = computeSelection([], s, split, 0, 10, v);
  assert.deepEqual(sel.cutBeats, [3.5]);
});

test("cull on: a shallow (no-deep) gap merges using its gap edge, not the midpoint", () => {
  const shallowFirst = [
    {
      ...twoGaps[0],
      quiet: { hasDeep: false, cutFrac: 0.15, cutBeat: 1.5, deepEndFrac: 0.15, deepEndBeat: 1.5 },
      silence: { hasDeep: false, cutFrac: 0.15, cutBeat: 1.5, deepEndFrac: 0.15, deepEndBeat: 1.5 },
    },
    twoGaps[1],
  ];
  const s = { ...base, cullDb: 10 };
  const sel = computeSelection(shallowFirst as any, s, stripOnly, 0, 10);
  assert.equal(sel.strips.length, 1);
  assert.equal(sel.strips[0]!.start, 1); // gap1.gapStartBeat, not the 1.5 midpoint
});

test("cull on: a chain of culled segments merges every gap into one region", () => {
  const g = (gs: number, ge: number, cb: number, de: number, prev: number, next: number) => ({
    durSec: 0.3, edge: false, gapStartFrac: gs / 10, gapEndFrac: ge / 10, gapStartBeat: gs, gapEndBeat: ge,
    quiet: { hasDeep: true, cutFrac: cb / 10, cutBeat: cb, deepEndFrac: de / 10, deepEndBeat: de },
    silence: { hasDeep: true, cutFrac: cb / 10, cutBeat: cb, deepEndFrac: de / 10, deepEndBeat: de },
    prevLevelDb: prev, nextLevelDb: next,
  });
  const threeGaps = [g(1, 2, 1.2, 1.8, 30, 4), g(3, 4, 3.2, 3.8, 4, 4), g(5, 6, 5.2, 5.8, 4, 30)];
  const s = { ...base, cullDb: 10 };
  const sel = computeSelection(threeGaps as any, s, stripOnly, 0, 10);
  assert.equal(sel.strips.length, 1);
  assert.deepEqual(sel.strips[0], { start: 1.2, end: 5.8 });
});

test("cull on: a culled FIRST segment (no leading gap) folds back to the window start", () => {
  // the only gap's prev segment is quiet → nothing 'backwards' to merge into, so the
  // gap must extend to the window start (beat 0)
  const cands = [
    {
      durSec: 0.5, edge: false, gapStartFrac: 0.2, gapEndFrac: 0.3, gapStartBeat: 2, gapEndBeat: 3,
      quiet: { hasDeep: true, cutFrac: 0.22, deepEndFrac: 0.28, cutBeat: 2.2, deepEndBeat: 2.8 },
      silence: { hasDeep: true, cutFrac: 0.22, deepEndFrac: 0.28, cutBeat: 2.2, deepEndBeat: 2.8 },
      prevLevelDb: 4, nextLevelDb: 30,
    },
  ];
  const s = { ...base, cullDb: 10 };
  const sel = computeSelection(cands as any, s, stripOnly, 0, 10);
  assert.equal(sel.strips.length, 1);
  assert.equal(sel.strips[0]!.start, 0); // extended back to winStartBeat
});

test("strip pins a trailing edge gap to the window end regardless of Amount (no sliver)", () => {
  const trail = [
    {
      durSec: 3, edge: true, gapStartFrac: 0.7, gapEndFrac: 1, gapStartBeat: 7, gapEndBeat: 10,
      quiet: { hasDeep: true, cutFrac: 0.72, deepEndFrac: 0.9, cutBeat: 7.2, deepEndBeat: 9 },
      silence: { hasDeep: true, cutFrac: 0.72, deepEndFrac: 0.9, cutBeat: 7.2, deepEndBeat: 9 },
      prevLevelDb: 30, nextLevelDb: null,
    },
  ];
  const s = { ...base }; // stripEdge: 0 (default) still pins edge gaps to the window boundary
  const sel = computeSelection(trail as any, s, { split: false, strip: true }, 0, 10);
  assert.equal(sel.strips[0]!.end, 10);
});

test("cull on (MACRO): a culled last segment behind a short gap still folds to the window end", () => {
  // the gap before the culled last segment is shorter than the MACRO duration
  // threshold; once cull folds it, it must bypass that threshold (folded = eligible)
  const cands = [
    {
      durSec: 0.1, edge: false, gapStartFrac: 0.2, gapEndFrac: 0.21, gapStartBeat: 2, gapEndBeat: 2.1,
      quiet: { hasDeep: true, cutFrac: 0.2, deepEndFrac: 0.21, cutBeat: 2.0, deepEndBeat: 2.1 },
      silence: { hasDeep: true, cutFrac: 0.2, deepEndFrac: 0.21, cutBeat: 2.0, deepEndBeat: 2.1 },
      prevLevelDb: 30, nextLevelDb: 4,
    },
  ];
  const s = { ...base, mode: "MACRO" as const, cullDb: 10 };
  const sel = computeSelection(cands as any, s, { split: false, strip: true }, 0, 10);
  assert.equal(sel.strips.length, 1);
  assert.equal(sel.strips[0]!.end, 10);
});

test("cull on: a culled LAST segment (no trailing gap) folds out to the window end", () => {
  const cands = [
    {
      durSec: 0.5, edge: false, gapStartFrac: 0.2, gapEndFrac: 0.3, gapStartBeat: 2, gapEndBeat: 3,
      quiet: { hasDeep: true, cutFrac: 0.22, deepEndFrac: 0.28, cutBeat: 2.2, deepEndBeat: 2.8 },
      silence: { hasDeep: true, cutFrac: 0.22, deepEndFrac: 0.28, cutBeat: 2.2, deepEndBeat: 2.8 },
      prevLevelDb: 30, nextLevelDb: 4,
    },
  ];
  const s = { ...base, cullDb: 10 };
  const sel = computeSelection(cands as any, s, stripOnly, 0, 10);
  assert.equal(sel.strips.length, 1);
  assert.equal(sel.strips[0]!.end, 10); // extended out to winEndBeat
});

test("stripEdge default (0) places strip edges on the detected extent", () => {
  const s = { ...base, stripOn: true };
  const sel = computeSelection(twoGaps as any, s, stripOnly, 0, 10);
  // unchanged from the cull-off case: edges at the quiet extents
  assert.deepEqual(sel.strips[0], { start: 1.2, end: 1.8 });
  assert.deepEqual(sel.strips[1], { start: 4.2, end: 4.8 });
});

test("loosening past the crossing point drops the strip instead of folding it", () => {
  const cand = [{
    durSec: 0.2, edge: false,
    gapStartFrac: 0.4, gapEndFrac: 0.6, gapStartBeat: 4, gapEndBeat: 6,
    quiet: { hasDeep: true, cutFrac: 0.45, deepEndFrac: 0.55, cutBeat: 4.5, deepEndBeat: 5.5, cutSec: 0.45, deepEndSec: 0.55 },
    silence: { hasDeep: true, cutFrac: 0.45, deepEndFrac: 0.55, cutBeat: 4.5, deepEndBeat: 5.5, cutSec: 0.45, deepEndSec: 0.55 },
    prevLevelDb: 30, nextLevelDb: 30,
  }];
  const windowDur = 0.05;
  const floor = 0.001;
  const rms = new Array(20).fill(0.05); // all above the loosen target, so both edges run and cross
  const edge = {
    rms, windowDur, noiseFloor: floor,
    quietThresh: floor * Math.pow(10, 9 / 20),
    silenceThresh: Math.pow(10, -78 / 20),
    frac: (s: number) => s / (20 * windowDur),
    secToArrBeat: (s: number) => s,
  };
  // full loosen, no clamp (base clampMs 0): edges cross -> region dropped
  const s = { ...base, stripOn: true, stripEdge: -1, stripEdgeMode: "level" as const };
  const sel = computeSelection(cand as any, s, stripOnly, 0, 10, [], edge as any);
  assert.equal(sel.strips.length, 0);
});

test("non-zero stripEdge walks a strip boundary off the detected extent", () => {
  // dedicated candidate with cutSec/deepEndSec set so the edge engine can fire;
  // twoGaps omits those fields so we can't mutate the shared fixture
  const windowDur = 0.02;
  const floor = 0.001;
  // 25 windows: sound (0-5), silence (6-19), sound (20-24)
  const rms = new Array(25).fill(floor) as number[];
  for (let i = 0; i <= 5; i++) rms[i] = 0.05;
  for (let i = 20; i < 25; i++) rms[i] = 0.05;
  const cand = [
    {
      durSec: 0.5, edge: false,
      gapStartFrac: 0.1, gapEndFrac: 0.4, gapStartBeat: 0.1, gapEndBeat: 0.4,
      quiet: {
        hasDeep: true,
        cutFrac: 0.12, deepEndFrac: 0.38,
        cutBeat: 0.12, deepEndBeat: 0.38,
        cutSec: 0.12, deepEndSec: 0.38,
      },
      silence: {
        hasDeep: true,
        cutFrac: 0.12, deepEndFrac: 0.38,
        cutBeat: 0.12, deepEndBeat: 0.38,
        cutSec: 0.12, deepEndSec: 0.38,
      },
      prevLevelDb: 30, nextLevelDb: 30,
    },
  ];
  const edge: EdgeContext = {
    rms,
    windowDur,
    noiseFloor: floor,
    quietThresh: floor * Math.pow(10, 9 / 20),
    silenceThresh: Math.pow(10, -78 / 20),
    frac: (s: number) => s / (25 * windowDur),
    secToArrBeat: (s: number) => s,
  };
  const s0 = { ...base, stripOn: true, stripEdge: 0, stripEdgeMode: "time" as const };
  const sTight = { ...base, stripOn: true, stripEdge: 0.8, stripEdgeMode: "time" as const };
  const r0 = computeSelection(cand as any, s0, stripOnly, 0, 10);
  const rTight = computeSelection(cand as any, sTight, stripOnly, 0, 10, [], edge);
  // with edge active, at least one boundary must move off the detected extent
  assert.ok(
    rTight.strips[0]!.start !== r0.strips[0]!.start || rTight.strips[0]!.end !== r0.strips[0]!.end,
    `expected a moved boundary, got ${JSON.stringify(rTight.strips[0])} vs ${JSON.stringify(r0.strips[0])}`,
  );
});
