// Persist the popup's controls across runs, in the extension's storage directory.
// Missing/unreadable file → built-in defaults; saving never throws.

import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface Settings {
  // detection — global; drives BOTH splits and strip
  mode: "MACRO" | "MICRO";
  sensMacro: number; // 0..1, MACRO's own sensitivity
  sensMicro: number; // 0..1, MICRO's own sensitivity
  valleyDepth: number; // min dip depth (0..1, peak→floor) to cut inside a segment; 1 = off
  valleyMinWidthMs: number; // a dip must last at least this long to count as a cut
  cullDb: number; // segments quieter than this (dB above floor) fold into silence; 0 = off
  // splits
  splitOn: boolean; // SPLITS section enabled
  cutAt: "start" | "end" | "both"; // which phrase edges to cut
  // strip
  stripOn: boolean; // STRIP section enabled
  stripAction: "deactivate" | "delete";
  thresh: "silence" | "quiet" | "content"; // what the strip targets
  silence: number; // 0..1, strip-zone extent
  // level
  levelOn: boolean; // LEVEL section enabled
  ceilingDb: number; // dBFS peak ceiling a boost may not exceed
  maxChangeDb: 6 | 12 | 24; // hardest boost allowed on any one clip
  // advanced
  avgAcrossClips: boolean; // share one noise floor across all selected clips
}

const DEFAULTS: Settings = {
  mode: "MACRO",
  sensMacro: 0.5,
  sensMicro: 0.7,
  valleyDepth: 1, // off — admits no intra-segment valleys (today's behaviour)
  valleyMinWidthMs: 25,
  cullDb: 0, // off — culls nothing (every real segment is > 0 dB above the floor)
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
