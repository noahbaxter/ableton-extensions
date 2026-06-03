// Popup controller: wires the DOM, draws the waveform, and renders the selection.
// All cut/strip decisions come from computeSelection — the popup holds no DSP/
// selection logic of its own. Bundled into popup.html at build time.

import type { Candidate } from "./candidates.js";
import type { Settings } from "./settings.js";
import { computeSelection } from "./select.js";

interface PopupData {
  meta: { subtitle: string };
  winStartBeat: number;
  winEndBeat: number;
  envelope: number[];
  noiseFloorLevel: number;
  candidates: Candidate[];
  defaults: Settings;
}

declare const DATA: PopupData; // injected by the host (slicer.ts replaces __DATA__)

const state: Settings = { ...DATA.defaults };
let current: { cutBeats: number[]; strips: { start: number; end: number }[] } = {
  cutBeats: [],
  strips: [],
};

const el = (id: string) => document.getElementById(id) as HTMLElement;
const sens = () => (state.mode === "MACRO" ? state.sensMacro : state.sensMicro);
const setSens = (v: number) => {
  if (state.mode === "MACRO") state.sensMacro = v;
  else state.sensMicro = v;
};

function selectCuts(): void {
  const portions = { split: state.strip === "off", strip: state.strip !== "off" };
  const r = computeSelection(DATA.candidates, state, portions, DATA.winStartBeat, DATA.winEndBeat);
  current = { cutBeats: r.cutBeats, strips: r.strips };
  draw(r.drawCuts, r.drawStrips);
  const pieces = r.cutBeats.length + 1;
  let label = pieces + (pieces === 1 ? " slice" : " slices");
  if (r.strips.length) label += " · " + r.strips.length + " stripped";
  el("count").textContent = label;
}

function draw(cuts: number[], strips: { f0: number; f1: number }[]): void {
  const cv = el("wave") as HTMLCanvasElement;
  const g = cv.getContext("2d")!;
  const W = cv.width;
  const H = cv.height;
  const mid = H / 2;
  const css = getComputedStyle(document.documentElement);
  g.clearRect(0, 0, W, H);

  g.fillStyle = css.getPropertyValue("--strip");
  for (const r of strips) g.fillRect(r.f0 * W, 0, Math.max(1, (r.f1 - r.f0) * W), H);

  const nf = (DATA.noiseFloorLevel || 0) * mid;
  g.strokeStyle = "#3a3a3a";
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, mid - nf);
  g.lineTo(W, mid - nf);
  g.moveTo(0, mid + nf);
  g.lineTo(W, mid + nf);
  g.stroke();

  const env = DATA.envelope;
  const n = env.length;
  g.strokeStyle = css.getPropertyValue("--wave");
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const x = (i / n) * W;
    const h = (env[i] ?? 0) * mid;
    g.moveTo(x, mid - h);
    g.lineTo(x, mid + h);
  }
  g.stroke();

  g.strokeStyle = css.getPropertyValue("--accent");
  g.lineWidth = 1.5;
  g.beginPath();
  for (const f of cuts) {
    g.moveTo(f * W, 0);
    g.lineTo(f * W, H);
  }
  g.stroke();
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

function toggleStripRows(): void {
  const off = state.strip === "off";
  el("thresh-row").classList.toggle("hide", off);
  el("silence-row").classList.toggle("hide", off);
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
  el("subtitle").textContent = DATA.meta.subtitle || "";

  const sensEl = wireSlider("sens", sens, setSens);
  wireSlider(
    "silence",
    () => state.silence,
    (v) => (state.silence = v),
  );

  bindSeg("mode", "mode", () => {
    sensEl.value = String(sens());
    fill(sensEl);
  });
  bindSeg("cutat", "cutAt");
  bindSeg("thresh", "thresh");
  bindSeg("strip", "strip", toggleStripRows);

  // Cancel still saves the settings, so tweaks stick even without applying
  el("cancel").addEventListener("click", () => sendResult({ action: "cancel", settings: state }));
  el("apply").addEventListener("click", () =>
    sendResult({
      action: "apply",
      cutBeats: current.cutBeats,
      strips: current.strips,
      stripAction: state.strip,
      settings: state, // persisted for next run
    }),
  );

  toggleStripRows();
  selectCuts();
}

init();
