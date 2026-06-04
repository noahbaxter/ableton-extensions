import { test } from "node:test";
import assert from "node:assert/strict";
import { valleysInEnvelope, findValleys } from "./valleys.js";

const WD = 0.01; // 10 ms per window
const FLOOR = 0.5;

test("deep wide dip → one valley, high depth, width spans the dip", () => {
  const v = valleysInEnvelope([10, 10, 1, 1, 1, 10, 10], WD, FLOOR);
  assert.equal(v.length, 1);
  assert.ok(v[0]!.depthRatio > 0.9, `depthRatio ${v[0]!.depthRatio}`);
  assert.ok(Math.abs(v[0]!.widthSec - 0.03) < 1e-9, `widthSec ${v[0]!.widthSec}`);
});

test("deep narrow dip → high depth but tiny width", () => {
  const v = valleysInEnvelope([10, 1, 10], WD, FLOOR);
  assert.equal(v.length, 1);
  assert.ok(v[0]!.depthRatio > 0.9);
  assert.ok(Math.abs(v[0]!.widthSec - WD) < 1e-9, `widthSec ${v[0]!.widthSec}`);
});

test("shallow dip → low depth", () => {
  const v = valleysInEnvelope([10, 8, 10], WD, FLOOR);
  assert.equal(v.length, 1);
  assert.ok(v[0]!.depthRatio < 0.3, `depthRatio ${v[0]!.depthRatio}`);
});

test("monotonic ramp → no valleys", () => {
  assert.equal(valleysInEnvelope([1, 2, 3, 4, 5], WD, FLOOR).length, 0);
});

test("flutter → only shallow valleys", () => {
  const v = valleysInEnvelope([5, 4, 5, 4, 5], WD, FLOOR);
  assert.ok(v.length >= 1);
  assert.ok(v.every((x) => x.depthRatio < 0.3), JSON.stringify(v));
});

// two sine bursts with a near-silent gap between → one clear valley in the gap
test("findValleys locates the gap between two bursts", () => {
  const sr = 8000;
  const burst = (sec: number, amp: number) => {
    const out = new Float32Array(Math.round(sec * sr));
    for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * 220 * i) / sr);
    return out;
  };
  const seg = (...parts: Float32Array[]) => {
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Float32Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };
  // 0.10 s loud | 0.05 s near-silent | 0.10 s loud
  const ch = seg(burst(0.1, 0.5), burst(0.05, 0.002), burst(0.1, 0.5));
  const valleys = findValleys([ch], sr, 0, ch.length / sr, 0.01, { windowSize: 64 });
  assert.ok(valleys.length >= 1, `expected a valley, got ${valleys.length}`);
  const deepest = valleys.reduce((a, b) => (b.depthRatio > a.depthRatio ? b : a));
  assert.ok(Math.abs(deepest.timeSec - 0.125) < 0.02, `timeSec ${deepest.timeSec}`);
  assert.ok(deepest.depthRatio > 0.8, `depthRatio ${deepest.depthRatio}`);
  assert.ok(deepest.widthSec > 0.03, `widthSec ${deepest.widthSec}`);
});
