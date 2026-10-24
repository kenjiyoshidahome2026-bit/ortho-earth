// 最小の MP4 箱詰め（WebCodecs の EncodedVideoChunk／EncodedAudioChunk → 1 本の .mp4）＝動画の書き出し（demo/export-video.ts）専用。
// 依存ゼロ（ISO/IEC 14496-12・14496-15 の要るだけ）：映像 H.264（avc1＋avcC）・音声 AAC（mp4a＋esds）・非断片（moov を最後に置く）・
// 標本ごとに 1 チャンク（stsc 1 行・co64）・mdat は 64 bit 長＝4GB 超えも可。B フレーム（表示順≠復号順）が来たら ctts と elst で直す。
// 返り値は Blob（部品の Blob を並べるだけ＝大きな動画もメモリに一枚で持たない・ブラウザが退避する）。

type Bytes = Uint8Array<ArrayBuffer>;
const enc = new TextEncoder();
const u8 = (n: number) => new Uint8Array([n & 255]);
const u16 = (n: number) => new Uint8Array([(n >>> 8) & 255, n & 255]);
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const u64 = (n: number) => { const hi = Math.floor(n / 2 ** 32), lo = n >>> 0; return cat(u32(hi), u32(lo)); };
const i32 = (n: number) => u32(n < 0 ? n + 2 ** 32 : n);
const str = (s: string) => enc.encode(s) as Bytes;
function cat(...parts: Uint8Array[]): Bytes {
	const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
	let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
	return out;
}
const box = (type: string, ...body: Uint8Array[]) => { const b = cat(...body); return cat(u32(8 + b.length), str(type), b); };
const full = (type: string, version: number, flags: number, ...body: Uint8Array[]) => box(type, u8(version), u8(flags >> 16), u16(flags & 0xffff), ...body);
const MATRIX = cat(u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000));

interface Sample { size: number; offset: number; pts: number; dur: number; key: boolean }
interface TrackBase { id: number; timescale: number; samples: Sample[]; description: Bytes | null }
interface VideoTrack extends TrackBase { kind: "video"; width: number; height: number }
interface AudioTrack extends TrackBase { kind: "audio"; sampleRate: number; channels: number }
type Track = VideoTrack | AudioTrack;

/** 映像の設定（width/height＝画素・fps＝標本の尺の基準） */
export interface Mp4VideoOpts { width: number; height: number; fps: number }
/** 音声の設定（AAC・sampleRate/channels） */
export interface Mp4AudioOpts { sampleRate: number; channels: number }

export class Mp4Muxer {
	private parts: BlobPart[] = [];
	private pos = 0;
	private tracks: Track[] = [];
	readonly video: VideoTrack;
	readonly audio: AudioTrack | null;
	private fps: number;
	constructor(v: Mp4VideoOpts, a?: Mp4AudioOpts | null) {
		this.fps = v.fps;
		this.video = { kind: "video", id: 1, timescale: Math.round(v.fps * 1000), samples: [], description: null, width: v.width, height: v.height };
		this.tracks.push(this.video);
		this.audio = a ? { kind: "audio", id: 2, timescale: a.sampleRate, samples: [], description: null, sampleRate: a.sampleRate, channels: a.channels } : null;
		if (this.audio) this.tracks.push(this.audio);
		const ftyp = box("ftyp", str("isom"), u32(0x200), str("isom"), str("iso2"), str("avc1"), str("mp41"));
		this.push(ftyp);
		this.push(cat(u32(1), str("mdat"), u64(0)));   // 64 bit 長の mdat（長さは finalize で別の頭に差し替え）
	}
	private push(b: BlobPart & { byteLength?: number; size?: number }) { this.parts.push(b); this.pos += (b as Uint8Array).byteLength ?? (b as Blob).size; }
	private add(t: Track, chunk: EncodedVideoChunk | EncodedAudioChunk, meta: EncodedVideoChunkMetadata | EncodedAudioChunkMetadata | undefined, durTS: number) {
		const desc = (meta as { decoderConfig?: { description?: AllowSharedBufferSource } } | undefined)?.decoderConfig?.description;
		if (desc && !t.description) t.description = new Uint8Array(desc instanceof ArrayBuffer ? desc.slice(0) : (desc as ArrayBufferView).buffer.slice((desc as ArrayBufferView).byteOffset, (desc as ArrayBufferView).byteOffset + (desc as ArrayBufferView).byteLength)) as Bytes;
		const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
		t.samples.push({ size: data.length, offset: this.pos, pts: Math.round(chunk.timestamp * t.timescale / 1e6), dur: durTS, key: chunk.type === "key" });
		this.push(data);
	}
	addVideo(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) { this.add(this.video, chunk, meta, 1000); }
	addAudio(chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) {
		if (!this.audio) return;
		this.add(this.audio, chunk, meta, Math.max(1, Math.round((chunk.duration ?? 0) * this.audio.timescale / 1e6)) || 1024);
	}
	/** 箱を閉じる＝moov を書いて Blob を返す */
	finalize(): Blob {
		const mdatLen = this.pos - 32;   // ftyp(32 B) の後ろ＝mdat の頭（16 B）から末尾まで
		const durMs = Math.max(...this.tracks.map(t => this.trackDur(t) * 1000 / t.timescale), 0);
		const moov = box("moov",
			full("mvhd", 0, 0, u32(0), u32(0), u32(1000), u32(Math.round(durMs)), u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), MATRIX, new Uint8Array(24), u32(this.tracks.length + 1)),
			...this.tracks.map(t => this.trak(t, durMs)));
		this.parts[1] = cat(u32(1), str("mdat"), u64(mdatLen));
		return new Blob([...this.parts, moov], { type: "video/mp4" });
	}
	private trackDur(t: Track) { return t.samples.reduce((a, s) => a + s.dur, 0); }
	private trak(t: Track, movieDurMs: number) {
		const dur = this.trackDur(t), isV = t.kind === "video";
		// 復号順＝届いた順（WebCodecs の出力順）。表示時刻との差が出たら ctts（B フレーム）＋elst で頭をずらす
		let dts = 0; const offs = t.samples.map(s => { const o = s.pts - dts; dts += s.dur; return o; });
		const minOff = Math.min(0, ...offs), useCtts = offs.some(o => o !== 0);
		const shift = useCtts ? -minOff : 0;
		const tkhd = full("tkhd", 0, 3, u32(0), u32(0), u32(t.id), u32(0), u32(Math.round(movieDurMs)), new Uint8Array(8), u16(0), u16(0), u16(isV ? 0 : 0x0100), u16(0), MATRIX,
			u32(isV ? (t as VideoTrack).width * 65536 : 0), u32(isV ? (t as VideoTrack).height * 65536 : 0));
		const edts = shift ? box("edts", full("elst", 0, 0, u32(1), u32(Math.round(movieDurMs)), u32(shift), u16(1), u16(0))) : new Uint8Array(0);
		const mdhd = full("mdhd", 0, 0, u32(0), u32(0), u32(t.timescale), u32(dur), u16(0x55c4), u16(0));
		const hdlr = full("hdlr", 0, 0, u32(0), str(isV ? "vide" : "soun"), new Uint8Array(12), str(isV ? "VideoHandler\0" : "SoundHandler\0"));
		const mhd = isV ? full("vmhd", 0, 1, new Uint8Array(8)) : full("smhd", 0, 0, u16(0), u16(0));
		const dinf = box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1)));
		// stts は尺の同じ並びを畳む
		const runs: [number, number][] = []; for (const s of t.samples) { const r = runs[runs.length - 1]; if (r && r[1] === s.dur) r[0]++; else runs.push([1, s.dur]); }
		const stts = full("stts", 0, 0, u32(runs.length), ...runs.flatMap(([n, d]) => [u32(n), u32(d)]));
		const ctts = useCtts ? full("ctts", 0, 0, u32(t.samples.length), ...offs.flatMap(o => [u32(1), i32(o + shift)])) : new Uint8Array(0);
		const keys = t.samples.map((s, i) => s.key ? i + 1 : 0).filter(Boolean);
		const stss = isV && keys.length < t.samples.length ? full("stss", 0, 0, u32(keys.length), ...keys.map(u32)) : new Uint8Array(0);
		const stsc = full("stsc", 0, 0, u32(1), u32(1), u32(1), u32(1));
		const stsz = full("stsz", 0, 0, u32(0), u32(t.samples.length), ...t.samples.map(s => u32(s.size)));
		const co64 = full("co64", 0, 0, u32(t.samples.length), ...t.samples.map(s => u64(s.offset)));
		const stbl = box("stbl", this.stsd(t), stts, ctts, stss, stsc, stsz, co64);
		return box("trak", tkhd, edts, box("mdia", mdhd, hdlr, box("minf", mhd, dinf, stbl)));
	}
	private stsd(t: Track) {
		if (t.kind === "video") {
			const avcC = box("avcC", t.description ?? new Uint8Array(0));
			const colr = box("colr", str("nclx"), u16(1), u16(1), u16(1), u8(0));   // BT.709・限定範囲（ブラウザの H.264 の既定）
			const name = new Uint8Array(32); name.set(str("ortho-earth").slice(0, 31), 1); name[0] = 11;
			const avc1 = box("avc1", new Uint8Array(6), u16(1), new Uint8Array(16), u16(t.width), u16(t.height), u32(0x00480000), u32(0x00480000), u32(0), u16(1), name, u16(0x0018), u16(0xffff), avcC, colr);
			return full("stsd", 0, 0, u32(1), avc1);
		}
		// esds：ES_Descriptor(3) → DecoderConfigDescriptor(4)＝AAC(0x40)・音声(0x15) → DecoderSpecificInfo(5)＝AudioSpecificConfig／SLConfig(6)
		const dsi = t.description ?? new Uint8Array(0);
		const desc = (tag: number, body: Uint8Array) => cat(u8(tag), u8(0x80), u8(0x80), u8(0x80), u8(body.length), body);
		const dcd = desc(4, cat(u8(0x40), u8(0x15), new Uint8Array(3), u32(0), u32(0), desc(5, dsi)));
		const esd = desc(3, cat(u16(t.id), u8(0), dcd, desc(6, u8(2))));
		const mp4a = box("mp4a", new Uint8Array(6), u16(1), new Uint8Array(8), u16(t.channels), u16(16), u16(0), u16(0), u32(t.sampleRate * 65536), full("esds", 0, 0, esd));
		return full("stsd", 0, 0, u32(1), mp4a);
	}
	/** 映像の標本数（進捗表示） */
	get frames() { return this.video.samples.length; }
	get fpsValue() { return this.fps; }
}
