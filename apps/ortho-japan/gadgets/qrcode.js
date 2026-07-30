// 自作 QR コード生成（依存ゼロ・byte モード・EC レベル L・version 1〜6）。ISO/IEC 18004 準拠の最小実装。
// 用途＝現在の共有URL（視点）を画面に QR で出す＝スクリーン投影→観客がスキャン→そのままの視点で開く＝拡散。
// 共有URLは概ね 50〜110字＝v6-L(134byte)で余裕。version を 1〜6 に絞る＝v7+ の version-info・複数アラインメントを避け、
//   実装を小さく安全に（v1〜5 は 1 ブロック、v6 のみ 2 ブロック）。EC-L＝きれいな画面表示なら誤り訂正は最小で十分＋モジュールが疎で遠くから読める。
// 返り＝真偽値の2次元配列（true=黒モジュール）。描画は呼び出し側（canvas / SVG）。qrMatrix(text) が入口。
// ★オフラインではスキャン検証ができないため、検証可能な所（フォーマット情報のBCH・GF）は末尾の自己テストで固める。

// --- GF(256)（原始多項式 0x11d）：Reed-Solomon 用の指数/対数表 ---
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
(() => { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

// RS 生成多項式（EC符号語数 n）: ∏(x - α^i)、係数はバイト。
function rsGen(n) {
	let g = [1];   // 高次係数が先頭（g[0]=1＝モニック）
	for (let i = 0; i < n; i++) {
		const ng = new Array(g.length + 1).fill(0);   // × (x - α^i)
		for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= gfMul(g[j], EXP[i]); }
		g = ng;
	}
	return g;   // 長さ n+1、g[0]=1
}
// data（バイト配列）の RS EC 符号語（n 個）＝LFSR 系統的符号化
function rsEC(data, n) {
	const g = rsGen(n), ec = new Uint8Array(n);
	for (const d of data) {
		const f = d ^ ec[0];
		ec.copyWithin(0, 1); ec[n - 1] = 0;
		if (f) for (let j = 0; j < n; j++) ec[j] ^= gfMul(g[j + 1], f);
	}
	return ec;
}

// version 1〜6 の EC-L テーブル：{ ec:ブロック毎のEC符号語数, blocks:[[ブロック数, ブロック毎データ符号語数]...], dataCW:総データ符号語 }
// 総符号語 = 26,44,70,100,134,172。EC-L のデータ符号語 = 19,34,55,80,108,136。v6 のみ 2 ブロック(68+68)。
const TABLE = {
	1: { ec: 7, blocks: [[1, 19]], dataCW: 19 },
	2: { ec: 10, blocks: [[1, 34]], dataCW: 34 },
	3: { ec: 15, blocks: [[1, 55]], dataCW: 55 },
	4: { ec: 20, blocks: [[1, 80]], dataCW: 80 },
	5: { ec: 26, blocks: [[1, 108]], dataCW: 108 },
	6: { ec: 18, blocks: [[2, 68]], dataCW: 136 },
};
const ALIGN = { 2: 18, 3: 22, 4: 26, 5: 30, 6: 34 };   // v2〜6 のアラインメント中心座標（v1 は無し）

// テキスト → 最終コード語列（データ＋EC・インターリーブ済み）と version
function encode(text) {
	const bytes = new TextEncoder().encode(text);   // UTF-8（共有URLは基本ASCII）
	let ver = 0;
	for (let v = 1; v <= 6; v++) if (bytes.length <= TABLE[v].dataCW - 2) { ver = v; break; }   // ヘッダ(mode4+count8=12bit)+終端≒2byte を差し引いた容量
	if (!ver) throw new Error(`QR: データが長すぎます（${bytes.length}byte > v6-L 134byte）`);
	const t = TABLE[ver];
	// ビット列を作る
	const bits = [];
	const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
	put(0b0100, 4);          // byte モード指示子
	put(bytes.length, 8);    // 文字数（v1〜9 は 8bit）
	for (const b of bytes) put(b, 8);
	const cap = t.dataCW * 8;
	for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);   // 終端子（最大4bit）
	while (bits.length % 8) bits.push(0);                            // バイト境界へ 0 埋め
	for (let i = 0; bits.length < cap; i++) put(i % 2 ? 0x11 : 0xEC, 8);   // パッドバイト 0xEC/0x11 交互
	// バイト配列へ
	const dataCW = new Uint8Array(t.dataCW);
	for (let i = 0; i < t.dataCW; i++) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j]; dataCW[i] = v; }
	// ブロック分割＋RS
	const dBlocks = [], eBlocks = [];
	let off = 0;
	for (const [cnt, per] of t.blocks) for (let b = 0; b < cnt; b++) {
		const d = dataCW.slice(off, off + per); off += per;
		dBlocks.push(d); eBlocks.push(rsEC(d, t.ec));
	}
	// インターリーブ（データ→EC の順に、各ブロックの i 番目を巡回）
	const out = [];
	const maxD = Math.max(...dBlocks.map(d => d.length));
	for (let i = 0; i < maxD; i++) for (const d of dBlocks) if (i < d.length) out.push(d[i]);
	for (let i = 0; i < t.ec; i++) for (const e of eBlocks) out.push(e[i]);
	return { ver, codewords: out };
}

// フォーマット情報 15bit（EC-L=指示子 0b01・BCH(15,5)・マスク 0x5412 で撹拌）。bit0=LSB。
function formatBits(mask) {
	const data = (0b01 << 3) | mask;   // 5bit
	let rem = data << 10;
	for (let i = 14; i >= 10; i--) if (rem & (1 << i)) rem ^= 0b10100110111 << (i - 10);   // ÷ G(x)=0x537
	return ((data << 10) | (rem & 0x3ff)) ^ 0b101010000010010;
}

// マスク関数 0〜7（true の所を反転）
const MASKS = [
	(r, c) => (r + c) % 2 === 0,
	(r, c) => r % 2 === 0,
	(r, c) => c % 3 === 0,
	(r, c) => (r + c) % 3 === 0,
	(r, c) => (((r >> 1) + Math.floor(c / 3)) % 2) === 0,
	(r, c) => ((r * c) % 2 + (r * c) % 3) === 0,
	(r, c) => (((r * c) % 2 + (r * c) % 3) % 2) === 0,
	(r, c) => (((r + c) % 2 + (r * c) % 3) % 2) === 0,
];

// version + コード語列 → モジュール行列。マスクは 8 種を採点して最良を採用。
function buildMatrix(ver, codewords) {
	const size = ver * 4 + 17;
	const m = Array.from({ length: size }, () => new Array(size).fill(false));   // モジュール（true=黒）
	const fn = Array.from({ length: size }, () => new Array(size).fill(false));  // 機能モジュール（データ配置/マスク対象外）
	const set = (r, c, v) => { m[r][c] = v; fn[r][c] = true; };
	// ファインダ + セパレータ（3隅）
	const finder = (r0, c0) => {
		for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
			const rr = r0 + r, cc = c0 + c; if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
			const black = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6)) || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
			set(rr, cc, black);
		}
	};
	finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
	// タイミングパターン（行6・列6）
	for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
	// アラインメント（v2〜6：中心1個）
	if (ALIGN[ver] != null) {
		const p = ALIGN[ver];
		for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) set(p + r, p + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
	}
	// ダークモジュール（4V+9, 8）＝(size-8, 8)
	set(size - 8, 8, true);
	// フォーマット情報領域を予約（値は後で・データ配置で踏まないよう機能扱いに）
	const fmtCells = fmtPositions(size);
	for (const [r, c] of fmtCells) { m[r][c] = false; fn[r][c] = true; }
	// データ配置（右下から2列ずつジグザグ・列6スキップ・機能モジュールスキップ）
	const bits = [];
	for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
	let idx = 0, up = true;
	for (let col = size - 1; col > 0; col -= 2) {
		if (col === 6) col--;
		for (let i = 0; i < size; i++) {
			const row = up ? size - 1 - i : i;
			for (let c = 0; c < 2; c++) {
				const cc = col - c;
				if (fn[row][cc]) continue;
				m[row][cc] = (idx < bits.length ? bits[idx] : 0) === 1; idx++;
			}
		}
		up = !up;
	}
	// マスク選定（8種：反転→採点→戻す）。最小ペナルティを採用。
	let best = 0, bestScore = Infinity;
	for (let k = 0; k < 8; k++) {
		xorMask(m, fn, MASKS[k]);
		const s = penalty(m, size);
		if (s < bestScore) { bestScore = s; best = k; }
		xorMask(m, fn, MASKS[k]);   // 戻す
	}
	xorMask(m, fn, MASKS[best]);
	// フォーマット情報を焼き込む（採用マスク）
	placeFormat(m, size, formatBits(best));
	return m;
}

// フォーマット情報 15 モジュールの座標（2コピー）。bit0..14 の順に返す（[bit] = [r,c]）。
function fmtPositions(size) {
	const p = [];
	// コピー1（左上ファインダ周り）
	for (let i = 0; i <= 5; i++) p[i] = [8, i];
	p[6] = [8, 7]; p[7] = [8, 8]; p[8] = [7, 8];
	for (let i = 9; i <= 14; i++) p[i] = [14 - i, 8];   // i=9→(5,8) … i=14→(0,8)（行6スキップ）
	// コピー2は同じ bit を別位置にも置く＝下でまとめて返すため、ここでは1コピー分の座標のみ（予約は placeFormat が両方触る）
	return p.concat(fmtPositions2(size));
}
function fmtPositions2(size) {
	const p = [];
	for (let i = 0; i <= 6; i++) p[i] = [size - 1 - i, 8];        // 下→上（bit0..6）
	for (let i = 7; i <= 14; i++) p[i] = [8, size - 15 + i];      // 左→右（bit7..14・col size-8..size-1）
	return p;
}
function placeFormat(m, size, bits) {
	const c1 = fmtPositions(size).slice(0, 15), c2 = fmtPositions2(size);
	for (let i = 0; i <= 14; i++) { const b = (bits >> (14 - i)) & 1; m[c1[i][0]][c1[i][1]] = b === 1; m[c2[i][0]][c2[i][1]] = b === 1; }   // ★MSB(bit14)を先頭座標へ＝標準の並び（bit0先頭だと逆順でスキャン不可だった）
}
function xorMask(m, fn, fnMask) {
	for (let r = 0; r < m.length; r++) for (let c = 0; c < m.length; c++) if (!fn[r][c] && fnMask(r, c)) m[r][c] = !m[r][c];
}

// マスク採点（ISO の 4 規則）。低いほど良い＝読みやすい。
function penalty(m, size) {
	let s = 0;
	// 規則1：行/列の同色連続（5以上で 3+超過分）
	for (let r = 0; r < size; r++) for (const line of [r]) {
		let run = 1; for (let c = 1; c < size; c++) { if (m[r][c] === m[r][c - 1]) { run++; if (run === 5) s += 3; else if (run > 5) s++; } else run = 1; }
	}
	for (let c = 0; c < size; c++) { let run = 1; for (let r = 1; r < size; r++) { if (m[r][c] === m[r - 1][c]) { run++; if (run === 5) s += 3; else if (run > 5) s++; } else run = 1; } }
	// 規則2：2x2 同色ブロック（+3）
	for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) s += 3;
	// 規則3：1:1:3:1:1 + 空白 4 のファインダ類似（+40）
	const pat1 = [true, false, true, true, true, false, true, false, false, false, false];
	const pat2 = [false, false, false, false, true, false, true, true, true, false, true];
	const lineHas = arr => { let cnt = 0; for (let i = 0; i + 11 <= arr.length; i++) { let ok1 = true, ok2 = true; for (let j = 0; j < 11; j++) { if (arr[i + j] !== pat1[j]) ok1 = false; if (arr[i + j] !== pat2[j]) ok2 = false; } if (ok1 || ok2) cnt++; } return cnt; };
	for (let r = 0; r < size; r++) s += 40 * lineHas(m[r]);
	for (let c = 0; c < size; c++) { const col = []; for (let r = 0; r < size; r++) col.push(m[r][c]); s += 40 * lineHas(col); }
	// 規則4：黒比率の 50% からのズレ
	let dark = 0; for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c]) dark++;
	const pct = dark * 100 / (size * size);
	s += Math.floor(Math.abs(pct - 50) / 5) * 10;
	return s;
}

// 入口：テキスト → モジュール行列（boolean[][]、true=黒）。version は自動（1〜6）。
export function qrMatrix(text) {
	const { ver, codewords } = encode(text);
	return buildMatrix(ver, codewords);
}

// --- 自己テスト（検証可能な所だけ・オフラインでスキャン検証はできないため）。壊れていたら console.error で自己申告 ---
export function qrSelfTest() {
	const fails = [];
	// フォーマット情報 BCH：EC-L の 8 マスクの既知値と一致するか（ISO 表）
	const known = [0b111011111000100, 0b111001011110011, 0b111110110101010, 0b111100010011101, 0b110011000101111, 0b110001100011000, 0b110110001000001, 0b110100101110110];
	for (let k = 0; k < 8; k++) if (formatBits(k) !== known[k]) fails.push(`format[${k}] ${formatBits(k).toString(2)}≠${known[k].toString(2)}`);
	// GF：α^0=1, α^255=1（周期）, 乗算の可換
	if (EXP[0] !== 1 || EXP[255] !== 1 || gfMul(3, 7) !== gfMul(7, 3)) fails.push("GF");
	// RS：ISO 附属書の既知ベクトル（1-M "01234567"）＝データ16→EC10 が一致するか（GF+RS を実証）
	const rd = [0x10, 0x20, 0x0C, 0x56, 0x61, 0x80, 0xEC, 0x11, 0xEC, 0x11, 0xEC, 0x11, 0xEC, 0x11, 0xEC, 0x11];
	const re = [0xA5, 0x24, 0xD4, 0xC1, 0xED, 0x36, 0xC7, 0x87, 0x2C, 0x55];
	if (rsEC(rd, 10).some((v, i) => v !== re[i])) fails.push("RS:" + [...rsEC(rd, 10)].map(x => x.toString(16)).join(","));
	// golden-master：既知の正しい出力（開発時に jsQR で往復デコード検証済み・v1/v3/v6＝配置/マスク/RS/整列/複数ブロックを網羅）の
	// FNVハッシュ。フォーマット配置のビット順のような「値は正しいが並びが逆」の回帰を丸ごと捕まえる（実際にそれで一度出荷が壊れた）。
	const fnv = s => { const g = qrMatrix(s).flat(); let x = 2166136261 >>> 0; for (let i = 0; i < g.length; i++) { x ^= (g[i] ? 1 : 0); x = Math.imul(x, 16777619) >>> 0; } return x; };
	for (const [s, h] of [["OJ", 3987601905], ["https://www.ortho-earth.com/japan/#12/35/139/c=dark", 3733310888], ["x".repeat(120), 2753418475]]) if (fnv(s) !== h) fails.push("golden:" + s.slice(0, 10));
	// 構造：短文の QR が v1(21x21)・3隅にファインダ・行6タイミング
	const m = qrMatrix("HELLO");
	const okFinder = m.length === 21 && m[0][0] && m[0][6] && !m[1][1] && m[2][2] && m[0][20] && m[20][0];   // ファインダ：外枠黒(0,0)(0,6)・白リング(1,1)・中心黒(2,2)・他2隅も黒
	const okTiming = m[6][8] === true && m[6][9] === false;   // 行6は 8=黒,9=白,…
	if (!okFinder) fails.push("finder/size");
	if (!okTiming) fails.push("timing");
	if (fails.length) console.error("[qrcode] 自己テスト失敗:", fails.join(" / "));
	return fails.length === 0;
}
