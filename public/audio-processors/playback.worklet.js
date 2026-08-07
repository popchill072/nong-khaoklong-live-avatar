class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.audioQueue = [];
    this.currentOffset = 0;
    this.volume = (sampleRate && this.options && this.options.volume) || 1.9;
    this.port.onmessage = (event) => {
      if (event.data === "interrupt") {
        this.audioQueue = [];
        this.currentOffset = 0;
      } else if (event.data instanceof Float32Array) {
        this.audioQueue.push(event.data);
      }
    };
  }
  process(inputs, outputs) {
    const output = outputs[0];
    if (output.length === 0) return true;
    const channel = output[0];
    let outputIndex = 0;
    while (outputIndex < channel.length && this.audioQueue.length > 0) {
      const currentBuffer = this.audioQueue[0];
      if (!currentBuffer || currentBuffer.length === 0) {
        this.audioQueue.shift();
        this.currentOffset = 0;
        continue;
      }
      const remainingOutput = channel.length - outputIndex;
      const remainingBuffer = currentBuffer.length - this.currentOffset;
      const copyLength = Math.min(remainingOutput, remainingBuffer);
      for (let i = 0; i < copyLength; i++) {
        let s = currentBuffer[this.currentOffset++] * this.volume;
        // soft clip (tanh) keeps gain high without harsh distortion
        s = Math.tanh(s * 1.2) / 1.2;
        channel[outputIndex++] = s;
      }
      if (this.currentOffset >= currentBuffer.length) {
        this.audioQueue.shift();
        this.currentOffset = 0;
      }
    }
    while (outputIndex < channel.length) channel[outputIndex++] = 0;
    return true;
  }
}
registerProcessor("pcm-processor", PCMProcessor);