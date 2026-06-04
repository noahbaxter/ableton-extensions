import { test } from "node:test";
import assert from "node:assert/strict";
import { segmentLevelDb } from "./silence.js";

test("segmentLevelDb is dB of the segment's high-percentile RMS above the floor", () => {
  const rms = [0.01, 0.01, 0.1, 0.1, 0.1, 0.1, 0.01];
  const db = segmentLevelDb(rms, 0.01, 0.02, 0.06, 0.01);
  assert.ok(Math.abs(db - 20) < 1.0, `db ${db}`);
});

test("segmentLevelDb of a near-floor segment is small", () => {
  const rms = [0.01, 0.013, 0.012, 0.013, 0.01];
  const db = segmentLevelDb(rms, 0.01, 0.01, 0.04, 0.01);
  assert.ok(db < 3, `db ${db}`);
});

test("segmentLevelDb returns 0 when floor is 0 or no windows", () => {
  assert.equal(segmentLevelDb([0.1, 0.1], 0.01, 0, 0.02, 0), 0);
  assert.equal(segmentLevelDb([0.1], 0.01, 0.5, 0.6, 0.01), 0);
});
