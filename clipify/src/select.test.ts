import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSelection, type ValleyCut } from "./select.js";
import type { Settings } from "./settings.js";

const base: Settings = {
  mode: "MICRO",
  sensMacro: 0.5,
  sensMicro: 0.7,
  valleyDepth: 1,
  valleyMinWidthMs: 25,
  splitOn: true,
  cutAt: "both",
  stripOn: false,
  stripAction: "deactivate",
  thresh: "quiet",
  silence: 0.5,
  levelOn: false,
  ceilingDb: -1,
  maxChangeDb: 12,
  avgAcrossClips: true,
};

const valleys: ValleyCut[] = [
  { cutBeat: 5, cutFrac: 0.5, depthRatio: 0.7, widthSec: 0.04 },
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
  const floorDeep: ValleyCut[] = [{ cutBeat: 5, cutFrac: 0.5, depthRatio: 1, widthSec: 0.04 }];
  const sel = computeSelection([], base, split, 0, 10, floorDeep);
  assert.equal(sel.cutBeats.length, 0);
});

test("a deep, wide valley cuts when the depth knob is lowered", () => {
  const s = { ...base, valleyDepth: 0.5 };
  const sel = computeSelection([], s, split, 0, 10, valleys);
  assert.deepEqual(sel.cutBeats, [5]);
  assert.deepEqual(sel.drawCuts, [0.5]);
});

test("too-narrow valley is rejected even when deep enough", () => {
  const s = { ...base, valleyDepth: 0.5, valleyMinWidthMs: 25 };
  const narrow: ValleyCut[] = [{ cutBeat: 5, cutFrac: 0.5, depthRatio: 0.9, widthSec: 0.01 }];
  const sel = computeSelection([], s, split, 0, 10, narrow);
  assert.equal(sel.cutBeats.length, 0);
});

test("valleys are not added when split is off (strip-only)", () => {
  const s = { ...base, valleyDepth: 0.5, stripOn: true };
  const sel = computeSelection([], s, { split: false, strip: true }, 0, 10, valleys);
  assert.equal(sel.cutBeats.length, 0);
});
