// 効果音＝WebAudio の短い音（音源ファイル無し）。切替は進捗に保存。初回の操作の中で AudioContext を起こす（自動再生の制限）
let ctx = null;
const ac = () => { try { ctx ||= new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === "suspended") ctx.resume(); return ctx; } catch { return null; } };
const tone = (c, f, t0, dur, type = "sine", gain = 0.12) => { const o = c.createOscillator(), g = c.createGain(); o.type = type; o.frequency.value = f; g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(gain, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur); o.connect(g).connect(c.destination); o.start(t0); o.stop(t0 + dur + 0.02); };
export const sfx = {
	tap() { const c = ac(); if (c) tone(c, 880, c.currentTime, 0.06, "triangle", 0.05); },
	correct() { const c = ac(); if (!c) return; const t = c.currentTime; tone(c, 659, t, 0.12); tone(c, 988, t + 0.1, 0.22); },
	wrong() { const c = ac(); if (!c) return; const t = c.currentTime; tone(c, 196, t, 0.25, "square", 0.06); tone(c, 185, t + 0.12, 0.25, "square", 0.06); },
	fanfare() { const c = ac(); if (!c) return; const t = c.currentTime; [523, 659, 784, 1047].forEach((f, i) => tone(c, f, t + i * 0.11, 0.3)); tone(c, 1319, t + 0.5, 0.6); },
	badge() { const c = ac(); if (!c) return; const t = c.currentTime; [784, 1047, 1319].forEach((f, i) => tone(c, f, t + i * 0.08, 0.25, "triangle")); },
};
