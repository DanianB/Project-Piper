// src/services/voice/wav_pcm.js
// Minimal WAV parser to extract PCM16LE frames for browser streaming.
// Designed to be dependency-free and sync.
// If the WAV is not PCM16LE, we fall back to best-effort extraction or throw.

function readUInt32LE(buf, off) {
  return buf.readUInt32LE(off);
}
function readUInt16LE(buf, off) {
  return buf.readUInt16LE(off);
}


function downmixInt16InterleavedToMono(data, channels) {
  if (!data || channels <= 1) return data;
  const totalSamples = Math.floor(data.length / 2);
  const frames = Math.floor(totalSamples / channels);
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let ch = 0; ch < channels; ch++) {
      acc += data.readInt16LE((i * channels + ch) * 2);
    }
    const v = Math.round(acc / channels);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
  return out;
}


export function wavToPcm16le(wavBytes) {
  const buf = Buffer.isBuffer(wavBytes) ? wavBytes : Buffer.from(wavBytes || []);
  if (buf.length < 44) {
    throw new Error("WAV too small");
  }
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file");
  }

  let fmt = null;
  let data = null;

  // chunks start at 12
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = readUInt32LE(buf, off + 4);
    const chunkStart = off + 8;
    const chunkEnd = chunkStart + size;

    if (chunkEnd > buf.length) break;

    if (id === "fmt ") {
      // PCM fmt chunk min 16 bytes
      if (size < 16) throw new Error("Invalid fmt chunk");
      const audioFormat = readUInt16LE(buf, chunkStart + 0); // 1 = PCM
      const channels = readUInt16LE(buf, chunkStart + 2);
      const sampleRate = readUInt32LE(buf, chunkStart + 4);
      const byteRate = readUInt32LE(buf, chunkStart + 8);
      const blockAlign = readUInt16LE(buf, chunkStart + 12);
      const bitsPerSample = readUInt16LE(buf, chunkStart + 14);
      fmt = { audioFormat, channels, sampleRate, byteRate, blockAlign, bitsPerSample };
    } else if (id === "data") {
      data = buf.slice(chunkStart, chunkEnd);
    }

    // Chunks are word-aligned (pad to even)
    off = chunkEnd + (size % 2);
    if (fmt && data) break;
  }

  if (!fmt || !data) {
    throw new Error("WAV missing fmt/data chunks");
  }

  // If it's already PCM16LE, return directly.
  // PCM (1) with 16 bits implies little-endian in RIFF WAV.
  if (fmt.audioFormat === 1 && fmt.bitsPerSample === 16) {
    const mono = downmixInt16InterleavedToMono(data, fmt.channels);
    return {
      pcmBytes: mono,
      sampleRate: fmt.sampleRate,
      channels: 1,
    };
  }

  // Best-effort: if it's 32-bit float, down-convert to 16-bit (clamp).
  if (fmt.audioFormat === 3 && fmt.bitsPerSample === 32) {
    const channels = fmt.channels || 1;
    const totalFloats = Math.floor(data.length / 4);
    const frames = Math.floor(totalFloats / channels);
    const out = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i++) {
      let acc = 0;
      for (let ch = 0; ch < channels; ch++) {
        acc += data.readFloatLE((i * channels + ch) * 4);
      }
      const f = acc / channels;
      const s = Math.max(-1, Math.min(1, f));
      const v = Math.round(s * 32767);
      out.writeInt16LE(v, i * 2);
    }
    return { pcmBytes: out, sampleRate: fmt.sampleRate, channels: 1 };
  }

  // Otherwise, caller should convert via ffmpeg before calling this helper.
  throw new Error(
    `Unsupported WAV format audioFormat=${fmt.audioFormat} bits=${fmt.bitsPerSample}. Convert to PCM16LE first.`
  );
}
