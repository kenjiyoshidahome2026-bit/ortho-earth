// タイル形式の登録簿（#88・2026-09-27）＝MVT と MLT（MapLibre Tile）を同じ差し込み口に載せる。
// 契約は「バイト列 → decodeMVT と同じ中間表現」の関数 1 本だけ：
//   decode(bytes: Uint8Array, need?: Set<string>) → { [source-layer 名]: { extent, features: [{ type, props, geom: { coords: Int32Array, ends }, id }] } }
// 下流（build／labels／buildings／merge／描画）は形式を知らない。MVT は decode.js が自分をここへ登録する（既定・同梱）。
// MLT は別パッケージ @ortho-earth/tile-formats（@maplibre/mlt への依存はそこだけ）＝アプリの vite alias が "#tile-formats"
// （package.json の imports・既定＝tileformats-none.js＝何も足さない）を @ortho-earth/tile-formats/register へ向けると登録される。
// この登録簿は import を持たない（葉）＝decode.js → #tile-formats → register → ここ、の順で循環しない。
//
// 遅延読み込み：registerTileFormat({ name, pmtilesType, load }) の load は () => Promise<decode 関数>。解読器の本体（MLT なら
// 数百 KB）を最初の MLT タイルまで読まない＝MVT だけのアプリ・起動の束には 1 バイトも入らない。非同期の呼び手（fetchMVT・
// fetchPMTiles）は loadTileFormat を await してから同期の decodeTile を呼ぶ。同期しか使えない呼び手（vtdraw／vtextrude の
// worker）は生バイトを預かる時（put）に loadTileFormat を済ませる。
// 登録簿は realm（main／各 worker）ごと＝関数は postMessage で渡らない。decode.js が #tile-formats を import するので、
// decode.js を読む realm では必ず登録が済んでいる。

const formats = new Map();      // name → { name, pmtilesType, decode|null, load|null, loading: Promise|null }
const byPmtiles = new Map();    // PMTiles ヘッダの tileType（数）→ name
const warned = new Set();

// name＝style の vector source の "encoding"（MapLibre と同じ語＝"mvt"｜"mlt"）／PMTiles の tileType 名。
// pmtilesType＝PMTiles ヘッダの tileType（1=mvt・6=mlt・無ければ省略）。decode＝同期の解読器・load＝遅延読み込み（どちらか必須）。
export function registerTileFormat({ name, pmtilesType = null, decode = null, load = null } = {}) {
	if (typeof name !== "string" || !name) throw new Error("registerTileFormat: name is required");
	if (typeof decode !== "function" && typeof load !== "function") throw new Error(`registerTileFormat("${name}"): decode or load is required`);
	const f = { name, pmtilesType, decode: typeof decode === "function" ? decode : null, load: typeof load === "function" ? load : null, loading: null };
	formats.set(name, f);
	if (pmtilesType != null) byPmtiles.set(pmtilesType, name);
	warned.delete(name);
	return f;
}
export const hasTileFormat = name => formats.has(name);
export const tileFormatNames = () => [...formats.keys()];
export const tileFormatOfPmtilesType = code => byPmtiles.get(code) ?? null;
// 解読器が手元にあるか（遅延読み込みが済んでいるか）。同期の呼び手が確かめる口
export const tileFormatReady = name => !!formats.get(name)?.decode;

const warnOnce = name => {
	if (warned.has(name)) return;
	warned.add(name);
	console.warn(`[tiles] tile format "${name}" is not registered — tiles in this encoding are drawn empty (registered: ${tileFormatNames().join(", ") || "none"}). MLT: alias "#tile-formats" to "@ortho-earth/tile-formats/register"`);
};

// 遅延読み込みを済ませて登録簿の項を返す。未登録＝null（一度だけ警告）。読み込み失敗＝投げる（項は残す＝次の呼び出しで再試行）
export async function loadTileFormat(name = "mvt") {
	const f = formats.get(name);
	if (!f) { warnOnce(name); return null; }
	if (f.decode) return f;
	if (!f.loading) f.loading = Promise.resolve(f.load()).then(d => {
		const decode = typeof d === "function" ? d : d?.decode ?? d?.default;
		if (typeof decode !== "function") throw new Error(`tile format "${name}": load() did not return a decode function`);
		f.decode = decode;
		return f;
	}).catch(err => { f.loading = null; throw err; });
	return f.loading;
}

// 同期の解読：7 か所の呼び出し元はこれだけを呼ぶ。未登録の形式＝空（層なし）＋一度だけ警告。
// 登録済みだが未読み込み＝呼び手の順序の誤り（loadTileFormat を先に）＝投げる。
export function decodeTile(bytes, need, encoding = "mvt") {
	const f = formats.get(encoding);
	if (!f) { warnOnce(encoding); return {}; }
	if (!f.decode) throw new Error(`tile format "${encoding}" is not loaded yet — await loadTileFormat("${encoding}") first`);
	return f.decode(bytes, need);
}
