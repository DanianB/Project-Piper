let audioCtx;
let worklet;
let node;

export async function startPCMStream(sampleRate = 24000) {
  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate });
    await audioCtx.audioWorklet.addModule("/audio/pcm-worklet.js");
    node = new AudioWorkletNode(audioCtx, "pcm-player");
    node.connect(audioCtx.destination);
  }
}

export function pushPCMChunk(int16pcm) {
  if (!node) return;

  // Int16 → Float32
  const f32 = new Float32Array(int16pcm.length);
  for (let i = 0; i < int16pcm.length; i++) {
    f32[i] = int16pcm[i] / 32768;
  }

  node.port.postMessage({ pcm: f32 });
}
