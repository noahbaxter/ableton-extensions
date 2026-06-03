// Persist the popup's controls across runs, in the extension's storage directory.
// Missing/unreadable file → built-in defaults; saving never throws.

import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface Settings {
  // splits
  splitOn: boolean; // SPLITS section enabled
  mode: "MACRO" | "MICRO";
  cutAt: "start" | "end" | "both"; // which phrase edges to cut
  sensMacro: number; // 0..1, MACRO's own sensitivity
  sensMicro: number; // 0..1, MICRO's own sensitivity
  // strip
  stripOn: boolean; // STRIP section enabled
  stripAction: "deactivate" | "delete";
  thresh: "silence" | "quiet" | "content"; // what the strip targets
  silence: number; // 0..1, strip-zone extent
  // advanced
  avgAcrossClips: boolean; // share one noise floor across all selected clips
}

const DEFAULTS: Settings = {
  splitOn: true,
  mode: "MACRO",
  cutAt: "both",
  sensMacro: 0.5,
  sensMicro: 0.7,
  stripOn: false,
  stripAction: "deactivate",
  thresh: "quiet",
  silence: 0.5,
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
