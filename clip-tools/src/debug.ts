// Gated evaluation logging plus the formatting helpers its lines use. One shared
// `debug` instance is used across the extension.

export class Debug {
  constructor(
    readonly enabled: boolean,
    private readonly tag = "[clip-tools]",
  ) {}

  log(...parts: unknown[]): void {
    if (this.enabled) console.log(this.tag, ...parts);
  }

  fmt(value: number, digits = 3): string {
    return value.toFixed(digits);
  }

  // linear amplitude -> dBFS, formatted
  db(linear: number): string {
    return this.fmt(linear > 0 ? 20 * Math.log10(linear) : -Infinity, 1);
  }
}

export const debug = new Debug(true);
