// 動画の書き出し（🎞・PLATEAU AWARD 向け 第3便・2026-10-24）＝実時間の画面収録ではなく、1 コマずつ描いて符号化する。
// 1 コマ＝タイムラインの時刻（map.sceneTimeline.seek）→ 読み込みが静まるのを待つ（map.on("idle")）→ 生スナップ（requestSnapshot）→
//   字幕・カード・出典・黒幕・溶け替えを 2D で重ねる（見た目は quiet-mono #scene-titles と同じ比率＝cqh＝画角の高さの 1/100）→
//   WebCodecs VideoEncoder（H.264）→ 自前の箱詰め（mp4mux.ts）。
// 遅い端末でも絵は同じ＝コマ落ち・ポップイン無し・画面より大きい解像度（4K）も可（枠を目標の画素へ広げ、見た目だけ縮めて置く）。
// 上映の儀式（開幕カード→黒からの溶明→…→終幕の溶暗→終幕カード）も同じ順で焼く。
// 音（第4便）＝opts.audio（BGM の音声ファイル）を総尺に合わせて切り（頭 0.5 秒の溶明・尻 2.5 秒の溶暗）、AudioEncoder の AAC で同じ MP4 へ。
//   AAC の符号器が無いブラウザは音なしで焼き、onNote で知らせる。
import { parseScenes, compileVias } from "@ortho-earth/globe/demo/scene-adapter.js";
import { composeLayersToCanvas, solarSkyOf } from "@ortho-earth/globe/gadgets/compose.js";
import { pick, cardOf, cardSecs, CARD_FADE, gradeOf, glowOf, type CardSpec } from "@ortho-earth/globe/scenes/titles.js";
import { getLang } from "@ortho-earth/globe/i18n.js";
import { Mp4Muxer } from "./mp4mux.ts";
import type { GlobeMap } from "@ortho-earth/globe";

/** 書き出しの設定（width/height＝出力の画素・fps・waitMs＝1 コマの読み込み待ちの上限・lang＝字幕の言語） */
export interface ExportVideoOpts {
	map: GlobeMap; frameEl: HTMLElement; doc: Record<string, unknown>;
	width: number; height: number; fps: number; lang?: string | null; waitMs?: number;
	signal?: AbortSignal; onProgress?: (done: number, total: number, etaSec: number) => void;
	/** BGM（音声ファイル）。総尺に合わせて切り・溶明/溶暗して AAC で入れる */
	audio?: Blob | null; onNote?: (msg: "no-aac" | "audio-decode-failed") => void;
}
type Row = Record<string, unknown> & { title?: string; caption?: string; look?: string; sub?: unknown; slide?: string; view?: string; path?: unknown[]; hold?: number; slideHold?: number; fade?: string; dissolve?: boolean; travel?: number };
interface TlRow { i: number; t0: number; tArrive: number; t1: number }
interface Tl { dur: number; rows: TlRow[]; at(t: number): { lon: number; lat: number; zoom: number; pitch: number; bearing: number; cover: number; time?: number; i: number }; seek(t: number): boolean; end(): void }

const FADE_IN = 1.2, FADE_OUT = 1.2, CAP_FADE = 0.45;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** H.264 の設定（解像度に足りる水準から順に・ハードウェア優先） */
async function pickCodec(width: number, height: number, fps: number, bitrate: number): Promise<VideoEncoderConfig> {
	const px = width * height * fps;
	const levels = px <= 1920 * 1088 * 30 ? ["avc1.640028", "avc1.64002a", "avc1.640032"] : px <= 2560 * 1440 * 60 ? ["avc1.640032", "avc1.640033"] : ["avc1.640033", "avc1.640034"];
	for (const hw of ["prefer-hardware", "no-preference"] as const) for (const codec of [...levels, "avc1.4d0033", "avc1.42003e"]) {
		const cfg: VideoEncoderConfig = { codec, width, height, framerate: fps, bitrate, hardwareAcceleration: hw, avc: { format: "avc" }, latencyMode: "quality" };
		try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch { /* 次へ */ }
	}
	throw new Error("H.264 encoding is not supported in this browser");
}

// 字幕の言語（demo の T() と同じ解き方：scene[lang] → ja なら旧綴り jp → title）
const T = (s: Row, lang: string) => (s[lang] as string | undefined) ?? (lang === "ja" ? s.jp as string | undefined : undefined) ?? s.title ?? "";
const isImg = (s: string) => /\.(svg|png|jpe?g|webp|gif|avif)([?#]|$)/i.test(s) || /^(data:|blob:|https?:)/.test(s);

/** 絵の上の層を 2D で描く（cqh＝H/100・quiet-mono の #scene-titles と同じ寸法） */
class Painter {
	private ctx: OffscreenCanvasRenderingContext2D; private W: number; private H: number; private font: string;
	constructor(ctx: OffscreenCanvasRenderingContext2D, W: number, H: number, font: string) { this.ctx = ctx; this.W = W; this.H = H; this.font = font; }
	private q(n: number) { return n * this.H / 100; }
	private text(s: string, x: number, y: number, size: number, weight: number, { align = "left", spacing = 0, shadow = true, color = "#fff", maxW = this.W * 0.9 }: { align?: CanvasTextAlign; spacing?: number; shadow?: boolean; color?: string; maxW?: number } = {}) {
		const c = this.ctx;
		c.font = `${weight} ${size}px ${this.font}`;
		c.textAlign = align; c.textBaseline = "alphabetic";
		(c as unknown as { letterSpacing: string }).letterSpacing = `${spacing * size}px`;
		c.fillStyle = color;
		if (shadow) { c.shadowColor = "rgba(0,0,0,.85)"; c.shadowBlur = size * 0.25; c.shadowOffsetY = size * 0.04; }
		c.fillText(s, x, y, maxW);
		c.shadowColor = "transparent"; c.shadowBlur = 0; c.shadowOffsetY = 0;
		(c as unknown as { letterSpacing: string }).letterSpacing = "0px";
	}
	private measure(s: string, size: number, weight: number, spacing = 0) { const c = this.ctx; c.font = `${weight} ${size}px ${this.font}`; (c as unknown as { letterSpacing: string }).letterSpacing = `${spacing * size}px`; const w = c.measureText(s).width; (c as unknown as { letterSpacing: string }).letterSpacing = "0px"; return w; }
	caption(look: string, title: string, sub: string, a: number) {
		if (!(a > 0) || !title) return;
		const c = this.ctx, { W, H } = this, q = (n: number) => this.q(n);
		c.save(); c.globalAlpha = a;
		const rise = (1 - a) * q(1.5);
		if (look === "lower") {
			const g = c.createLinearGradient(0, H, 0, H - q(30));
			g.addColorStop(0, "rgba(0,0,0,.55)"); g.addColorStop(0.55, "rgba(0,0,0,.28)"); g.addColorStop(1, "rgba(0,0,0,0)");
			c.fillStyle = g; c.fillRect(0, H - q(30), W, q(30));
			const x0 = W * 0.06, tSize = q(5.4), sSize = q(2.7);
			const bottom = H - q(7.5) + rise, subH = sub ? sSize * 1.35 + q(0.6) : 0, top = bottom - subH - tSize * 1.25 - q(0.8);
			c.fillStyle = "#4b90ff"; c.fillRect(x0, top, q(0.55), bottom - top);
			const tx = x0 + q(0.55) + q(2.2);
			this.text(title, tx, top + q(0.4) + tSize, tSize, 700, { spacing: 0.03, maxW: W * 0.7 });
			if (sub) this.text(sub, tx, bottom - q(0.4) - sSize * 0.25, sSize, 500, { spacing: 0.05, maxW: W * 0.7 });
		} else if (look === "center") {
			const g = c.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W * 0.4, H * 0.24));
			g.addColorStop(0, "rgba(0,0,0,.14)"); g.addColorStop(1, "rgba(0,0,0,0)");
			c.fillStyle = g; c.fillRect(0, 0, W, H);
			const tSize = q(8.6), sSize = q(3);
			const y = H / 2 + (sub ? -q(1.2) : tSize * 0.35) + rise;
			this.text(title, W / 2, y, tSize, 700, { align: "center", spacing: 0.08, maxW: W * 0.84 });
			if (sub) this.text(sub, W / 2, y + q(1.4) + sSize * 1.2, sSize, 500, { align: "center", spacing: 0.14, maxW: W * 0.84 });
		} else if (look === "pin") {
			const cx = W / 2, cy = H / 2 + rise * 0.6;
			c.fillStyle = "rgba(255,255,255,.85)"; c.fillRect(cx - 1, cy - q(0.8) - q(13), 2, q(13));
			c.beginPath(); c.arc(cx, cy, q(0.8) + q(0.45), 0, Math.PI * 2); c.fillStyle = "rgba(75,144,255,.85)"; c.fill();
			c.beginPath(); c.arc(cx, cy, q(0.8), 0, Math.PI * 2); c.fillStyle = "#fff"; c.fill();
			const tSize = q(3.6), sSize = q(2.1), padX = q(2.4), padY = q(1.1);
			const w = Math.max(this.measure(title, tSize, 700), sub ? this.measure(sub, sSize, 500) : 0) + padX * 2;
			const h = tSize * 1.25 + (sub ? sSize * 1.35 + q(0.3) : 0) + padY * 2;
			const bx = cx - w / 2, by = cy - q(13.8) - h;
			c.beginPath(); c.roundRect(bx, by, w, h, q(1.2)); c.fillStyle = "rgba(16,24,36,.78)"; c.fill();
			c.strokeStyle = "rgba(255,255,255,.22)"; c.lineWidth = Math.max(1, H / 1080); c.stroke();
			this.text(title, cx, by + padY + tSize * 1.0, tSize, 700, { align: "center", shadow: false });
			if (sub) this.text(sub, cx, by + padY + tSize * 1.25 + q(0.3) + sSize, sSize, 500, { align: "center", shadow: false });
		} else {   // top（従来の上部字幕＝#demo-caption の発表画面の大きさを画角比へ）
			const tSize = q(4.2);
			this.text(title, W / 2, q(5.5) + tSize, tSize, 600, { align: "center", spacing: 0.04 });
			if (sub) this.text(sub, W / 2, q(5.5) + tSize * 1.25 + tSize * 0.55, tSize * 0.5, 500, { align: "center", spacing: 0.06 });
		}
		c.restore();
	}
	credit(s: string) {
		if (!s) return;
		const c = this.ctx, q = (n: number) => this.q(n), size = q(1.75);
		const w = Math.min(this.measure(s, size, 500, 0.03), this.W * 0.8) + q(2.2);
		c.beginPath(); c.roundRect(q(2.2), this.H - q(1.8) - size * 1.3 - q(0.7), w, size * 1.3 + q(0.7), q(0.7)); c.fillStyle = "rgba(10,14,22,.42)"; c.fill();
		this.text(s, q(2.2) + q(1.1), this.H - q(1.8) - q(0.35) - size * 0.28, size, 500, { spacing: 0.03, shadow: false, color: "rgba(255,255,255,.92)", maxW: this.W * 0.8 });
	}
	slide(text: string | null, img: ImageBitmap | null, a: number) {
		if (!(a > 0)) return;
		const c = this.ctx, { W, H } = this, q = (n: number) => this.q(n);
		c.save(); c.globalAlpha = a;
		c.fillStyle = "rgba(10,16,33,.55)"; c.fillRect(0, 0, W, H);
		if (img) {
			const k = Math.min(W * 0.88 / img.width, H * 0.84 / img.height), w = img.width * k, h = img.height * k;
			c.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
		} else if (text) {
			const lines = text.split("\n"), size = q(4), lh = size * 1.75;
			const w = Math.min(W * 0.78, Math.max(...lines.map(l => this.measure(l, size, 500, 0.06))) + q(14)), h = lines.length * lh + q(10);
			c.beginPath(); c.roundRect((W - w) / 2, (H - h) / 2, w, h, q(1)); c.fillStyle = "#f4f2ec"; c.fill();
			lines.forEach((l, k) => this.text(l, W / 2, (H - h) / 2 + q(5) + lh * k + size * 1.1, size, 500, { align: "center", spacing: 0.06, shadow: false, color: "#222", maxW: w - q(8) }));
		}
		c.restore();
	}
	card(cd: CardSpec, lang: string, a: number, u: number) {
		const c = this.ctx, { W, H } = this, q = (n: number) => this.q(n);
		c.save(); c.globalAlpha = a;
		const g = c.createRadialGradient(W / 2, H * 0.46, 0, W / 2, H * 0.46, Math.hypot(W, H) * 0.5);
		g.addColorStop(0, "#101a2c"); g.addColorStop(0.7, "#000"); c.fillStyle = g; c.fillRect(0, 0, W, H);
		const title = pick(cd.title, lang), sub = pick(cd.sub, lang), by = pick(cd.by, lang);
		const tS = q(8), sS = q(3.2), bS = q(2.4), logo = q(7);
		const blockH = logo + q(3.2) + (title ? tS * 1.2 : 0) + (sub ? q(1.8) + sS * 1.3 : 0) + (by ? q(3.6) + 2 + q(2.4) + bS * 1.3 : 0);
		let y = (H - blockH) / 2;
		// ロゴ＝起動画面と同じ球儀の一筆書き（titles.ts の LOGO と同じ線）
		c.save(); c.translate(W / 2 - logo / 2, y); c.scale(logo / 100, logo / 100);
		c.strokeStyle = "rgba(255,255,255,.85)"; c.lineWidth = 6;
		c.beginPath(); c.ellipse(50, 50, 45, 45, 0, 0, Math.PI * 2); c.stroke();
		c.beginPath(); c.ellipse(50, 50, 25, 45, 0, 0, Math.PI * 2); c.stroke();
		c.stroke(new Path2D("M11 28H88 M11 72H88M50 5V95M5 50 H95"));
		c.restore();
		y += logo + q(3.2);
		const rise = (1 - clamp01(u / 1.2)) * q(1.6), ra = clamp01(u / 1.2);
		c.globalAlpha = a * ra;
		if (title) { this.text(title, W / 2, y + tS * 0.95 + rise, tS, 700, { align: "center", spacing: 0.06 + 0.08 * (1 - ra), shadow: false, maxW: W * 0.86 }); y += tS * 1.2; }
		if (sub) { y += q(1.8); this.text(sub, W / 2, y + sS * 1.0 + rise, sS, 500, { align: "center", spacing: 0.12, shadow: false, color: "rgba(255,255,255,.82)", maxW: W * 0.86 }); y += sS * 1.3; }
		c.globalAlpha = a;
		if (by) {
			y += q(3.6); c.fillStyle = "#4b90ff"; c.fillRect(W / 2 - q(4.5), y, q(9), Math.max(2, H / 540)); y += 2 + q(2.4);
			this.text(by, W / 2, y + bS, bS, 400, { align: "center", spacing: 0.1, shadow: false, color: "rgba(255,255,255,.75)", maxW: W * 0.86 });
		}
		c.restore();
	}
}

/** BGM を総尺の PCM（48kHz・ステレオ）へ：切る・頭 0.5 秒の溶明・尻 2.5 秒の溶暗（OfflineAudioContext＝再標本化もここで） */
async function bgmPcm(file: Blob, seconds: number): Promise<AudioBuffer> {
	const rate = 48000, frames = Math.ceil(seconds * rate);
	const src = await new OfflineAudioContext(2, 1, rate).decodeAudioData(await file.arrayBuffer());
	const ctx = new OfflineAudioContext(2, frames, rate);
	const node = ctx.createBufferSource(); node.buffer = src; node.loop = src.duration < seconds;   // 短い曲は繰り返す
	const g = ctx.createGain();
	g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(1, Math.min(0.5, seconds / 4));
	const outAt = Math.max(0.6, seconds - 2.5);
	g.gain.setValueAtTime(1, outAt); g.gain.linearRampToValueAtTime(0, seconds);
	node.connect(g).connect(ctx.destination); node.start(0);
	return ctx.startRendering();
}
/** AAC の符号化（1024 標本ずつ AudioData に切って渡す） */
async function encodeAac(pcm: AudioBuffer, mux: Mp4Muxer): Promise<void> {
	let err: unknown = null;
	const ae = new AudioEncoder({ output: (ch, meta) => mux.addAudio(ch, meta), error: e => { err = e; } });
	ae.configure({ codec: "mp4a.40.2", sampleRate: pcm.sampleRate, numberOfChannels: 2, bitrate: 192000 });
	const L = pcm.getChannelData(0), R = pcm.numberOfChannels > 1 ? pcm.getChannelData(1) : L, step = 1024;
	for (let o = 0; o < pcm.length; o += step) {
		const n = Math.min(step, pcm.length - o), buf = new Float32Array(n * 2);
		buf.set(L.subarray(o, o + n), 0); buf.set(R.subarray(o, o + n), n);   // f32-planar＝左の n 標本→右の n 標本
		const ad = new AudioData({ format: "f32-planar", sampleRate: pcm.sampleRate, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(o * 1e6 / pcm.sampleRate), data: buf });
		ae.encode(ad); ad.close();
		if (err) throw err;
	}
	await ae.flush(); ae.close();
	if (err) throw err;
}

export async function exportVideo({ map, frameEl, doc, width, height, fps, lang, waitMs = 12000, signal, onProgress, audio, onNote }: ExportVideoOpts): Promise<Blob> {
	if (typeof VideoEncoder === "undefined") throw new Error("WebCodecs (VideoEncoder) is not available in this browser");
	const L = lang || getLang();
	const tl = map.sceneTimeline(doc) as unknown as Tl | null;
	if (!tl) throw new Error("the script has no playable rows");
	const rows = compileVias(parseScenes(doc).scenes) as Row[];
	const opening = cardOf(doc.opening), ending = cardOf(doc.ending), credit = pick(doc.credit, L);
	const tOpen = cardSecs(opening), tEnd = cardSecs(ending);
	const total = tOpen + tl.dur + FADE_OUT + tEnd + 0.2;
	const N = Math.ceil(total * fps);
	const hold = typeof doc.hold === "number" ? doc.hold : 3, slideHold = typeof doc.slideHold === "number" ? doc.slideHold : 4;

	// 画像スライドは先に読む（コマの途中で待たない）
	const imgs = new Map<string, ImageBitmap | null>();
	await Promise.all(rows.filter(r => r.slide && isImg(r.slide)).map(async r => {
		try { imgs.set(r.slide!, await createImageBitmap(await (await fetch(r.slide!)).blob())); } catch { imgs.set(r.slide!, null); }
	}));

	// 枠を目標の画素へ（CSS×dpr＝width×height）・見た目は舞台に収まるよう縮めて置く（transform は描画の解像度を変えない）
	const dpr = devicePixelRatio || 1, old = { w: frameEl.style.width, h: frameEl.style.height, t: frameEl.style.transform };
	const cssW = width / dpr, cssH = height / dpr, stage = frameEl.parentElement!;
	const k = Math.min(1, (stage.clientWidth - 24) / cssW, (stage.clientHeight - 24) / cssH);
	frameEl.style.width = cssW + "px"; frameEl.style.height = cssH + "px"; frameEl.style.transform = k < 1 ? `scale(${k})` : "";
	map.pinRes?.(true);
	const light = doc.light, sunBefore = map.getSun(), liveBefore = map.clock.isLive(), timeBefore = map.clock.time;
	const rasterBefore = map.raster.selected();   // 行 raster（第5便）はシークが切り替える＝終わったら書き出し前の画像へ戻す
	const gradeOn = !!light && (light as { grade?: unknown }).grade !== false, lightsOn = !!light && (light as { cityLights?: unknown }).cityLights !== false;   // 夜の街明かり（2026-10-24）＝上映と同じ
	if (light) { map.setSun({ follow: "clock" }); if ((light as { shadows?: unknown }).shadows !== false) map.setShadows(true); if (lightsOn) map.setCityLights(true); }
	map.mapEl.classList.add("scene-clean");

	const settle = (ms: number) => new Promise<void>(res => {
		let done = false;
		const fin = () => { if (done) return; done = true; map.off("idle", fin); clearTimeout(to); res(); };
		const to = setTimeout(fin, ms);
		map.on("idle", fin);
		map.requestDraw();
	});
	const out = new OffscreenCanvas(width, height), ctx = out.getContext("2d")!;
	const font = getComputedStyle(map.mapEl).fontFamily || "system-ui, sans-serif";
	const P = new Painter(ctx, width, height, font);
	const base = new OffscreenCanvas(width, height), bctx = base.getContext("2d")!;
	const still = new OffscreenCanvas(width, height), sctx = still.getContext("2d")!;
	let stillRow = -1;

	const bitrate = Math.round(width * height * fps * 0.12);
	const cfg = await pickCodec(width, height, fps, Math.max(8e6, bitrate));
	// BGM：AAC が焼けるか先に確かめる（焼けない／読めない＝音なしで続ける）
	let pcm: AudioBuffer | null = null;
	if (audio) {
		const aacOk = typeof AudioEncoder !== "undefined" && await AudioEncoder.isConfigSupported({ codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 }).then(r => !!r.supported, () => false);
		if (!aacOk) onNote?.("no-aac");
		else { try { pcm = await bgmPcm(audio, N / fps); } catch { onNote?.("audio-decode-failed"); } }
	}
	const mux = new Mp4Muxer({ width, height, fps }, pcm ? { sampleRate: pcm.sampleRate, channels: 2 } : null);
	let encErr: unknown = null;
	const encoder = new VideoEncoder({ output: (ch, meta) => mux.addVideo(ch, meta), error: e => { encErr = e; } });
	encoder.configure(cfg);

	const t0w = performance.now();
	let lastKey = "", lastRow = -1;
	try {
		await new Promise(r => setTimeout(r, 300));   // 枠の寸法替え＝地図の canvas の作り直しを一呼吸待つ
		if (doc.waitLoading) await map.prepareScenes?.(doc);   // 上映と同じ先読み＝台本の全区を読み切り GPU に立ててから 1 コマ目（冷えた端末で開幕行が平らな基図になった・2026-10-28 試し撮り）
		for (let f = 0; f < N; f++) {
			if (signal?.aborted) throw new DOMException("aborted", "AbortError");
			if (encErr) throw encErr;
			const t = f / fps;
			ctx.globalAlpha = 1; ctx.fillStyle = "#000"; ctx.fillRect(0, 0, width, height);
			const s = t - tOpen;
			if (s < 0) {   // 開幕カード（黒の上）
				const a = clamp01(Math.min(t / CARD_FADE, (tOpen - t) / CARD_FADE));
				P.card(opening!, L, a, t);
			} else if (s <= tl.dur + FADE_OUT) {
				const ts = Math.min(s, tl.dur);
				const pose = tl.at(ts), key = [pose.lon, pose.lat, pose.zoom, pose.pitch, pose.bearing, pose.time ?? ""].map(v => typeof v === "number" ? v.toFixed(9) : v).join("|");
				const ri = pose.i, r = rows[ri], rec = tl.rows[ri];
				if (key !== lastKey || f === 0) {   // 絵が動いた時だけ描き直す（保持で止まっている間・溶暗の間は前のコマ）
					if (ri !== lastRow && r?.fade && r.dissolve && stillRow !== ri) { sctx.clearRect(0, 0, width, height); sctx.drawImage(base, 0, 0); stillRow = ri; }   // 溶け替え＝切り替わる直前の絵を止めて持つ
					tl.seek(ts);
					// 光の色（第5便）＝上映と同じ乗算。WebGPU はエンジンが掛ける（窓の明かりは暗くしない・撮影に入る）＝下の色板は WebGL2 の時だけ
					const alt = map.getSunPosition().altitude, g0 = gradeOn ? gradeOf(alt) : null;
					const g = map.setGrade(g0, { glow: lightsOn && g0 ? glowOf(alt) : 0 }) ? null : g0;
					await settle(ri !== lastRow ? waitMs : Math.min(waitMs, 4000));
					const snap = composeLayersToCanvas(await map.requestSnapshot(), null, solarSkyOf(map.mapEl));
					bctx.clearRect(0, 0, width, height); bctx.drawImage(snap, 0, 0, width, height);
					if (g) { bctx.globalCompositeOperation = "multiply"; bctx.fillStyle = `rgb(${g[0]},${g[1]},${g[2]})`; bctx.fillRect(0, 0, width, height); bctx.globalCompositeOperation = "source-over"; }
					lastKey = key; lastRow = ri;
				}
				ctx.drawImage(base, 0, 0);
				if (r?.fade && r.dissolve && stillRow === ri && rec) {   // 溶け替え：切替 0.3s→止めた絵が travel 秒で溶ける（fadeViewRun と同じ拍）
					const fd = typeof r.travel === "number" && r.travel > 0 ? r.travel : 1.2, u = ts - rec.t0;
					const a = u < 0.3 ? 1 : clamp01(1 - (u - 0.3) / fd);
					if (a > 0) { ctx.globalAlpha = a; ctx.drawImage(still, 0, 0); ctx.globalAlpha = 1; }
				}
				// 幕（slide）と字幕：demo の拍の写し（view+slide＝地図ひと目→幕→三拍目／幕だけ＝入場で幕）
				if (r && rec) {
					const h = typeof r.hold === "number" ? r.hold : hold, sh = typeof r.slideHold === "number" ? r.slideHold : slideHold;
					let sA = 0;
					if (r.slide) {
						const s0 = r.view ? rec.tArrive + Math.min(2, h) : rec.tArrive, s1 = r.view ? s0 + sh : rec.t1;
						sA = clamp01(Math.min((ts - s0) / 0.4, (s1 - ts) / 0.4));
						P.slide(isImg(r.slide) ? null : r.slide, isImg(r.slide) ? imgs.get(r.slide) ?? null : null, sA);
					}
					const c0 = r.path ? rec.t0 : rec.tArrive, text = (r.caption as string | undefined) ?? T(r, L);
					const capA = clamp01(Math.min((ts - c0) / CAP_FADE, (rec.t1 + CAP_FADE - ts) / CAP_FADE)) * (1 - sA);
					P.caption(typeof r.look === "string" ? r.look : "top", text, pick(r.sub, L), capA);
				}
				P.credit(credit);
				// 黒幕：開幕の溶明・fade 行の黒・終幕の溶暗
				const cover = Math.max(pose.cover || 0, s < FADE_IN ? 1 - s / FADE_IN : 0, s > tl.dur ? (s - tl.dur) / FADE_OUT : 0);
				if (cover > 0) { ctx.globalAlpha = clamp01(cover); ctx.fillStyle = "#000"; ctx.fillRect(0, 0, width, height); ctx.globalAlpha = 1; }
			} else if (ending) {   // 終幕カード
				const u = s - tl.dur - FADE_OUT;
				P.card(ending, L, clamp01(Math.min(u / CARD_FADE, (tEnd - u) / CARD_FADE)), u);
			}
			const frame = new VideoFrame(out, { timestamp: Math.round(f * 1e6 / fps), duration: Math.round(1e6 / fps) });
			encoder.encode(frame, { keyFrame: f % (fps * 2) === 0 });
			frame.close();
			while (encoder.encodeQueueSize > 6) await new Promise(r => setTimeout(r, 5));
			if (onProgress && (f % 5 === 0 || f === N - 1)) { const el = (performance.now() - t0w) / 1000; onProgress(f + 1, N, el / (f + 1) * (N - f - 1)); }
		}
		await encoder.flush();
		if (encErr) throw encErr;
		if (pcm) await encodeAac(pcm, mux);   // 音は映像の後に一気に（標本は mdat の後ろへ並ぶ＝箱詰めは標本ごとの位置を持つので混ざってよい）
		return mux.finalize();
	} finally {
		try { encoder.close(); } catch { /* 閉じ済み */ }
		tl.end();
		map.mapEl.classList.remove("scene-clean");
		if (light) { map.setSun(sunBefore ?? null); if ((light as { shadows?: unknown }).shadows !== false) map.setShadows(false); map.setGrade(null); if (lightsOn) map.setCityLights(false); }
		if (liveBefore) map.clock.live(); else map.clock.setTime(timeBefore);
		map.pinRes?.(false);
		if (rasterBefore.base !== map.raster.selected().base) void map.raster.select(rasterBefore.base).catch(() => null);
		for (const id of map.raster.selected().overs) if (!rasterBefore.overs.includes(id)) void map.raster.toggle(id, false).catch(() => null);
		for (const id of rasterBefore.overs) void map.raster.toggle(id, true).catch(() => null);
		frameEl.style.width = old.w; frameEl.style.height = old.h; frameEl.style.transform = old.t;
		imgs.forEach(b => b?.close());
	}
}
