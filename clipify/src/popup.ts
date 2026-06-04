// Popup controller: wires the DOM, draws the clip waveforms, and renders the
// selection. All cut/strip decisions come from computeSelection — the popup holds
// no DSP/selection logic of its own. Bundled into popup.html at build time.

import type { Candidate } from "./candidates.js";
import type { Settings } from "./settings.js";
import { computeSelection, type ValleyCut } from "./select.js";

interface ClipView {
  name: string;
  winStartBeat: number;
  winEndBeat: number;
  envelope: number[];
  noiseFloorLevel: number;
  candidates: Candidate[];
  valleys: ValleyCut[];
  hasContent: boolean;
}

interface PopupData {
  clips: ClipView[];
  spanStartBeat: number;
  spanEndBeat: number;
  defaults: Settings;
}

declare const DATA: PopupData; // injected by the host (slicer.ts replaces __DATA__)

const state: Settings = { ...DATA.defaults };

interface ClipDraw {
  clip: ClipView;
  cuts: number[]; // window fractions [0,1]
  strips: { f0: number; f1: number }[];
  segments: number[]; // window fractions of segment boundaries (always shown)
}

const el = (id: string) => document.getElementById(id) as HTMLElement;
const sens = () => (state.mode === "MACRO" ? state.sensMacro : state.sensMicro);
const setSens = (v: number) => {
  if (state.mode === "MACRO") state.sensMacro = v;
  else state.sensMicro = v;
};
const detail = () => (state.mode === "MACRO" ? state.valleyDepthMacro : state.valleyDepthMicro);
const setDetail = (v: number) => {
  if (state.mode === "MACRO") state.valleyDepthMacro = v;
  else state.valleyDepthMicro = v;
};

function selectCuts(): void {
  const portions = { split: state.splitOn, strip: state.stripOn };
  let cuts = 0;
  let strips = 0;
  const drawn: ClipDraw[] = DATA.clips.map((clip) => {
    if (portions.strip && !clip.hasContent) {
      strips += 1; // whole clip is below threshold → stripped entirely
      return { clip, cuts: [], strips: [{ f0: 0, f1: 1 }], segments: [] };
    }
    const r = computeSelection(clip.candidates, state, portions, clip.winStartBeat, clip.winEndBeat, clip.valleys);
    cuts += r.drawCuts.length; // visible slice cuts only — strip boundaries are shown as fill, not counted as slices
    strips += r.strips.length;
    return { clip, cuts: r.drawCuts, strips: r.drawStrips, segments: r.drawSegments };
  });

  draw(drawn);
  const pieces = cuts + DATA.clips.length;
  let label = pieces + (pieces === 1 ? " slice" : " slices");
  if (strips) label += " · " + strips + " stripped";
  el("count").textContent = label;
}

function draw(clips: ClipDraw[]): void {
  const cv = el("wave") as HTMLCanvasElement;
  const g = cv.getContext("2d")!;
  const W = cv.width;
  const H = cv.height;
  const mid = H / 2;
  const css = getComputedStyle(document.documentElement);
  const span = DATA.spanEndBeat - DATA.spanStartBeat || 1;
  const toX = (beat: number) => ((beat - DATA.spanStartBeat) / span) * W;

  g.clearRect(0, 0, W, H);
  const stripColor = css.getPropertyValue("--strip");
  const waveColor = css.getPropertyValue("--wave");
  const accent = css.getPropertyValue("--accent");

  const levels = state.levelOn ? levelPreview(clips) : null;

  // level preview: 0 dB (no-change) reference line; per-clip gain lines drawn in the loop
  if (levels) {
    g.strokeStyle = "rgba(255, 255, 255, 0.16)";
    g.setLineDash([4, 4]);
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, H / 2);
    g.lineTo(W, H / 2);
    g.stroke();
    g.setLineDash([]);
  }

  for (let i = 0; i < clips.length; i++) {
    const d = clips[i]!;
    // inset 1px each side so adjacent clips show a thin dark seam
    const x0 = toX(d.clip.winStartBeat) + 1;
    const x1 = toX(d.clip.winEndBeat) - 1;
    const cw = Math.max(1, x1 - x0);

    // strip regions
    g.fillStyle = stripColor;
    for (const r of d.strips) g.fillRect(x0 + r.f0 * cw, 0, Math.max(1, (r.f1 - r.f0) * cw), H);

    // noise floor reference
    const nf = (d.clip.noiseFloorLevel || 0) * mid;
    g.strokeStyle = "#3a3a3a";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x0, mid - nf);
    g.lineTo(x1, mid - nf);
    g.moveTo(x0, mid + nf);
    g.lineTo(x1, mid + nf);
    g.stroke();

    // waveform
    const env = d.clip.envelope;
    const n = env.length;
    g.strokeStyle = waveColor;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const x = x0 + (i / n) * cw;
      const h = (env[i] ?? 0) * mid;
      g.moveTo(x, mid - h);
      g.lineTo(x, mid + h);
    }
    g.stroke();

    // segment boundaries — always shown, dotted grey, so the detected segmentation is
    // visible even with slice/strip/level off; the active slices draw orange over these
    g.strokeStyle = "#777";
    g.lineWidth = 1;
    g.setLineDash([2, 3]);
    g.beginPath();
    for (const f of d.segments) {
      const x = x0 + f * cw;
      g.moveTo(x, 0);
      g.lineTo(x, H);
    }
    g.stroke();
    g.setLineDash([]);

    // slice cuts — solid accent, on top of the grey segment dividers
    g.strokeStyle = accent;
    g.lineWidth = 1.5;
    g.beginPath();
    for (const f of d.cuts) {
      const x = x0 + f * cw;
      g.moveTo(x, 0);
      g.lineTo(x, H);
    }
    g.stroke();

    // level preview: a horizontal gain line per content segment (each becomes its own
    // clip at apply) — above center = boost, below = reduce. ±maxChange ≈ 40% of height.
    for (const sg of levels?.[i] ?? []) {
      const sx0 = x0 + sg.f0 * cw;
      const sx1 = x0 + sg.f1 * cw;
      const y = H / 2 - (sg.gainDb / state.maxChangeDb) * (H * 0.4);
      g.beginPath();
      g.moveTo(sx0, y);
      g.lineTo(sx1, y);
      g.lineWidth = 5; // dark halo for legibility over the waveform
      g.strokeStyle = "rgba(0, 0, 0, 0.6)";
      g.stroke();
      g.lineWidth = 3;
      g.strokeStyle = accent;
      g.stroke();

      // gain readout, only when the segment is wide enough to fit it without crowding
      if (sx1 - sx0 >= 46) {
        const txt = (sg.gainDb >= 0 ? "+" : "") + sg.gainDb.toFixed(1);
        g.font = "600 15px -apple-system, system-ui, sans-serif";
        g.textAlign = "center";
        g.textBaseline = "bottom";
        g.lineWidth = 3;
        g.strokeStyle = "rgba(0, 0, 0, 0.7)"; // halo
        g.strokeText(txt, (sx0 + sx1) / 2, y - 3);
        g.fillStyle = accent;
        g.fillText(txt, (sx0 + sx1) / 2, y - 3);
      }
    }
  }
}

interface SegGain {
  f0: number;
  f1: number;
  gainDb: number;
}

// The kept content segments of a clip: the timeline split by the slice cuts and the
// strip-region edges, with the stripped regions themselves removed. Each becomes its
// own clip at apply, so each is leveled independently.
function contentSegments(cuts: number[], strips: { f0: number; f1: number }[]): { f0: number; f1: number }[] {
  const bounds = [0, 1, ...cuts];
  for (const s of strips) bounds.push(s.f0, s.f1);
  const sorted = [...new Set(bounds)].sort((a, b) => a - b);
  const out: { f0: number; f1: number }[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const f0 = sorted[i]!;
    const f1 = sorted[i + 1]!;
    if (f1 - f0 < 0.004) continue; // ignore slivers
    const mid = (f0 + f1) / 2;
    if (strips.some((s) => mid > s.f0 && mid < s.f1)) continue; // stripped — not a kept clip
    out.push({ f0, f1 });
  }
  return out;
}

// RMS/peak (dBFS) of the envelope over a fraction range. Envelope is downsampled peaks
// so this is approximate — real gains are measured from PCM at apply.
function measureRange(env: number[], f0: number, f1: number): { rmsDb: number; peakDb: number } {
  const n = env.length;
  const i0 = Math.max(0, Math.floor(f0 * n));
  const i1 = Math.min(n, Math.max(i0 + 1, Math.ceil(f1 * n)));
  let sq = 0;
  let pk = 0;
  for (let i = i0; i < i1; i++) {
    const e = env[i] ?? 0;
    sq += e * e;
    if (e > pk) pk = e;
  }
  const cnt = i1 - i0;
  return {
    rmsDb: cnt && sq > 0 ? 10 * Math.log10(sq / cnt) : -Infinity,
    peakDb: pk > 0 ? 20 * Math.log10(pk) : -Infinity,
  };
}

// Per content-segment gain (signed dB), mirroring level.ts: a common target — either
// min(ceiling − crest) across all segments, or their mean RMS in "average" mode —
// with each segment moved toward it, clamped by max-change. Returns one list per clip.
function levelPreview(clips: ClipDraw[]): SegGain[][] {
  const out: SegGain[][] = clips.map(() => []);
  const all: { ci: number; f0: number; f1: number; rmsDb: number; peakDb: number }[] = [];
  clips.forEach((d, ci) => {
    for (const r of contentSegments(d.cuts, d.strips)) {
      const m = measureRange(d.clip.envelope, r.f0, r.f1);
      if (Number.isFinite(m.rmsDb) && Number.isFinite(m.peakDb)) all.push({ ci, ...r, ...m });
    }
  });
  if (!all.length) return out;
  const ceilingLimit = Math.min(...all.map((s) => state.ceilingDb - (s.peakDb - s.rmsDb)));
  const meanRms = all.reduce((sum, s) => sum + s.rmsDb, 0) / all.length;
  const target = state.levelTarget === "average" ? Math.min(meanRms, ceilingLimit) : ceilingLimit;
  for (const s of all) {
    const gainDb = Math.max(-state.maxChangeDb, Math.min(state.maxChangeDb, target - s.rmsDb));
    out[s.ci]!.push({ f0: s.f0, f1: s.f1, gainDb });
  }
  return out;
}

function bindSeg(id: string, key: keyof Settings, after?: () => void): void {
  const box = el(id);
  box.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      (state as unknown as Record<string, unknown>)[key] = b.getAttribute("data-val");
      box.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      if (after) after();
      selectCuts();
    });
    b.classList.toggle("on", b.getAttribute("data-val") === state[key]);
  });
}

// Orange-square section enable: toggles a boolean setting and shows/hides the body.
function bindToggle(squareId: string, key: "splitOn" | "stripOn" | "levelOn", bodyId: string): void {
  const square = el(squareId);
  const sync = () => {
    square.classList.toggle("off", !state[key]);
    el(bodyId).classList.toggle("hide", !state[key]);
  };
  square.addEventListener("click", () => {
    state[key] = !state[key];
    sync();
    selectCuts();
  });
  sync();
}

const fill = (input: HTMLInputElement) => input.style.setProperty("--fill", Number(input.value) * 100 + "%");

function wireSlider(id: string, get: () => number, set: (v: number) => void): HTMLInputElement {
  const input = el(id) as HTMLInputElement;
  input.value = String(get());
  fill(input);
  input.addEventListener("input", () => {
    set(parseFloat(input.value));
    fill(input);
    selectCuts();
  });
  input.addEventListener("dblclick", () => {
    input.value = "0.5";
    set(0.5);
    fill(input);
    selectCuts();
  });
  return input;
}

// Slider that shows a units readout in its adjacent .val span. The 0..1 slider value
// maps to the setting via get/set; fmt turns the slider value into the readout text.
// No double-click reset (these controls' "off" is an end of the range, not the middle).
function wireReadoutSlider(
  id: string,
  get: () => number,
  set: (v: number) => void,
  fmt: (sliderVal: number) => string,
): () => void {
  const input = el(id) as HTMLInputElement;
  const val = el(id + "-val");
  const paint = () => {
    fill(input);
    val.textContent = fmt(parseFloat(input.value));
  };
  const refresh = () => {
    input.value = String(get());
    paint();
  };
  refresh();
  input.addEventListener("input", () => {
    set(parseFloat(input.value));
    paint();
    selectCuts();
  });
  return refresh; // re-sync the slider to get() when the underlying value changes (e.g. mode switch)
}

function sendResult(payload: unknown): void {
  const msg = JSON.stringify(payload);
  const w = window as unknown as {
    webkit?: { messageHandlers?: { live?: { postMessage(m: unknown): void } } };
    chrome?: { webview?: { postMessage(m: unknown): void } };
  };
  if (w.webkit?.messageHandlers?.live) {
    w.webkit.messageHandlers.live.postMessage({ method: "close_and_send", params: [msg] });
  } else if (w.chrome?.webview) {
    w.chrome.webview.postMessage({ method: "close_and_send", params: [msg] });
  }
}

// Normalize control: the switch picks what every clip is matched to. Off = their
// shared average (default — no overall gain change); on = the ceiling value (the
// slider, in dB, −6…0). The slider only matters in ceiling mode, so it's disabled
// (and the readout shows "avg") otherwise.
function wireNormalize(): void {
  const sq = el("boost-toggle");
  const input = el("ceiling") as HTMLInputElement;
  const min = Number(input.min);
  const max = Number(input.max);
  const sync = () => {
    const toCeiling = state.levelTarget === "ceiling";
    sq.classList.toggle("off", !toCeiling);
    input.disabled = !toCeiling;
    const v = Number(input.value);
    input.style.setProperty("--fill", ((v - min) / (max - min)) * 100 + "%");
    el("ceiling-val").textContent = toCeiling ? v.toFixed(1) : "avg";
  };
  input.value = String(state.ceilingDb);
  sync();
  sq.addEventListener("click", () => {
    state.levelTarget = state.levelTarget === "ceiling" ? "average" : "ceiling";
    sync();
    selectCuts();
  });
  input.addEventListener("input", () => {
    state.ceilingDb = parseFloat(input.value);
    sync();
    selectCuts();
  });
}

function wireMaxChange(): void {
  const box = el("maxchange");
  box.querySelectorAll("button").forEach((b) => {
    const val = Number(b.getAttribute("data-val")) as Settings["maxChangeDb"];
    b.classList.toggle("on", val === state.maxChangeDb);
    b.addEventListener("click", () => {
      state.maxChangeDb = val;
      box.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      selectCuts();
    });
  });
}

function init(): void {
  const count = DATA.clips.length;
  el("subtitle").textContent =
    count === 1 ? DATA.clips[0]!.name : `${count} clips selected`;

  const sensEl = wireSlider("sens", sens, setSens);
  // Detail (valley sensitivity), per mode: 0% = off (depth 1.0), 100% = most cuts (depth 0.2).
  const detailRefresh = wireReadoutSlider(
    "detail",
    () => (1 - detail()) / 0.8,
    (v) => setDetail(1 - 0.8 * v),
    (v) => Math.round(v * 100) + "%",
  );
  // Cull: how far above the noise floor a segment must reach to survive, 0–40 dB (0 = off).
  // Past ~40 dB you'd be culling genuinely loud content, so the range stops there.
  wireReadoutSlider(
    "cull",
    () => state.cullDb / 40,
    (v) => (state.cullDb = 40 * v),
    (v) => Math.round(v * 40) + " dB",
  );

  bindToggle("split-toggle", "splitOn", "split-body");
  bindToggle("strip-toggle", "stripOn", "strip-body");
  bindToggle("level-toggle", "levelOn", "level-body");
  bindSeg("mode", "mode", () => {
    sensEl.value = String(sens());
    fill(sensEl);
    detailRefresh(); // Sens and Detail are per-mode — re-sync both when the mode flips
  });
  bindSeg("cutat", "cutAt");
  bindSeg("action", "stripAction");
  bindSeg("thresh", "thresh");
  wireNormalize();
  wireMaxChange();

  el("cancel").addEventListener("click", () => sendResult({ action: "cancel", settings: state }));
  el("apply").addEventListener("click", () =>
    sendResult({ action: "apply", settings: state }),
  );

  selectCuts();
}

init();
