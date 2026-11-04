// loom's sounds (Appearance → Sound, off unless the person turns it on): synthesised here with WebAudio, so there are
// no files. Its own chunk, loaded only when Sound is on. Two: a short detuned pad swell with a high ping when loom
// opens (only when the opening animation runs: never under reduced motion), and two soft pings when something you did
// lands. A browser that won't play before a tap (autoplay rules) simply stays quiet: that chime is skipped, not delayed.
let ctx: AudioContext | null = null;

function tone(c: AudioContext, out: AudioNode, type: OscillatorType, hz: number, at: number, up: number, hold: number, down: number, peak: number, detune = 0) {
  const o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.value = hz; o.detune.value = detune;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + up);
  g.gain.setValueAtTime(peak, at + up + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, at + up + hold + down);
  o.connect(g).connect(out);
  o.start(at); o.stop(at + up + hold + down + 0.05);
}

export function chime(kind: 'boot' | 'done'): void {
  try { ctx ??= new AudioContext(); } catch { return; }
  const c = ctx;
  // A context the browser holds (autoplay, before a tap) plays nothing now: a chime scheduled on it would sound later,
  // whenever the browser lets it go, apart from what it was for. Wake it for next time, and stay quiet this time.
  if (c.state !== 'running') { void c.resume().catch(() => {}); return; }
  const t = c.currentTime + 0.03;
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 2400;
  lp.connect(c.destination);
  if (kind === 'boot') {
    for (const d of [-9, 7]) tone(c, lp, 'sawtooth', 110, t, 0.45, 0.15, 0.9, 0.035, d);
    tone(c, lp, 'triangle', 220, t, 0.5, 0.1, 0.9, 0.05);
    tone(c, c.destination, 'sine', 1760, t + 0.5, 0.01, 0.02, 0.6, 0.06);
  } else {
    tone(c, c.destination, 'sine', 880, t, 0.01, 0.02, 0.25, 0.05);
    tone(c, c.destination, 'sine', 1320, t + 0.09, 0.01, 0.02, 0.35, 0.045);
  }
}
