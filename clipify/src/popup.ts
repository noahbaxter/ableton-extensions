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
}

const el = (id: string) => document.getElementById(id) as HTMLElement;
const sens = () => (state.mode === "MACRO" ? state.sensMacro : state.sensMicro);
const setSens = (v: number) => {
  if (state.mode === "MACRO") state.sensMacro = v;
  else state.sensMicro = v;
};

function selectCuts(): void {
  const portions = { split: state.splitOn, strip: state.stripOn };
  let cuts = 0;
  let strips = 0;
  const drawn: ClipDraw[] = DATA.clips.map((clip) => {
    if (portions.strip && !clip.hasContent) {
      strips += 1; // whole clip is below threshold → stripped entirely
      return { clip, cuts: [], strips: [{ f0: 0, f1: 1 }] };
    }
    const r = computeSelection(clip.candidates, state, portions, clip.winStartBeat, clip.winEndBeat, clip.valleys);
    cuts += r.cutBeats.length;
    strips += r.strips.length;
    return { clip, cuts: r.drawCuts, strips: r.drawStrips };
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

  const levels = state.levelOn ? levelPreview(clips.map((d) => d.clip)) : null;

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

    // cuts
    g.strokeStyle = accent;
    g.lineWidth = 1.5;
    g.beginPath();
    for (const f of d.cuts) {
      const x = x0 + f * cw;
      g.moveTo(x, 0);
      g.lineTo(x, H);
    }
    g.stroke();

    // level preview: per-clip gain as a horizontal line — above center = boost,
    // below = reduce. Full ±maxChange maps to ~40% of the canvas height each way.
    const gainDb = levels?.[i];
    if (gainDb != null) {
      const y = H / 2 - (gainDb / state.maxChangeDb) * (H * 0.4);
      g.beginPath();
      g.moveTo(x0, y);
      g.lineTo(x1, y);
      g.lineWidth = 5; // dark halo for legibility over the waveform
      g.strokeStyle = "rgba(0, 0, 0, 0.6)";
      g.stroke();
      g.lineWidth = 3;
      g.strokeStyle = accent;
      g.stroke();
    }
  }
}

// Rough per-clip gain (signed dB) from the waveform envelope, mirroring level.ts: a
// common RMS target = min(ceiling − crest) across clips, each clip moved toward it
// (up or down) clamped by max-change. null = silent clip. Approximate — the real
// gains are measured at apply.
function levelPreview(views: ClipView[]): (number | null)[] {
  const ests = views.map((v) => {
    let sq = 0;
    let pk = 0;
    for (const e of v.envelope) {
      sq += e * e;
      if (e > pk) pk = e;
    }
    const rmsDb = v.envelope.length && sq > 0 ? 10 * Math.log10(sq / v.envelope.length) : -Infinity;
    const peakDb = pk > 0 ? 20 * Math.log10(pk) : -Infinity;
    return { rmsDb, peakDb };
  });
  const valid = ests.filter((e) => Number.isFinite(e.rmsDb) && Number.isFinite(e.peakDb));
  if (!valid.length) return ests.map(() => null);
  const target = Math.min(...valid.map((e) => state.ceilingDb - (e.peakDb - e.rmsDb)));

  return ests.map((e) =>
    Number.isFinite(e.rmsDb)
      ? Math.max(-state.maxChangeDb, Math.min(state.maxChangeDb, target - e.rmsDb))
      : null,
  );
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
): void {
  const input = el(id) as HTMLInputElement;
  const val = el(id + "-val");
  const paint = () => {
    fill(input);
    val.textContent = fmt(parseFloat(input.value));
  };
  input.value = String(get());
  paint();
  input.addEventListener("input", () => {
    set(parseFloat(input.value));
    paint();
    selectCuts();
  });
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

// Ceiling slider reads in dB (−6…0), not 0…1, so it paints its own fill + readout.
function wireCeiling(): void {
  const input = el("ceiling") as HTMLInputElement;
  const min = Number(input.min);
  const max = Number(input.max);
  const paint = () => {
    const v = Number(input.value);
    input.style.setProperty("--fill", ((v - min) / (max - min)) * 100 + "%");
    el("ceiling-val").textContent = v.toFixed(1);
  };
  input.value = String(state.ceilingDb);
  paint();
  input.addEventListener("input", () => {
    state.ceilingDb = parseFloat(input.value);
    paint();
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
  wireSlider(
    "silence",
    () => state.silence,
    (v) => (state.silence = v),
  );
  // Detail (valley sensitivity): 0% = off (depth 1.0), 100% = most cuts (depth 0.2).
  wireReadoutSlider(
    "detail",
    () => (1 - state.valleyDepth) / 0.8,
    (v) => (state.valleyDepth = 1 - 0.8 * v),
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
  });
  bindSeg("cutat", "cutAt");
  bindSeg("action", "stripAction");
  bindSeg("thresh", "thresh");
  wireCeiling();
  wireMaxChange();

  el("cancel").addEventListener("click", () => sendResult({ action: "cancel", settings: state }));
  el("apply").addEventListener("click", () =>
    sendResult({ action: "apply", settings: state }),
  );

  selectCuts();
}

init();
