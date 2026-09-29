// Audio synthesis (WebAudio, no asset files). Ported from the 2D game, plus a mute switch.
let audioCtx = null;
let shuffleNoise = null;

let muted = false;
export function setMuted(value) {
  muted = !!value;
  if (muted && silentEl) silentEl.pause();
}
export function audioState() {
  return { ctx: audioCtx ? audioCtx.state : "none", silentPlaying: !!silentEl && !silentEl.paused };
}
export function isMuted() {
  return muted;
}

export function getAudioContext() {
  if (muted) return null;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!audioCtx || audioCtx.state === "closed") audioCtx = new AudioCtx();
  // iOS can also report "interrupted" (e.g. after a call or app switch)
  if (audioCtx.state !== "running") audioCtx.resume().catch(() => {});
  return audioCtx;
}

// Silent clip looped through an <audio> element. On iOS this moves the page onto the "playback"
// audio session so Web Audio is audible even with the ringer/silent switch on.
const SILENT_WAV = "data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";
let silentEl = null;

/**
 * Mobile browsers only allow audio after a user gesture. Call this from gesture events:
 * it creates/resumes the context and plays a silent buffer to fully unlock it.
 */
export function unlockAudio() {
  if (muted) return false;
  if (audioCtx && audioCtx.state === "running" && silentEl && !silentEl.paused) return true; // already unlocked
  try {
    const ctx = getAudioContext();
    if (!ctx) return false;
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start(0);
    if (!silentEl) {
      silentEl = new Audio(SILENT_WAV);
      silentEl.loop = true;
      silentEl.setAttribute("playsinline", "");
    }
    silentEl.play().catch(() => {});
    return ctx.state === "running";
  } catch (err) {
    return false;
  }
}

/** Keeps audio alive across tab switches / interruptions. */
export function resumeAudio() {
  if (muted || !audioCtx) return;
  if (audioCtx.state !== "running") audioCtx.resume().catch(() => {});
  if (silentEl && silentEl.paused) silentEl.play().catch(() => {});
}


/** Short shuffle burst used while starter selection is animating. */
export function playShuffleBurst() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const noise = ctx.createBufferSource();
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 0.12, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * 0.4;
    }
    noise.buffer = buffer;

    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.setValueAtTime(1200, now);

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(3800, now);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);

    noise.connect(hp).connect(lp).connect(gain).connect(ctx.destination);
    noise.start(now);
    noise.stop(now + 0.12);
  } catch (err) {
    // Ignore audio errors for browsers without user gesture support.
  }
}

/** Starts repeated shuffle bursts. */
export function startShuffleSound() {
  try {
    const ctx = getAudioContext();
    if (!ctx || shuffleNoise) return;
    const timer = setInterval(() => playShuffleBurst(), 140);
    shuffleNoise = { timer };
  } catch (err) {
    // Ignore audio errors for browsers without user gesture support.
  }
}

/** Stops the starter-selection shuffle loop. */
export function stopShuffleSound() {
  if (!shuffleNoise) return;
  try {
    clearInterval(shuffleNoise.timer);
  } catch (err) {
    // Ignore stop errors.
  }
  shuffleNoise = null;
}

// ---------------------------------------------------------------------------
// Modal UI helpers
// ---------------------------------------------------------------------------

export function playDiceRoll() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const duration = 0.9;

    const noise = ctx.createBufferSource();
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) {
      const decay = 1 - i / data.length;
      data[i] = (Math.random() * 2 - 1) * decay;
    }
    noise.buffer = buffer;

    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.setValueAtTime(1800, now);
    band.Q.setValueAtTime(1.2, now);

    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.setValueAtTime(500, now);

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(6200, now);
    lp.frequency.exponentialRampToValueAtTime(1400, now + duration);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);

    const bursts = [0.04, 0.14, 0.26, 0.38, 0.52, 0.68, 0.8];
    bursts.forEach((offset) => {
      const t = now + offset;
      const peak = 0.55 + Math.random() * 0.35;
      gain.gain.exponentialRampToValueAtTime(peak, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    });

    const glassOsc = ctx.createOscillator();
    const glassGain = ctx.createGain();
    glassOsc.type = "sine";
    glassOsc.frequency.setValueAtTime(4200, now);
    glassOsc.frequency.exponentialRampToValueAtTime(3000, now + 0.22);
    glassGain.gain.setValueAtTime(0.0001, now);
    glassGain.gain.exponentialRampToValueAtTime(0.38, now + 0.008);
    glassGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);

    const glassOsc2 = ctx.createOscillator();
    const glassGain2 = ctx.createGain();
    glassOsc2.type = "sine";
    glassOsc2.frequency.setValueAtTime(5200, now);
    glassOsc2.frequency.exponentialRampToValueAtTime(3600, now + 0.18);
    glassGain2.gain.setValueAtTime(0.0001, now);
    glassGain2.gain.exponentialRampToValueAtTime(0.22, now + 0.012);
    glassGain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);

    const glassClick = ctx.createBufferSource();
    const clickBuffer = ctx.createBuffer(1, ctx.sampleRate * 0.06, ctx.sampleRate);
    const clickData = clickBuffer.getChannelData(0);
    for (let i = 0; i < clickData.length; i += 1) {
      clickData[i] = (Math.random() * 2 - 1) * (1 - i / clickData.length);
    }
    glassClick.buffer = clickBuffer;
    const clickFilter = ctx.createBiquadFilter();
    clickFilter.type = "highpass";
    clickFilter.frequency.setValueAtTime(3600, now);
    const clickGain = ctx.createGain();
    clickGain.gain.setValueAtTime(0.0001, now);
    clickGain.gain.exponentialRampToValueAtTime(0.55, now + 0.004);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);

    const thump = ctx.createOscillator();
    const thumpGain = ctx.createGain();
    thump.type = "triangle";
    thump.frequency.setValueAtTime(160, now);
    thump.frequency.exponentialRampToValueAtTime(70, now + 0.25);
    thumpGain.gain.setValueAtTime(0.0001, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);

    noise.connect(band).connect(hp).connect(lp).connect(gain).connect(ctx.destination);
    glassOsc.connect(glassGain).connect(ctx.destination);
    glassOsc2.connect(glassGain2).connect(ctx.destination);
    glassClick.connect(clickFilter).connect(clickGain).connect(ctx.destination);
    thump.connect(thumpGain).connect(ctx.destination);

    noise.start(now);
    noise.stop(now + duration);
    glassOsc.start(now + 0.02);
    glassOsc.stop(now + 0.24);
    glassOsc2.start(now + 0.05);
    glassOsc2.stop(now + 0.22);
    glassClick.start(now + 0.02);
    glassClick.stop(now + 0.07);
    thump.start(now);
    thump.stop(now + 0.32);
  } catch (err) {
    // Ignore audio errors for browsers without user gesture support.
  }
}

/** Short per-step movement tick sound. */
export function playStepTick() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "square";
    osc.frequency.setValueAtTime(620, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);

    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.09);
  } catch (err) {
    // Ignore audio errors for browsers without user gesture support.
  }
}

/** Celebration SFX when a token reaches center-home. */
export function playHomeCheer() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + i * 0.1);
      gain.gain.setValueAtTime(0.0001, now + i * 0.1);
      gain.gain.exponentialRampToValueAtTime(0.35, now + i * 0.1 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.1 + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.1);
      osc.stop(now + i * 0.1 + 0.36);
    });

    const bell = ctx.createOscillator();
    const bellGain = ctx.createGain();
    bell.type = "triangle";
    bell.frequency.setValueAtTime(1567.98, now + 0.15);
    bellGain.gain.setValueAtTime(0.0001, now + 0.15);
    bellGain.gain.exponentialRampToValueAtTime(0.25, now + 0.17);
    bellGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
    bell.connect(bellGain).connect(ctx.destination);
    bell.start(now + 0.15);
    bell.stop(now + 0.56);
  } catch (err) {
    // Ignore audio errors for browsers without user gesture support.
  }
}

/** Capture SFX. */
export function playCaptureCrash() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const noise = ctx.createBufferSource();
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 1.2, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) {
      const fade = 1 - i / data.length;
      data[i] = (Math.random() * 2 - 1) * fade;
    }
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(1400, now);
    filter.frequency.exponentialRampToValueAtTime(400, now + 1.2);

    const gain = ctx.createGain();

    const boom = ctx.createOscillator();
    boom.type = "sine";
    boom.frequency.setValueAtTime(120, now);
    boom.frequency.exponentialRampToValueAtTime(50, now + 1.2);
    gain.gain.setValueAtTime(1.6, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);

    noise.connect(filter).connect(gain).connect(ctx.destination);
    boom.connect(gain);
    noise.start(now);
    noise.stop(now + 1.2);
    boom.start(now);
    boom.stop(now + 1.2);

  } catch (err) {
    // Ignore audio errors for browsers without user gesture support.
  }
}

/** Prompt SFX when direction choice appears. */
export function playDirectionChime() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    const boom = ctx.createOscillator();
    boom.type = "sine";
    boom.frequency.setValueAtTime(120, now);
    boom.frequency.exponentialRampToValueAtTime(50, now + 1.2);

    osc1.type = "triangle";
    osc2.type = "sine";
    osc1.frequency.setValueAtTime(523.25, now); // C5
    osc2.frequency.setValueAtTime(783.99, now); // G5

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.3, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.45);
    osc2.stop(now + 0.45);

  } catch (err) {
    // Ignore audio errors for browsers without user gesture support.
  }
}


/** Extra-turn chime when a 6 is rolled. */
export function playChime() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    const boom = ctx.createOscillator();
    boom.type = "sine";
    boom.frequency.setValueAtTime(120, now);
    boom.frequency.exponentialRampToValueAtTime(50, now + 1.2);
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(1320, now + 0.2);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.25, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);

    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.4);

    osc.onended = () => ctx.close();
  } catch (err) {
    // Ignore audio errors for browsers without user gesture support.
  }
}

// ---------------------------------------------------------------------------
// Game flow (start/roll/reset/resolve)
// ---------------------------------------------------------------------------

/** Randomly chooses the first player among enabled colors, with animation. */
