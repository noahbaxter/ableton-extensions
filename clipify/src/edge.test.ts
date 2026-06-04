import { test } from "node:test";
import assert from "node:assert/strict";
import { placeEdge, type EdgeCtx, type EdgeParams } from "./edge.js";

// Synthetic envelope: floor 0.001 (~-60 dB). A gap of silence with a note attack on
// the right. windowDur 0.01s. Index:   0..4 silence(floor), 5..9 rising attack, 10+ loud.
// rms values chosen so the "quiet" boundary (floor+9dB ~= 0.00282) is first crossed at i=6.
const floor = 0.001;
const quietThresh = floor * Math.pow(10, 9 / 20); // ~0.00282
const rms = [
  0.001, 0.001, 0.001, 0.001, 0.001, // 0..4 silence
  0.002, 0.003, 0.006, 0.02, 0.06,   // 5..9 attack rising past quietThresh at i=6
  0.2, 0.2, 0.2, 0.2, 0.2,           // 10..14 note body
];
const ctx: EdgeCtx = {
  rms,
  windowDur: 0.01,
  quietThresh,
  silenceThresh: floor * Math.pow(10, -18 / 20),
  noiseFloor: floor,
};
// end edge (next note's attack): boundary at i=6 -> 0.06s, sound is to the RIGHT (+1).
const boundarySec = 0.06;
const boundaryLevel = quietThresh;

test("center (amount 0) returns the boundary unchanged", () => {
  const p: EdgeParams = { mode: "level", amount: 0, clampMs: 0 };
  assert.equal(placeEdge(boundarySec, 1, boundaryLevel, ctx, p), boundarySec);
});

test("level tighten walks into the attack (edge moves later, toward the sound)", () => {
  const p: EdgeParams = { mode: "level", amount: 0.6, clampMs: 0 };
  const edge = placeEdge(boundarySec, 1, boundaryLevel, ctx, p);
  assert.ok(edge > boundarySec, `expected later than ${boundarySec}, got ${edge}`);
});

test("level loosen walks toward the floor (edge moves earlier, catching the quiet lead-in)", () => {
  const p: EdgeParams = { mode: "level", amount: -0.6, clampMs: 0 };
  const edge = placeEdge(boundarySec, 1, boundaryLevel, ctx, p);
  assert.ok(edge < boundarySec, `expected earlier than ${boundarySec}, got ${edge}`);
});

test("level clamp caps travel in ms", () => {
  const p: EdgeParams = { mode: "level", amount: 1, clampMs: 5 }; // 5ms cap
  const edge = placeEdge(boundarySec, 1, boundaryLevel, ctx, p);
  assert.ok(edge <= boundarySec + 0.005 + 1e-9, `clamp exceeded: ${edge}`);
});

test("time tighten moves the edge a fraction of the attack span toward the sound", () => {
  const p: EdgeParams = { mode: "time", amount: 0.5, clampMs: 0 };
  const edge = placeEdge(boundarySec, 1, boundaryLevel, ctx, p);
  assert.ok(edge > boundarySec, `expected later, got ${edge}`);
});

test("start edge (sound to the left) tightens by moving earlier into the release", () => {
  // mirror: a release falling into silence on the right. Reuse ctx but soundDir -1.
  const p: EdgeParams = { mode: "level", amount: 0.6, clampMs: 0 };
  const edge = placeEdge(boundarySec, -1, boundaryLevel, ctx, p);
  // sound is to the LEFT, so tighten walks toward lower indices (earlier)
  assert.ok(edge < boundarySec, `expected earlier, got ${edge}`);
});
