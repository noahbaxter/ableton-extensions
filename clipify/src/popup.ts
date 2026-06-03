// Popup controller: wires the DOM, draws the clip waveforms, and renders the
// selection. All cut/strip decisions come from computeSelection — the popup holds
// no DSP/selection logic of its own. Bundled into popup.html at build time.

import type { Candidate } from "./candidates.js";
import type { Settings } from "./settings.js";
import { computeSelection } from "./select.js";

interface ClipView {
  name: string;
  winStartBeat: number;
  winEndBeat: number;
  envelope: number[];
  noiseFloorLevel: number;
  candidates: Candidate[];
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
    const r = computeSelection(clip.candidates, state, portions, clip.winStartBeat, clip.winEndBeat);
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

  for (const d of clips) {
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
  }
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
function bindToggle(squareId: string, key: "splitOn" | "stripOn", bodyId: string): void {
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

  bindToggle("split-toggle", "splitOn", "split-body");
  bindToggle("strip-toggle", "stripOn", "strip-body");
  bindSeg("mode", "mode", () => {
    sensEl.value = String(sens());
    fill(sensEl);
  });
  bindSeg("cutat", "cutAt");
  bindSeg("action", "stripAction");
  bindSeg("thresh", "thresh");

  el("cancel").addEventListener("click", () => sendResult({ action: "cancel", settings: state }));
  el("apply").addEventListener("click", () =>
    sendResult({ action: "apply", settings: state }),
  );

  selectCuts();
}

init();
