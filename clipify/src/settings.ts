// Persist the popup's controls across runs, in the extension's storage directory.
// Missing/unreadable file → built-in defaults; saving never throws.

import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface Settings {
  // detection — global; drives BOTH splits and strip
  mode: "MACRO" | "MICRO";
  sensMacro: number; // 0..1, MACRO's own sensitivity
  sensMicro: number; // 0..1, MICRO's own sensitivity
  valleyDepthMacro: number; // MACRO's valley-cut depth threshold (0..1, peak→floor); 1 = off
  valleyDepthMicro: number; // MICRO's valley-cut depth threshold (0..1); 1 = off
  valleyMinWidthMs: number; // a dip must last at least this long to count as a cut
  cullDb: number; // segments quieter than this (dB above floor) fold into silence; 0 = off
  // splits
  splitOn: boolean; // SPLITS section enabled
  cutAt: "start" | "end" | "both"; // which phrase edges to cut
  // strip
  stripOn: boolean; // STRIP section enabled
  stripAction: "deactivate" | "delete";
  thresh: "silence" | "quiet" | "content"; // what the strip targets
  stripEdge: number; // -1..+1, 0 = detected boundary. + tightens (into attack/release), - loosens
  stripEdgeMode: "level" | "time"; // which engine the Edge knob drives
  stripEdgeClampMs: number; // Level mode: cap edge travel (ms); 0 = off
  // level
  levelOn: boolean; // LEVEL section enabled
  levelTarget: "ceiling" | "average"; // push every clip toward the ceiling, or toward their mean (preserves overall loudness)
  ceilingDb: number; // dBFS peak ceiling a boost may not exceed
  maxChangeDb: 6 | 12 | 24; // hardest boost allowed on any one clip
  // advanced
  avgAcrossClips: boolean; // share one noise floor across all selected clips
}

const DEFAULTS: Settings = {
  mode: "MACRO",
  sensMacro: 0.5,
  sensMicro: 0.7,
  valleyDepthMacro: 1, // off — phrase-level MACRO doesn't split inside segments
  valleyDepthMicro: 0.6, // event-level MICRO splits at moderately-deep dips by default
  valleyMinWidthMs: 25,
  cullDb: 0, // off — culls nothing (every real segment is > 0 dB above the floor)
  splitOn: true,
  cutAt: "both",
  stripOn: false,
  stripAction: "deactivate",
  thresh: "quiet",
  stripEdge: 0,
  stripEdgeMode: "level",
  stripEdgeClampMs: 50,
  levelOn: false,
  levelTarget: "average",
  ceilingDb: -1,
  maxChangeDb: 12,
  avgAcrossClips: true,
};

const FILE = "clipify-settings.json";

export async function loadSettings(dir: string | undefined): Promise<Settings> {
  if (!dir) return { ...DEFAULTS };
  try {
    const raw = await fs.readFile(path.join(dir, FILE), "utf8");
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveSettings(dir: string | undefined, s: Settings): Promise<void> {
  if (!dir) return;
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, FILE), JSON.stringify(s, null, 2));
  } catch (e) {
    console.error("[clipify] couldn't save settings:", e);
  }
}
