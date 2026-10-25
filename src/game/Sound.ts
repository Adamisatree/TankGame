/**
 * A tiny WebAudio synth for pencil-and-paper era sound effects.
 * No asset files, no audio engine – just envelopes.
 */
export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  muted = false;

  private ensure(): AudioContext | null {
    if (this.muted) return null;
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.22;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  resume(): void {
    this.ensure();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : 0.22;
  }

  private tone(type: OscillatorType, from: number, to: number, dur: number, gain = 0.5, delay = 0): void {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(30, to), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noise(dur: number, gain = 0.4, filterFreq = 1200, delay = 0): void {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + delay;
    const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterFreq;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
  }

  fire(): void {
    this.tone('square', 420, 120, 0.12, 0.3);
    this.noise(0.14, 0.22, 2200);
  }

  enemyFire(): void {
    this.tone('sawtooth', 300, 90, 0.14, 0.22);
    this.noise(0.12, 0.18, 1600);
  }

  bounce(): void {
    this.tone('triangle', 900, 520, 0.07, 0.16);
  }

  ping(): void {
    this.tone('sine', 1500, 1400, 0.05, 0.1);
  }

  hit(): void {
    this.noise(0.24, 0.4, 900);
    this.tone('triangle', 240, 70, 0.2, 0.25);
  }

  explode(): void {
    this.noise(0.55, 0.55, 700);
    this.tone('sawtooth', 180, 40, 0.5, 0.3);
  }

  /** Bright two-note chime when a pickup is collected. */
  pickup(): void {
    this.tone('triangle', 720, 1180, 0.12, 0.35);
    this.tone('triangle', 1180, 1560, 0.14, 0.22, 0.07);
  }

  ui(): void {
    this.tone('triangle', 660, 880, 0.08, 0.18);
  }

  lose(): void {
    this.tone('triangle', 440, 110, 0.7, 0.3);
  }

  win(): void {
    const notes = [523, 659, 784, 1047];
    notes.forEach((n, i) => this.tone('triangle', n, n, 0.18, 0.22, i * 0.11));
  }
}

export const sound = new Sound();
