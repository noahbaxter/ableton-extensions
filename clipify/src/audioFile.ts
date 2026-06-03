// Native WAV/AIFF PCM access. renderPreFxAudio returns whatever the Ableton host
// renders — WAV (little-endian) or AIFF (big-endian, macOS default), 16/24/32-bit
// int or 32-bit float. For the leveled output we DON'T re-encode to a fixed format:
// we scale the samples in place inside the rendered file's own bytes and keep its
// exact container/header. The file we import is therefore a format Live just used.

export interface PcmFormat {
  container: "wav" | "aiff";
  littleEndian: boolean; // WAV = LE, AIFF = BE
  bitDepth: number; // 16 | 24 | 32
  isFloat: boolean; // 32-bit IEEE float
  numChannels: number;
  sampleRate: number;
  dataOffset: number; // byte offset where PCM samples begin
  dataBytes: number; // length of the PCM data in bytes
}

const ascii = (buf: Buffer, o: number) => buf.toString("ascii", o, o + 4);

// AIFF stores the sample rate as an 80-bit IEEE extended float.
function readExtended(buf: Buffer, o: number): number {
  const exp = (buf.readUInt16BE(o) & 0x7fff) - 16383;
  const hi = buf.readUInt32BE(o + 2);
  const lo = buf.readUInt32BE(o + 6);
  return hi * Math.pow(2, exp - 31) + lo * Math.pow(2, exp - 63);
}

export function sniffPcm(buf: Buffer): PcmFormat {
  const sig = ascii(buf, 0);
  if (sig === "RIFF") return sniffWav(buf);
  if (sig === "FORM") return sniffAiff(buf);
  throw new Error(`unrecognised audio container "${sig}" — expected RIFF (WAV) or FORM (AIFF)`);
}

function sniffWav(buf: Buffer): PcmFormat {
  if (ascii(buf, 8) !== "WAVE") throw new Error("not a WAVE file");
  let numChannels = 0, sampleRate = 0, bitDepth = 0, isFloat = false;
  let dataOffset = -1, dataBytes = 0;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = ascii(buf, pos);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt ") {
      isFloat = buf.readUInt16LE(body) === 3; // 1 = PCM int, 3 = IEEE float
      numChannels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitDepth = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      dataOffset = body;
      dataBytes = size === 0xffffffff ? buf.length - body : size;
    }
    pos = body + size + (size & 1); // chunks are word-aligned
  }
  if (dataOffset < 0 || !numChannels) throw new Error("WAV: missing fmt or data chunk");
  return { container: "wav", littleEndian: true, bitDepth, isFloat, numChannels, sampleRate, dataOffset, dataBytes };
}

function sniffAiff(buf: Buffer): PcmFormat {
  const form = ascii(buf, 8);
  if (form !== "AIFF" && form !== "AIFC") throw new Error(`unsupported AIFF variant "${form}"`);
  let numChannels = 0, sampleRate = 0, bitDepth = 0, isFloat = false;
  let dataOffset = -1, dataBytes = 0;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = ascii(buf, pos);
    const size = buf.readUInt32BE(pos + 4);
    const body = pos + 8;
    if (id === "COMM") {
      numChannels = buf.readUInt16BE(body);
      bitDepth = buf.readUInt16BE(body + 6);
      sampleRate = readExtended(buf, body + 8);
      if (form === "AIFC") {
        const comp = ascii(buf, body + 18); // compression type follows the 80-bit rate
        isFloat = comp === "fl32" || comp === "FL32";
      }
    } else if (id === "SSND") {
      const pcmOffset = buf.readUInt32BE(body); // almost always 0
      dataOffset = body + 8 + pcmOffset;
      dataBytes = size - 8 - pcmOffset;
    }
    pos = body + size + (size & 1);
  }
  if (dataOffset < 0 || !numChannels) throw new Error("AIFF: missing COMM or SSND chunk");
  return { container: "aiff", littleEndian: false, bitDepth, isFloat, numChannels, sampleRate, dataOffset, dataBytes };
}

function read24(buf: Buffer, o: number, le: boolean): number {
  let v = le ? buf[o]! | (buf[o + 1]! << 8) | (buf[o + 2]! << 16) : (buf[o]! << 16) | (buf[o + 1]! << 8) | buf[o + 2]!;
  if (v & 0x800000) v |= ~0xffffff; // sign-extend
  return v;
}

function write24(buf: Buffer, o: number, v: number, le: boolean): void {
  if (le) {
    buf[o] = v & 0xff; buf[o + 1] = (v >> 8) & 0xff; buf[o + 2] = (v >> 16) & 0xff;
  } else {
    buf[o] = (v >> 16) & 0xff; buf[o + 1] = (v >> 8) & 0xff; buf[o + 2] = v & 0xff;
  }
}

// Decode a rendered WAV/AIFF to per-channel float PCM for analysis. Handles every
// format renderPreFxAudio emits (WAV/AIFF, 16/24/32 int, 32 float) — which is why
// we parse natively instead of depending on a decoder that can't read AIFF.
export function decodePcm(buf: Buffer): { channels: Float32Array[]; sampleRate: number } {
  const f = sniffPcm(buf);
  const step = f.bitDepth / 8;
  const le = f.littleEndian;
  const frames = Math.floor(f.dataBytes / (step * f.numChannels));
  const channels = Array.from({ length: f.numChannels }, () => new Float32Array(frames));

  let p = f.dataOffset;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < f.numChannels; c++) {
      let v: number;
      if (f.isFloat && f.bitDepth === 32) v = le ? buf.readFloatLE(p) : buf.readFloatBE(p);
      else if (f.bitDepth === 16) v = (le ? buf.readInt16LE(p) : buf.readInt16BE(p)) / 32768;
      else if (f.bitDepth === 24) v = read24(buf, p, le) / 8388608;
      else if (f.bitDepth === 32) v = (le ? buf.readInt32LE(p) : buf.readInt32BE(p)) / 2147483648;
      else v = 0;
      channels[c]![i] = v;
      p += step;
    }
  }
  return { channels, sampleRate: f.sampleRate };
}

const clampInt = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// Multiply every PCM sample by `factor`, in the file's native format, returning a
// copy with the header bytes untouched. Boost-only + the ceiling clamp keep peaks
// below full scale, so int requantization can't clip; values are still hard-clamped
// as a safety. No dither — the move is small and boost-only.
export function scalePcm(buf: Buffer, factor: number): Buffer {
  const f = sniffPcm(buf);
  const out = Buffer.from(buf);
  const step = f.bitDepth / 8;
  const le = f.littleEndian;
  const end = Math.min(out.length, f.dataOffset + f.dataBytes);

  for (let p = f.dataOffset; p + step <= end; p += step) {
    let v: number;
    if (f.isFloat && f.bitDepth === 32) v = le ? out.readFloatLE(p) : out.readFloatBE(p);
    else if (f.bitDepth === 16) v = (le ? out.readInt16LE(p) : out.readInt16BE(p)) / 32768;
    else if (f.bitDepth === 24) v = read24(out, p, le) / 8388608;
    else if (f.bitDepth === 32) v = (le ? out.readInt32LE(p) : out.readInt32BE(p)) / 2147483648;
    else continue;

    v *= factor;
    if (v > 1) v = 1; else if (v < -1) v = -1;

    if (f.isFloat && f.bitDepth === 32) le ? out.writeFloatLE(v, p) : out.writeFloatBE(v, p);
    else if (f.bitDepth === 16) { const s = clampInt(Math.round(v * 32768), -32768, 32767); le ? out.writeInt16LE(s, p) : out.writeInt16BE(s, p); }
    else if (f.bitDepth === 24) write24(out, p, clampInt(Math.round(v * 8388608), -8388608, 8388607), le);
    else if (f.bitDepth === 32) { const s = clampInt(Math.round(v * 2147483648), -2147483648, 2147483647); le ? out.writeInt32LE(s, p) : out.writeInt32BE(s, p); }
  }
  return out;
}
