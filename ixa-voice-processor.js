class IXAADAAProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{
      name: "ratio",
      defaultValue: 2,
      minValue: -1000000000,
      maxValue: 1000000000,
      automationRate: "a-rate"
    }];
  }

  constructor() {
    super();
    this.voices = new Map();
    this.config = {
      maxVoices: 24,
      maxAmplitude: 0.22,
      maxIndex: 2,
      roundRatio: false,
      oversampling: 4,
      cutoff: 13000,
      amp: { attack: 0.01, decay: 0.2, sustain: 0.75, release: 0.25, curve: "linear", velocityAmount: 0.8, velocityTime: 0.5 },
      index: { attack: 0.01, decay: 0.25, sustain: 0.5, release: 0.2, curve: "linear", velocityAmount: 0.8, velocityTime: 0.5 },
      vibrato: { rate: 5, depth: 0, delay: 0.15, fade: 0.5 }
    };
    this.filterState = 0;
    this.port.onmessage = (event) => {
      const m = event.data || {};
      if (m.type === "config") {
        this.config = this.mergeConfig(this.config, m.config || {});
      } else if (m.type === "noteOn") {
        this.noteOn(m);
      } else if (m.type === "noteOff") {
        this.noteOff(m.id);
      } else if (m.type === "allOff") {
        for (const v of this.voices.values()) this.releaseVoice(v);
      }
    };
  }

  mergeConfig(oldConfig, patch) {
    const next = { ...oldConfig, ...patch };
    for (const k of ["amp", "index", "vibrato"]) {
      if (patch[k]) next[k] = { ...oldConfig[k], ...patch[k] };
    }
    if (![1, 2, 4, 8].includes(next.oversampling)) next.oversampling = 4;
    next.cutoff = Math.max(12000, Math.min(14000, Number(next.cutoff) || 13000));
    return next;
  }

  static delta(x) {
    const p = x - 4 * Math.floor(x / 4);
    if (p < 1) return p;
    if (p < 3) return 2 - p;
    return p - 4;
  }

  static antiderivative(x) {
    const p = x - 4 * Math.floor(x / 4);
    if (p < 1) return 0.5 * p * p;
    if (p < 3) return 2 * p - 0.5 * p * p - 1;
    return 0.5 * p * p - 4 * p + 8;
  }

  static foldADAA(x, xp) {
    const d = x - xp;
    if (Math.abs(d) < 1e-7) return IXAADAAProcessor.delta((x + xp) * 0.5);
    return (IXAADAAProcessor.antiderivative(x) - IXAADAAProcessor.antiderivative(xp)) / d;
  }

  static W(phase) {
    const u = phase % 0.5;
    let w = Math.sin(2 * Math.PI * u) * (u < 0.25 ? 1 : -1);
    if (u >= 0.25) w += 2;
    if (phase >= 0.5) w += 2;
    return w;
  }

  static curve(t, mode) {
    t = Math.max(0, Math.min(1, t));
    if (mode !== "log") return t;
    // Smooth, normalized exponential curve: zero slope near the start,
    // steeper near the end. The inverse is used for falling segments too.
    const k = 5;
    return (Math.exp(k * t) - 1) / (Math.exp(k) - 1);
  }

  makeEnvelope() {
    return { stage: "attack", value: 0, elapsed: 0, releaseStart: 0 };
  }

  releaseVoice(v) {
    for (const env of [v.ampEnv, v.indexEnv]) {
      if (env.stage !== "off" && env.stage !== "release") {
        env.stage = "release";
        env.elapsed = 0;
        env.releaseStart = env.value;
      }
    }
  }

  noteOn(m) {
    const id = String(m.id);
    const note = Math.max(0, Math.min(127, Math.round(m.note)));
    const velocity = Math.max(1, Math.min(127, Number(m.velocity) || 1)) / 127;

    if (this.voices.has(id)) this.voices.delete(id);
    if (this.voices.size >= this.config.maxVoices) {
      const oldest = this.voices.keys().next().value;
      this.voices.delete(oldest);
    }

    const factor = this.config.oversampling;
    const filter = this.makeDecimator(factor);
    this.voices.set(id, {
      id, note, velocity,
      frequency: 440 * Math.pow(2, (note - 69) / 12),
      phase: 0,
      lfoPhase: 0,
      age: 0,
      ampEnv: this.makeEnvelope(),
      indexEnv: this.makeEnvelope(),
      previousX: 0,
      hasPreviousX: false,
      ratio: 2,
      decimator: filter
    });
  }

  noteOff(id) {
    const v = this.voices.get(String(id));
    if (v) this.releaseVoice(v);
  }

  makeDecimator(factor) {
    if (factor === 1) return { factor, coeff: [1], buf: [0], pos: 0 };
    const half = 4 * factor;
    const len = 2 * half + 1;
    const cutoff = 0.45 / factor;
    const coeff = new Float64Array(len);
    let sum = 0;
    for (let i = 0; i < len; i++) {
      const n = i - half;
      const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
      const win = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (len - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (len - 1));
      coeff[i] = sinc * win;
      sum += coeff[i];
    }
    for (let i = 0; i < len; i++) coeff[i] /= sum;
    return { factor, coeff, buf: new Float64Array(len), pos: 0 };
  }

  decimate(v, input) {
    const d = v.decimator;
    if (d.coeff.length === 1) return input;
    d.buf[d.pos] = input;
    let y = 0;
    let p = d.pos;
    for (let i = 0; i < d.coeff.length; i++) {
      y += d.coeff[i] * d.buf[p];
      if (--p < 0) p = d.buf.length - 1;
    }
    d.pos = (d.pos + 1) % d.buf.length;
    return y;
  }

  advanceEnvelope(env, settings, velocity, dt) {
    if (env.stage === "off") return 0;
    const timeScale = 1 + Math.max(0, Math.min(1, settings.velocityTime)) * (1 - velocity);
    let guard = 0;
    while (guard++ < 4) {
      if (env.stage === "attack") {
        const dur = Math.max(0, settings.attack * timeScale);
        if (dur === 0) { env.value = 1; env.stage = "decay"; env.elapsed = 0; continue; }
        env.elapsed += dt;
        const t = Math.min(1, env.elapsed / dur);
        env.value = IXAADAAProcessor.curve(t, settings.curve);
        if (t >= 1) { env.stage = "decay"; env.elapsed = 0; }
        return env.value;
      }
      if (env.stage === "decay") {
        const dur = Math.max(0, settings.decay * timeScale);
        if (dur === 0) { env.value = settings.sustain; env.stage = "sustain"; continue; }
        env.elapsed += dt;
        const t = Math.min(1, env.elapsed / dur);
        const c = IXAADAAProcessor.curve(t, settings.curve);
        env.value = 1 + (settings.sustain - 1) * c;
        if (t >= 1) { env.stage = "sustain"; env.elapsed = 0; }
        return env.value;
      }
      if (env.stage === "sustain") {
        env.value = settings.sustain;
        return env.value;
      }
      if (env.stage === "release") {
        const dur = Math.max(0, settings.release * timeScale);
        if (dur === 0) { env.value = 0; env.stage = "off"; return 0; }
        env.elapsed += dt;
        const t = Math.min(1, env.elapsed / dur);
        const c = IXAADAAProcessor.curve(t, settings.curve);
        env.value = env.releaseStart * (1 - c);
        if (t >= 1) { env.value = 0; env.stage = "off"; }
        return env.value;
      }
    }
    return env.value;
  }

  process(inputs, outputs, parameters) {
    const channels = outputs[0];
    if (!channels || !channels.length) return true;
    const frames = channels[0].length;
    const factor = this.config.oversampling;
    const subRate = sampleRate * factor;
    const dt = 1 / subRate;
    const ratioValues = parameters.ratio;
    const ratioTau = 0.003;
    const ratioA = Math.exp(-dt / ratioTau);
    const cutoff = Math.min(this.config.cutoff, sampleRate * 0.45);
    const lpA = Math.exp(-2 * Math.PI * cutoff / sampleRate);
    const ampSettings = this.config.amp;
    const indexSettings = this.config.index;
    const vib = this.config.vibrato;

    for (let i = 0; i < frames; i++) {
      let mix = 0;
      const ratioInput = ratioValues.length > 1 ? ratioValues[i] : ratioValues[0];
      const safeRatio = Number.isFinite(ratioInput) ? ratioInput : 2;
      const ratioTarget = this.config.roundRatio ? Math.round(safeRatio) : safeRatio;

      for (const v of this.voices.values()) {
        if (v.decimator.factor !== factor) {
          v.decimator = this.makeDecimator(factor);
          v.hasPreviousX = false;
        }
        const ampEnv = this.advanceEnvelope(v.ampEnv, ampSettings, v.velocity, dt);
        const indexEnv = this.advanceEnvelope(v.indexEnv, indexSettings, v.velocity, dt);
        const ampVel = (1 - ampSettings.velocityAmount) + ampSettings.velocityAmount * v.velocity;
        const indexVel = (1 - indexSettings.velocityAmount) + indexSettings.velocityAmount * v.velocity;
        const amplitude = this.config.maxAmplitude * ampEnv * ampVel;
        const modulationIndex = this.config.maxIndex * indexEnv * indexVel;

        let voiceSample = 0;
        for (let s = 0; s < factor; s++) {
          const vibratoFade = v.age <= vib.delay ? 0 :
            (vib.fade <= 0 ? 1 : Math.min(1, (v.age - vib.delay) / vib.fade));
          const vibratoCents = vib.depth * vibratoFade * Math.sin(v.lfoPhase);
          const frequency = v.frequency * Math.pow(2, vibratoCents / 1200);

          v.ratio = ratioTarget + ratioA * (v.ratio - ratioTarget);
          const x = IXAADAAProcessor.W(v.phase) +
            modulationIndex * Math.sin(2 * Math.PI * v.ratio * v.phase);

          let shaped;
          if (!v.hasPreviousX) {
            shaped = IXAADAAProcessor.delta(x);
            v.hasPreviousX = true;
          } else {
            shaped = IXAADAAProcessor.foldADAA(x, v.previousX);
          }
          v.previousX = x;
          voiceSample = this.decimate(v, shaped);

          v.phase += frequency / subRate;
          v.phase -= Math.floor(v.phase);
          v.lfoPhase += 2 * Math.PI * vib.rate / subRate;
          v.lfoPhase %= 2 * Math.PI;
          v.age += dt;
        }
        mix += voiceSample * amplitude;
      }

      // Global 6 dB/octave one-pole low-pass.
      this.filterState = (1 - lpA) * mix + lpA * this.filterState;
      const out = Number.isFinite(this.filterState) ? this.filterState : 0;
      for (let ch = 0; ch < channels.length; ch++) channels[ch][i] = out;
    }

    for (const [id, v] of this.voices) {
      if (v.ampEnv.stage === "off" && v.indexEnv.stage === "off") {
        this.voices.delete(id);
      }
    }
    return true;
  }
}

registerProcessor("ixa-synth-processor", IXAADAAProcessor);
