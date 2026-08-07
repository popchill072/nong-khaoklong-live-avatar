class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 512; // 32ms at 16kHz
    this.buffer = new Float32Array(this.bufferSize);
    this.bufferIndex = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channel = input[0];
      for (let i = 0; i < channel.length; i++) {
        this.buffer[this.bufferIndex++] = channel[i];
        if (this.bufferIndex >= this.bufferSize) {
          this.port.postMessage({ type: "audio", data: this.buffer.slice() });
          this.bufferIndex = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("audio-capture-processor", AudioCaptureProcessor);