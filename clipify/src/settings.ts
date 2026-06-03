// Persist the popup's last-used controls across runs, in the extension's storage
// directory. Missing/unreadable file → built-in defaults; saving never throws.

import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface Settings {
  mode: "MACRO" | "MICRO";
  cutAt: "start" | "end" | "both"; // which phrase edges to cut (split mode)
  sensMacro: number; // 0..1, MACRO's own sensitivity
  sensMicro: number; // 0..1, MICRO's own sensitivity
  strip: "off" | "deactivate" | "delete";
  silence: number; // 0..1, strip-zone extent
}

const DEFAULTS: Settings = {
  mode: "MACRO",
  cutAt: "both",
  sensMacro: 0.5,
  sensMicro: 0.7,
  strip: "off",
  silence: 0.5,
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
