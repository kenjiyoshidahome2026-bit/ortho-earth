// 自作 QR コード生成（依存ゼロ・byte モード・EC レベル L/M/Q/H・version 1〜6）。ISO/IEC 18004 準拠の最小実装。
// 用途＝現在の共有URL（視点）を画面に QR で出す＝スクリーン投影→観客がスキャン→そのままの視点で開く＝拡散。
//   ＋中央に大きなサイン（favicon）を載せるため、URLが短いほど強い誤り訂正(H>Q>M>L)を自動採用＝ロゴで欠けても直る余白を稼ぐ。
//   短い名刺URL＝EC-H＝ロゴ大でもスキャン可／長い視点URL＝EC-L＝ロゴは自動で控えめ（実測=EC-Lでロゴ倍化は復号不能）。
// version を 1〜6 に絞る＝v7+ の version-info・複数アラインメントを避け、実装を小さく安全に（低versionは1ブロック・v5/6等は複数ブロック）。
// 返り＝qrEncode(text,{level})→{ matrix, ver, level, ec }。qrMatrix(text)＝行列だけ（既定 L・後方互換）。描画は呼び出し側（canvas / SVG）。
// ★オフラインではスキャン検証ができないため、検証可能な所（フォーマットBCH・GF・RS既知ベクトル・golden-master）は末尾の自己テストで固める。

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

// version × EC レベルのブロック構成（ISO/IEC 18004 表9）：{ ec:ブロック毎EC符号語数, blocks:[[ブロック数, ブロック毎データ符号語数]...], dataCW:総データ符号語 }。
// 各(v,level)で data+EC = 総符号語(26,44,70,100,134,172)。v5-Q/H は 2 群（データ長違い）＝下のインターリーブが吸収。訂正能力 ≈ 総EC/2 符号語。
const TABLES = {
	L: { 1: { ec: 7, blocks: [[1, 19]], dataCW: 19 }, 2: { ec: 10, blocks: [[1, 34]], dataCW: 34 }, 3: { ec: 15, blocks: [[1, 55]], dataCW: 55 }, 4: { ec: 20, blocks: [[1, 80]], dataCW: 80 }, 5: { ec: 26, blocks: [[1, 108]], dataCW: 108 }, 6: { ec: 18, blocks: [[2, 68]], dataCW: 136 } },
	M: { 1: { ec: 10, blocks: [[1, 16]], dataCW: 16 }, 2: { ec: 16, blocks: [[1, 28]], dataCW: 28 }, 3: { ec: 26, blocks: [[1, 44]], dataCW: 44 }, 4: { ec: 18, blocks: [[2, 32]], dataCW: 64 }, 5: { ec: 24, blocks: [[2, 43]], dataCW: 86 }, 6: { ec: 16, blocks: [[4, 27]], dataCW: 108 } },
	Q: { 1: { ec: 13, blocks: [[1, 13]], dataCW: 13 }, 2: { ec: 22, blocks: [[1, 22]], dataCW: 22 }, 3: { ec: 18, blocks: [[2, 17]], dataCW: 34 }, 4: { ec: 26, blocks: [[2, 24]], dataCW: 48 }, 5: { ec: 18, blocks: [[2, 15], [2, 16]], dataCW: 62 }, 6: { ec: 24, blocks: [[4, 19]], dataCW: 76 } },
	H: { 1: { ec: 17, blocks: [[1, 9]], dataCW: 9 }, 2: { ec: 28, blocks: [[1, 16]], dataCW: 16 }, 3: { ec: 22, blocks: [[2, 13]], dataCW: 26 }, 4: { ec: 16, blocks: [[4, 9]], dataCW: 36 }, 5: { ec: 22, blocks: [[2, 11], [2, 12]], dataCW: 46 }, 6: { ec: 28, blocks: [[4, 15]], dataCW: 60 } },
};
const EC_IND = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };   // フォーマット情報の EC レベル指示子（2bit）
const ALIGN = { 2: 18, 3: 22, 4: 26, 5: 30, 6: 34 };   // v2〜6 のアラインメント中心座標（v1 は無し）
// bytes 長 → そのレベルで収まる最小 version（無ければ 0）。ヘッダ(mode4+count8=12bit)+終端≒2byte を差し引いた容量で判定。
const pickVersion = (len, level) => { const T = TABLES[level]; for (let v = 1; v <= 6; v++) if (len <= T[v].dataCW - 2) return v; return 0; };
// 「収まる中で最も強い EC」＝H>Q>M>L の順に最初に v≤6 へ収まるレベル。短いURLほど強くなり＝中央ロゴの被覆余白が増える。
const bestLevel = len => { for (const lv of ["H", "Q", "M", "L"]) if (pickVersion(len, lv)) return lv; return "L"; };

// テキスト+レベル → 最終コード語列（データ＋EC・インターリーブ済み）と version・総EC符号語数
function encode(text, level) {
	const bytes = new TextEncoder().encode(text);   // UTF-8（共有URLは基本ASCII）
	const ver = pickVersion(bytes.length, level);
	if (!ver) throw new Error(`QR: data too long (${bytes.length} bytes > v6-${level} limit)`);
	const t = TABLES[level][ver];
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
	return { ver, codewords: out, ecTotal: t.ec * t.blocks.reduce((s, [cnt]) => s + cnt, 0) };
}

// フォーマット情報 15bit（EC指示子 2bit＝L01/M00/Q11/H10・BCH(15,5)・マスク 0x5412 で撹拌）。bit0=LSB。
function formatBits(mask, level) {
	const data = (EC_IND[level] << 3) | mask;   // 5bit
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

// version + コード語列 + EC レベル → モジュール行列。マスクは 8 種を採点して最良を採用。
function buildMatrix(ver, codewords, level) {
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
	// フォーマット情報を焼き込む（採用マスク＋EC レベル指示子）
	placeFormat(m, size, formatBits(best, level));
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

// 入口（推奨）：テキスト → { matrix:boolean[][](true=黒), ver, level, ec:総EC符号語数 }。
// opts.level＝"L"|"M"|"Q"|"H"（明示）／"auto" or 未指定＝収まる中で最も強いレベルを自動採用（bestLevel）。
// ec は呼び出し側の中央ロゴ寸法決めに使う（覆えるモジュール ≈ 訂正能力＝ec/2 に収める）。
export function qrEncode(text, opts = {}) {
	const level = opts.level && opts.level !== "auto" ? opts.level : bestLevel(new TextEncoder().encode(text).length);
	const { ver, codewords, ecTotal } = encode(text, level);
	return { matrix: buildMatrix(ver, codewords, level), ver, level, ec: ecTotal };
}
// 後方互換：テキスト → モジュール行列（boolean[][]）だけ。既定 EC-L 固定（golden-master と同じ既定）。
export function qrMatrix(text) {
	const { ver, codewords } = encode(text, "L");
	return buildMatrix(ver, codewords, "L");
}

// --- 自己テスト（検証可能な所だけ・オフラインでスキャン検証はできないため）。壊れていたら console.error で自己申告 ---
export function qrSelfTest() {
	const fails = [];
	// フォーマット情報 BCH：4 EC レベル × 8 マスクの既知値（ISO/IEC 18004 表 C.1）と一致するか。指示子(L01/M00/Q11/H10)→BCH→マスクの全経路を固める。
	const known = {
		L: [0b111011111000100, 0b111001011110011, 0b111110110101010, 0b111100010011101, 0b110011000101111, 0b110001100011000, 0b110110001000001, 0b110100101110110],
		M: [0b101010000010010, 0b101000100100101, 0b101111001111100, 0b101101101001011, 0b100010111111001, 0b100000011001110, 0b100111110010111, 0b100101010100000],
		Q: [0b011010101011111, 0b011000001101000, 0b011111100110001, 0b011101000000110, 0b010010010110100, 0b010000110000011, 0b010111011011010, 0b010101111101101],
		H: [0b001011010001001, 0b001001110111110, 0b001110011100111, 0b001100111010000, 0b000011101100010, 0b000001001010101, 0b000110100001100, 0b000100000111011],
	};
	for (const lv of ["L", "M", "Q", "H"]) for (let k = 0; k < 8; k++) if (formatBits(k, lv) !== known[lv][k]) fails.push(`format[${lv}][${k}] ${formatBits(k, lv).toString(2)}≠${known[lv][k].toString(2)}`);
	// GF：α^0=1, α^255=1（周期）, 乗算の可換
	if (EXP[0] !== 1 || EXP[255] !== 1 || gfMul(3, 7) !== gfMul(7, 3)) fails.push("GF");
	// RS：ISO 附属書の既知ベクトル（1-M "01234567"）＝データ16→EC10 が一致するか（GF+RS を実証）
	const rd = [0x10, 0x20, 0x0C, 0x56, 0x61, 0x80, 0xEC, 0x11, 0xEC, 0x11, 0xEC, 0x11, 0xEC, 0x11, 0xEC, 0x11];
	const re = [0xA5, 0x24, 0xD4, 0xC1, 0xED, 0x36, 0xC7, 0x87, 0x2C, 0x55];
	if (rsEC(rd, 10).some((v, i) => v !== re[i])) fails.push("RS:" + [...rsEC(rd, 10)].map(x => x.toString(16)).join(","));
	// 自動 EC レベル：短い名刺URL＝収まる中で最強(H)・長い視点URL＝L まで落ちる（bestLevel の契約）。
	if (qrEncode("https://ortho-earth.com/japan/").level !== "H" || qrEncode("x".repeat(120)).level !== "L") fails.push("autoLevel");
	// golden-master：既知の正しい出力（BarcodeDetector で往復デコード検証済み）の FNVハッシュ。level=null は qrMatrix(既定L)、
	// それ以外は qrEncode(s,{level})＝レベル別の指示子・ブロック構成・RS・整列まで丸ごと固定（「値は正しいが並びが逆」の回帰も捕まえる）。
	const fnv = mat => { const g = mat.flat(); let x = 2166136261 >>> 0; for (let i = 0; i < g.length; i++) { x ^= (g[i] ? 1 : 0); x = Math.imul(x, 16777619) >>> 0; } return x; };
	for (const [s, lv, h] of [
		["OJ", null, 3987601905], ["https://www.ortho-earth.com/japan/#12/35/139/c=dark", null, 3733310888], ["x".repeat(120), null, 2753418475],
		["https://ortho-earth.com/japan/", "H", 1048296628], ["https://www.ortho-earth.com/japan/?hud=1#5/37/138", "Q", 1146452263], ["x".repeat(60), "M", 3224508297],
	]) if (fnv(lv ? qrEncode(s, { level: lv }).matrix : qrMatrix(s)) !== h) fails.push("golden:" + (lv || "L") + ":" + s.slice(0, 10));
	// 構造：短文の QR が v1(21x21)・3隅にファインダ・行6タイミング
	const m = qrMatrix("HELLO");
	const okFinder = m.length === 21 && m[0][0] && m[0][6] && !m[1][1] && m[2][2] && m[0][20] && m[20][0];   // ファインダ：外枠黒(0,0)(0,6)・白リング(1,1)・中心黒(2,2)・他2隅も黒
	const okTiming = m[6][8] === true && m[6][9] === false;   // 行6は 8=黒,9=白,…
	if (!okFinder) fails.push("finder/size");
	if (!okTiming) fails.push("timing");
	if (fails.length) console.error("[qrcode] self-test failed:", fails.join(" / "));
	return fails.length === 0;
}
