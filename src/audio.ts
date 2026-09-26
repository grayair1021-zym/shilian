import type { PerceptionCue } from './game/types';

type Sfx = 'click' | 'door' | 'alert' | 'scan' | 'success' | 'fail' | 'ping' | 'error' | 'radio' | 'listen' | 'hit' | 'attack' | 'heartbeat';

class AudioBus {
  private _enabled = true;
  private ctx: AudioContext | null = null;
  private output: GainNode | null = null;
  private ambientSources = new Set<AudioScheduledSourceNode>();
  private noiseBuffer: AudioBuffer | null = null;
  private bgmGain: GainNode | null = null;
  private bgmRunning = false;

  get enabled() { return this._enabled; }
  set enabled(value: boolean) {
    this._enabled = value;
    if (this.ctx && this.output) this.output.gain.setTargetAtTime(value ? 0.8 : 0, this.ctx.currentTime, 0.01);
    if (!value) {
      this.stopAtmosphere();
      this.stopBgm();
    } else {
      this.startBgm();
    }
  }

  /** 只在玩家手势里解锁；氛围播放不会自行创建或恢复音频环境。 */
  unlock() {
    if (this.enabled) {
      const ctx = this.context;
      if (ctx && !this.bgmRunning) this.startBgm();
    }
  }

  startBgm() {
    if (!this.enabled || this.bgmRunning) return;
    const ctx = this.context;
    if (!ctx || ctx.state !== 'running') return;
    try {
      this.bgmGain = ctx.createGain();
      this.bgmGain.gain.setValueAtTime(0.0001, ctx.currentTime);
      this.bgmGain.gain.linearRampToValueAtTime(0.016, ctx.currentTime + 3.0); // 3秒轻柔淡入

      // 1. 深空超低频空洞主音 (Sub Drone 55Hz & 82.5Hz)
      const osc1 = ctx.createOscillator();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(55, ctx.currentTime);

      const osc2 = ctx.createOscillator();
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(82.4, ctx.currentTime);

      // 低通空间滤波
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(160, ctx.currentTime);

      // 2. 微弱的缓慢太空风声噪声
      if (!this.noiseBuffer) {
        this.noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
        const channel = this.noiseBuffer.getChannelData(0);
        let n = 93;
        for (let i = 0; i < channel.length; i++) {
          n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
          channel[i] = (n / 4294967296) * 2 - 1;
        }
      }
      const noiseSource = ctx.createBufferSource();
      noiseSource.buffer = this.noiseBuffer;
      noiseSource.loop = true;

      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = 'bandpass';
      noiseFilter.frequency.setValueAtTime(240, ctx.currentTime);
      noiseFilter.Q.setValueAtTime(1.5, ctx.currentTime);

      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.008, ctx.currentTime);

      osc1.connect(filter);
      osc2.connect(filter);
      filter.connect(this.bgmGain);

      noiseSource.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(this.bgmGain);

      this.bgmGain.connect(this.output ?? ctx.destination);

      osc1.start();
      osc2.start();
      noiseSource.start();

      this.ambientSources.add(osc1);
      this.ambientSources.add(osc2);
      this.ambientSources.add(noiseSource);

      this.bgmRunning = true;
    } catch {
      // 忽略音频调度异常
    }
  }

  stopBgm() {
    if (this.bgmGain && this.ctx) {
      try {
        this.bgmGain.gain.linearRampToValueAtTime(0.0001, this.ctx.currentTime + 0.5);
      } catch {
        /* ignore */
      }
    }
    this.bgmRunning = false;
  }

  private get context(): AudioContext | null {
    if (!this.enabled) return null;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      try { this.ctx = new Ctor(); } catch { return null; }
      this.output = this.ctx.createGain();
      this.output.gain.value = 0.8;
      this.output.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
    return this.ctx;
  }

  stopAtmosphere() {
    for (const source of this.ambientSources) {
      try { source.stop(); } catch { /* 已结束的声源无需再停。 */ }
    }
    this.ambientSources.clear();
  }

  private texture(
    frequency: number, duration: number, volume: number,
    delay = 0, pan = 0, metallic = false,
  ) {
    const ctx = this.ctx;
    if (!this.enabled || !ctx || ctx.state !== 'running') return;
    let source: OscillatorNode | AudioBufferSourceNode;
    if (metallic) {
      const oscillator = ctx.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, ctx.currentTime + delay);
      oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.72, ctx.currentTime + delay + duration);
      source = oscillator;
    } else {
      if (!this.noiseBuffer) {
        this.noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
        const channel = this.noiseBuffer.getChannelData(0);
        let n = 93;
        for (let i = 0; i < channel.length; i++) {
          n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
          channel[i] = (n / 4294967296) * 2 - 1;
        }
      }
      const buffer = ctx.createBufferSource();
      buffer.buffer = this.noiseBuffer;
      buffer.loop = true;
      source = buffer;
    }
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = frequency;
    filter.Q.value = metallic ? 1.1 : 0.7;
    const envelope = ctx.createGain();
    const stereo = ctx.createStereoPanner();
    stereo.pan.value = Math.max(-0.4, Math.min(0.4, pan));
    const start = ctx.currentTime + delay;
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(Math.min(0.045, volume), start + Math.min(0.3, duration * 0.25));
    envelope.gain.linearRampToValueAtTime(0, start + duration);
    source.connect(filter).connect(envelope).connect(stereo).connect(this.output ?? ctx.destination);
    this.ambientSources.add(source);
    source.onended = () => {
      this.ambientSources.delete(source);
      source.disconnect(); filter.disconnect(); envelope.disconnect(); stereo.disconnect();
    };
    source.start(start);
    source.stop(start + duration + 0.02);
  }

  atmosphere(cue: PerceptionCue, direction: string, strength: number) {
    const pan = direction === '东侧' ? 0.35 : direction === '西侧' ? -0.35 : 0;
    const gain = Math.max(0, Math.min(1, strength));
    if (cue === 'suit') {
      [0, 0.32, 0.7].forEach((delay, i) => this.texture(i === 1 ? 540 : 790, 0.22, 0.043 * gain, delay, 0, true));
      this.texture(960, 1.2, 0.018 * gain, 0.05);
    } else if (cue === 'fracture') {
      this.texture(72, 1.6, 0.044 * gain, 0, 0, true);
      this.texture(240, 1.3, 0.035 * gain, 0.12);
      this.texture(190, 0.45, 0.03 * gain, 0.6, 0, true);
    } else if (cue === 'knock') {
      [0, 0.23, 0.46, 1.1, 1.5].forEach((delay, i) => {
        this.texture(132 - i * 6, i < 3 ? 0.17 : 0.28, 0.031 * gain, delay, pan, true);
      });
    } else if (cue === 'scrape' || cue === 'glass') {
      this.texture(480, 1.55, 0.022 * gain, 0, pan);
    } else if (cue === 'tremor') {
      this.texture(64, 1.25, 0.028 * gain, 0, 0, true);
      this.texture(160, 0.95, 0.013 * gain, 0.1, 0);
    } else if (cue === 'signal') {
      this.texture(840, 0.35, 0.009 * gain);
    } else if (cue === 'vent') {
      this.texture(170, 0.4, 0.028 * gain, 0, pan, true);
      this.texture(320, 0.7, 0.012 * gain, 0.15, pan);
    }
  }

  breathe(strength: number) {
    this.texture(390, 1.7, 0.018 * strength);
    this.texture(530, 2.2, 0.014 * strength, 2.1);
  }

  private tone(freq: number, dur: number, type: OscillatorType, gain = 0.05, delay = 0) {
    const ctx = this.context;
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.output ?? ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  play(kind: Sfx) {
    if (!this.enabled) return;
    switch (kind) {
      case 'click':
        this.tone(320, 0.05, 'square', 0.025);
        break;
      case 'door':
        this.tone(180, 0.16, 'sawtooth', 0.035);
        this.tone(120, 0.22, 'sine', 0.03, 0.06);
        break;
      case 'scan':
        this.tone(660, 0.08, 'sine', 0.03);
        this.tone(880, 0.08, 'sine', 0.028, 0.09);
        break;
      case 'alert':
        this.tone(340, 0.18, 'sine', 0.02);
        this.tone(280, 0.24, 'sine', 0.018, 0.2);
        break;
      case 'ping':
        this.tone(1040, 0.07, 'sine', 0.025);
        break;
      case 'success':
        this.tone(523, 0.12, 'sine', 0.04);
        this.tone(659, 0.14, 'sine', 0.04, 0.12);
        this.tone(784, 0.24, 'sine', 0.04, 0.26);
        break;
      case 'fail':
        this.tone(200, 0.4, 'sawtooth', 0.04);
        this.tone(140, 0.6, 'sine', 0.04, 0.18);
        break;
      case 'error':
        this.tone(160, 0.12, 'square', 0.03);
        break;
      case 'radio':
        this.tone(240, 0.045, 'square', 0.022);
        this.tone(760, 0.07, 'sine', 0.018, 0.06);
        break;
      case 'listen':
        this.tone(310, 0.18, 'sine', 0.018);
        break;
      case 'hit':
        // 受击重创：低频冲击 + 刺耳高频撕裂 + 金属凹陷
        this.texture(80, 0.45, 0.05, 0, 0, true);
        this.tone(110, 0.35, 'sawtooth', 0.045);
        this.tone(68, 0.5, 'sine', 0.05, 0.04);
        this.tone(880, 0.25, 'sawtooth', 0.03, 0.08);
        break;
      case 'attack':
        // 反击挥击 / 喷射
        this.tone(280, 0.12, 'sawtooth', 0.035);
        this.texture(220, 0.25, 0.04, 0, 0, true);
        break;
      case 'heartbeat':
        // 紧张心跳：双拍咚-咚
        this.tone(55, 0.14, 'sine', 0.04);
        this.tone(48, 0.12, 'sine', 0.035, 0.16);
        break;
    }
  }
}

export const audio = new AudioBus();
