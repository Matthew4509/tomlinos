// Printer noises, made on the spot with Web Audio (no sound files): the dot-matrix screech, the whir, the glug of
// ink running out, a paper jam, a rip, a tray, a till. Off until the player turns it on.

export class Sound {
  constructor() {
    this.on = false;
    this.ctx = null;
    this.master = null;
  }

  /** Call from a click (browsers only start sound after one). */
  enable(on) {
    this.on = !!on;
    if (!this.on) return;
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.22;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      this.on = false;
    }
  }

  close() {
    this.on = false;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  noise(seconds) {
    const buffer = this.ctx.createBuffer(1, Math.max(1, Math.floor(this.ctx.sampleRate * seconds)), this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    return src;
  }

  tone(type, freq, start, length, peak = 1, endFreq) {
    const t = this.ctx.currentTime + start;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t + length);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + length + 0.02);
  }

  burst(start, length, freq, q, peak = 1, sweepTo) {
    const t = this.ctx.currentTime + start;
    const src = this.noise(length + 0.05);
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(freq, t);
    if (sweepTo) filter.frequency.exponentialRampToValueAtTime(sweepTo, t + length);
    filter.Q.value = q;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t);
    src.stop(t + length + 0.05);
  }

  play(name) {
    if (!this.on || !this.ctx) return;
    try {
      switch (name) {
        case 'screech': this.burst(0, 0.035, 2200 + Math.random() * 1800, 6, 0.6); break;
        case 'whir':
          this.tone('sawtooth', 70, 0, 1.4, 0.18, 380);
          this.burst(0, 1.4, 600, 1.5, 0.25, 2400);
          break;
        case 'glug':
          for (let i = 0; i < 3; i++) this.tone('sine', 320 - i * 60, i * 0.16, 0.14, 0.9, 110 - i * 15);
          break;
        case 'crunch':
          for (let i = 0; i < 7; i++) this.burst(i * 0.045, 0.05, 300 + Math.random() * 500, 2, 0.9);
          break;
        case 'rip': this.burst(0, 0.38, 900, 1.2, 1, 5200); break;
        case 'tray':
          this.tone('sine', 110, 0, 0.18, 0.9, 60);
          this.burst(0.02, 0.05, 3000, 3, 0.4);
          break;
        case 'till':
          this.tone('triangle', 1318, 0, 0.5, 0.5);
          this.tone('triangle', 1760, 0.08, 0.6, 0.5);
          this.burst(0, 0.12, 5000, 2, 0.3);
          break;
        case 'beep': this.tone('square', 880, 0, 0.09, 0.25); break;
        case 'feed':
          for (let i = 0; i < 12; i++) this.burst(i * 0.05, 0.03, 1400, 4, 0.4);
          break;
        case 'chime':
          [523.25, 659.25, 783.99].forEach((f, i) => this.tone('sine', f, i * 0.12, 0.5, 0.45));
          break;
        default: break;
      }
    } catch {
      // A sound that fails to play is not worth stopping the game for.
    }
  }
}
