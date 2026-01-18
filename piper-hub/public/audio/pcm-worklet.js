class PCMPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.port.onmessage = (e) => {
      if (e.data?.pcm) {
        this.buffer.push(new Float32Array(e.data.pcm));
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0][0];
    if (!this.buffer.length) {
      output.fill(0);
      return true;
    }

    const chunk = this.buffer.shift();
    output.set(chunk.subarray(0, output.length));
    return true;
  }
}

registerProcessor("pcm-player", PCMPlayer);
