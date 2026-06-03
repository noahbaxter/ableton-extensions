import { initialize, type ActivationContext, type Handle } from "@ableton-extensions/sdk";

import { ClipSlicer } from "./slicer.js";

// Each grain level is a keepFraction (see planCuts): the fraction of gaps that
// become cuts, largest first. Higher = more slices.
const GRAIN_LEVELS = [
  { id: "clip-tools.slice.gentle", label: "SLICE AT GAPS (GENTLE)", keepFraction: 0.15 },
  { id: "clip-tools.slice.medium", label: "SLICE AT GAPS (MEDIUM)", keepFraction: 0.45 },
  { id: "clip-tools.slice.aggressive", label: "SLICE AT GAPS (AGGRESSIVE)", keepFraction: 1.0 },
] as const;

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");

  for (const level of GRAIN_LEVELS) {
    context.commands.registerCommand(level.id, (arg: unknown) => {
      void new ClipSlicer(context, arg as Handle, level.keepFraction).run().catch((e) =>
        console.error("[clip-tools] slice failed:", e),
      );
    });
    context.ui.registerContextMenuAction("AudioClip", level.label, level.id);
  }
}
