// PLATEAU の建物名を、地理院タイルの施設名注記(Anno)と突合する（第2段：マージ）。
//   node scripts/plateau-names-merge.mjs                … 焼き済み地区を順に突合（中断・再開可）
//   node scripts/plateau-names-merge.mjs --only 千代田区
//   node scripts/plateau-names-merge.mjs --emit         … public/plateau-names.json を書き出す
// 入力: plateau-names-out/<地区>.json（plateau-names-build.mjs の出力）
// 出力: plateau-names-out/merged/<地区>.json ＋ --emit で公開用の1枚
//
// なぜ要るか（千代田区で全数実測）：PLATEAU の gml:name 176棟のうち **144件(82%)はタイル注記の再掲**
// （交番・郵便局・小学校・消防署…が距離0〜30mで文字列まで一致）。素直に両方描くと二重になる。
// 残る18%が「オフィスビル名」＝タイルには無い（JPタワー・大手町プレイス・東京ミッドタウン日比谷…）。
// しかもタイル側は同じ場所に**テナント企業名(888)**を持つことが多い（大手町プレイス⇔日本電信電話）＝
// 突合しておくと「建物名（企業名）」という一段良い注記が作れる。
//
// 判定は3段（d）。2=正規化して完全一致（＝確実な二重）／1=包含一致（要確認。「霞が関ビル」⊂「霞が関ビル内郵便局」の
// ような取り違えが混ざる）／0=タイルに無い＝PLATEAU が名札を出す担当。表示側は d のしきい値で裁ける。
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { decodeMVT } from "../../../packages/ortho-core/src/decode.js";

const OUTDIR = fileURLToPath(new URL("../plateau-names-out/", import.meta.url));
const MERGEDIR = path.join(OUTDIR, "merged");
const PUBLIC = fileURLToPath(new URL("../public/plateau-names.json", import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i < 0 ? d : argv[i + 1]; };
const ONLY = (arg("--only", "") || "").split(",").filter(Boolean);
const CONC = +arg("--conc", 12) || 12;
const EMIT = argv.includes("--emit");
const EMIT_LM = argv.includes("--emit-landmarks");
const LM_H = +arg("--h", 60) || 60;   // 名札に出す高さの下限(m)。実測(101地区・10476棟)＝60m以上は108棟(1.0%)・17地区にしか無い
const Z = 16;                 // optbv の注記(Anno)は z16 タイルが本場。施設名(88x帯)もここにしか無い
const MATCH_M = 150;          // 突合半径。実測の被りは0〜30mだが、駅・大学など代表点が離れる型を拾うため広めに取る
const COMPANY = 888;          // 会社名の注記コード（＝テナント企業名。建物名との対で使う）
// 突合してよいのは「施設・建物の名前」だけ。地名/丁目/路線名/道路番号/測量値を混ぜると事故る
// （実測：「丸の内パークビルディング」が丁目注記「丸の内（二）」と包含一致した／「大八十集会所」が地区名「大八十」と一致した）。
// 駅名(422)・橋名(413)は建物名と正しく重なるので残す。
const NOT_A_NAME = new Set([110, 130, 140, 1301, 1302, 1303, 1401, 1402, 1403, 210, 220, 800, 411, 412, 421, 2901, 2902, 2903, 2904, 7101, 7102, 7103, 7201, 7221, 7711]);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const D2R = Math.PI / 180;
const tileOf = (lon, lat) => [Math.floor((lon + 180) / 360 * 2 ** Z),
	Math.floor((1 - Math.log(Math.tan(lat * D2R) + 1 / Math.cos(lat * D2R)) / Math.PI) / 2 * 2 ** Z)];
const lonOfTile = (x, px, ext) => (x + px / ext) / 2 ** Z * 360 - 180;
const latOfTile = (y, py, ext) => { const n = Math.PI - 2 * Math.PI * (y + py / ext) / 2 ** Z; return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };
const distM = (a, b) => Math.hypot((a[0] - b[0]) * 111320 * Math.cos(a[1] * D2R), (a[1] - b[1]) * 111320);

// 正規化：括弧内・空白・長音・法人格を落とし、全角英数を半角へ。「◯◯大学」→「◯◯大」「◯◯ビルディング」→「◯◯ビル」
// （タイル側は略記＝「上智大」「二松學舍大」で入っている）。千代田の144件はこの規則で漏れなく当たった。
// 設置主体の冠（町立・県立・私立…）は片方にしか付かないことが多い（PLATEAU「伊野中学校」対 タイル「町立伊野中学校」）
// ＝落としてから比べると素直に完全一致になる。「(社)」等の法人格も同様。
const norm = s => String(s)
	.replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
	.replace(/[（(][^）)]*[）)]/g, "")
	.replace(/[\s　]/g, "")
	.replace(/株式会社|有限会社|一般社団法人|公益財団法人|独立行政法人|社会福祉法人|学校法人|医療法人/g, "")
	.replace(/^(都立|道立|府立|県立|市立|区立|町立|村立|国立|公立|私立|組合立)/, "")
	.replace(/[ー－\-‐‑–—]/g, "")
	.replace(/大学$/, "大")
	.replace(/ビルディング$/, "ビル");

async function fetchTile(x, y, tries = 3) {
	const url = `https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/${Z}/${x}/${y}.pbf`;
	for (let i = 0; ; i++) {
		try {
			const ac = new AbortController();
			const t = setTimeout(() => ac.abort(), 25000);
			const r = await fetch(url, { signal: ac.signal });
			clearTimeout(t);
			if (r.status === 404 || r.status === 204) return [];   // 図郭外＝注記なし
			if (!r.ok) throw new Error("HTTP " + r.status);
			const A = decodeMVT(new Uint8Array(await r.arrayBuffer()))["Anno"];
			if (!A) return [];
			const out = [];
			for (const f of A.features) {
				const text = (f.props.vt_text || "").trim();
				if (!text) continue;   // 記号のみの注記（郵便局3211・小学校6321…）は名前を持たない＝突合対象外
				const code = f.props.vt_code;
				out.push({ code, text, name: !NOT_A_NAME.has(code) && !/^\d+(\.\d+)?$/.test(text),
					ll: [lonOfTile(x, f.geom.coords[0], A.extent), latOfTile(y, f.geom.coords[1], A.extent)] });
			}
			return out;
		} catch (e) { if (i >= tries - 1) { throw e; } await sleep(400 * (i + 1)); }
	}
}

// 建物の位置から必要な z16 タイルを割り出す。突合半径(150m)ぶんタイル境界に近い棟は隣も要る
// （注記の実体が隣タイルに入っていることがある＝GSI は境界付近の注記を両側に入れている）。
function tilesNeeded(rows) {
	const need = new Set();
	for (const r of rows) {
		const [x, y] = tileOf(r.x, r.y);
		const span = 360 / 2 ** Z;                                   // タイルの経度幅（度）
		const mDeg = MATCH_M / (111320 * Math.cos(r.y * D2R));       // 150m の経度換算
		const fx = ((r.x + 180) / 360 * 2 ** Z) % 1, fy = ((1 - Math.log(Math.tan(r.y * D2R) + 1 / Math.cos(r.y * D2R)) / Math.PI) / 2 * 2 ** Z) % 1;
		const edge = mDeg / span;                                    // タイル幅に対する余白の比
		for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
			if (dx < 0 && fx > edge) continue;
			if (dx > 0 && fx < 1 - edge) continue;
			if (dy < 0 && fy > edge) continue;
			if (dy > 0 && fy < 1 - edge) continue;
			need.add((x + dx) + "/" + (y + dy));
		}
	}
	return [...need];
}

async function mergeWard(ward) {
	const rows = ward.named;
	if (!rows.length) return { ...ward, named: [], tiles16: 0, stat: { d2: 0, d1: 0, d0: 0, pair: 0 } };
	const keys = tilesNeeded(rows);
	const anno = [];
	let i = 0;
	await Promise.all(Array.from({ length: Math.min(CONC, keys.length) }, async () => {
		while (i < keys.length) {
			const [x, y] = keys[i++].split("/").map(Number);
			try { anno.push(...await fetchTile(x, y)); } catch { /* 1枚落ちても突合は続ける（d0側へ倒れるだけ） */ }
		}
	}));
	// 正規化名 → 注記（突合は名前引き＝総当たりを避ける）／会社名は位置引き
	const byName = new Map();
	const named = anno.filter(a => a.name);   // 施設・建物の名前だけを突合の相手にする
	for (const a of named) {
		const k = norm(a.text);
		let v = byName.get(k); if (!v) byName.set(k, v = []);
		v.push(a);
	}
	const companies = anno.filter(a => a.code === COMPANY);
	const stat = { d2: 0, d1: 0, d0: 0, pair: 0 };
	const out = rows.map(r => {
		const ll = [r.x, r.y], np = norm(r.n);
		let hit = null, d = 0;
		for (const a of (byName.get(np) || [])) if (distM(ll, a.ll) < MATCH_M) { hit = a; d = 2; break; }   // 完全一致
		if (!hit) {   // 包含一致（片方が他方を含む）＝要確認の段
			for (const a of named) {
				const na = norm(a.text);
				if (na.length < 3 || np.length < 3) continue;         // 短い名前の包含は事故のもと
				if (!(np.includes(na) || na.includes(np))) continue;
				if (distM(ll, a.ll) >= MATCH_M) continue;
				hit = a; d = 1; break;
			}
		}
		const rec = { ...r, d };
		if (hit) { rec.t = hit.text; rec.c = hit.code; }
		if (d === 0) {   // タイルに名前が無い棟＝同じ場所の会社名注記を相方として控える（「建物名（企業名）」用）
			let best = null, bd = MATCH_M;
			for (const a of companies) { const dm = distM(ll, a.ll); if (dm < bd) { bd = dm; best = a; } }
			if (best) { rec.p = best.text; rec.pd = Math.round(bd); stat.pair++; }
		}
		stat["d" + d]++;
		return rec;
	});
	// 同名の棟をまとめる（校舎が4棟ある学校・別棟のある工場＝PLATEAU は棟ごとに同じ名前を持つ。
	// 実測：いの町「高知県立農業大学校」4棟／「(社)高知県肉用子牛価格安定基金」2棟）。
	// 300m以内の同名クラスタは一番高い棟を代表にし、k＝棟数を残す（名札は1つ・データは失わない）。
	const folded = [];
	const groups = new Map();
	for (const r of out) { const k = norm(r.n); let g = groups.get(k); if (!g) groups.set(k, g = []); g.push(r); }
	for (const g of groups.values()) {
		const rest = g.slice();
		while (rest.length) {
			const seed = rest.shift(), cluster = [seed];
			for (let i = rest.length - 1; i >= 0; i--) if (distM([seed.x, seed.y], [rest[i].x, rest[i].y]) < 300) cluster.push(...rest.splice(i, 1));
			const rep = cluster.reduce((a, b) => ((b.h ?? 0) > (a.h ?? 0) ? b : a));
			if (cluster.length > 1) rep.k = cluster.length;
			folded.push(rep);
		}
	}
	folded.sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
	stat.folded = out.length - folded.length;
	return { ...ward, named: folded, tiles16: keys.length, stat };
}

// ---- 実行 -------------------------------------------------------------------
await mkdir(MERGEDIR, { recursive: true });
const baked = (await readdir(OUTDIR)).filter(f => f.endsWith(".json")).map(f => f.slice(0, -5));
const done = new Set((await readdir(MERGEDIR).catch(() => [])).filter(f => f.endsWith(".json")).map(f => f.slice(0, -5)));

if (EMIT_LM) {
	// ランドマーク名札用の小さな台帳（施設チップONの時だけ地図に出す分）。
	// ★2D地図に「全部の建物名」を重ねるのは筋が悪い：PLATEAU整備は336/1741市区町村＝いの町に157個の名札が立ち
	// 隣町はゼロ＝地図が壊れて見える（Kenji指摘 2026-08-05）。高さで足切りすると穴が原理的に見えなくなる
	// ——未整備の町にはそもそも高層が無いため。だから台帳は「高さ LM_H 以上」だけを載せる。
	// d===2（タイル注記に同名がある）は載せない。理由は二重表示だけではなく品質で、PLATEAUの gml:name は
	// 「塔そのもの」ではなく**中に入っている施設の名前**であることがある——実測：区立城東小学校238m・
	// 特別養護老人ホーム「つきしま」187m・中之島郵便局200m・特許庁六本木仮庁舎249.6m（＝六本木ヒルズ森タワー）。
	// これらは軒並み d2（タイルが同じ施設名を持つ）なので、d2を落とすと「テナント名を塔の名札にする」事故ごと消える。
	// ただし 300m級は塔そのものが目印＝テナント名である確率が実質ゼロなので d2 でも通す
	// （実測：250m以上の5棟のうち d2 は東京スカイツリー634.9mだけ。88x帯の施設名注記は z16タイルにしか無く、
	//  z11〜15では地図に名前が一つも出ない＝ここで落とすと最大の目印が遠景で無名になる。z16+は実行時の同名スキップが効く）。
	// もう一つの通し口＝**タイル側の注記が会社名(888)なら、その名前は塔の識別そのもの**。実測でこの分岐は
	// 東海旅客鉄道(本社)245m・ソフトバンク(本社)208m・東京電力HD202m・関西電力(本店)197m・JR東日本(本社)157m…を通し、
	// 区立城東小学校238m[885]・特別養護老人ホーム「つきしま」187m[890]・中之島郵便局200m[887]・
	// 特許庁六本木仮庁舎249m[880]（＝六本木ヒルズ森タワー）を落とす＝欲しいものだけが綺麗に残る。
	// これが無いと台帳は東京の一人勝ちになる（大阪・名古屋の超高層はテナント名＝d2で全滅するため）。
	const LM_KEEP_D2 = 300, LM_KEEP_CORP = 150, CORP_CODE = 888;
	const keepD2 = r => (r.h ?? 0) >= LM_KEEP_D2 || ((r.h ?? 0) >= LM_KEEP_CORP && r.c === CORP_CODE);
	const rows = [];
	for (const name of [...done].sort()) {
		const j = JSON.parse(await readFile(path.join(MERGEDIR, name + ".json"), "utf8"));
		for (const r of j.named) {
			if ((r.h ?? 0) < LM_H || (r.d === 2 && !keepD2(r))) continue;
			rows.push([r.n, r.x, r.y, Math.round(r.h), r.p || ""]);
		}
	}
	rows.sort((a, b) => b[3] - a[3]);   // 高い順＝ズーム段階で先頭から出せる
	const out = fileURLToPath(new URL("../public/plateau-landmarks.json", import.meta.url));
	await writeFile(out, JSON.stringify({ ver: 1, h: LM_H, note: "[名前,経度,緯度,高さm,同居企業名]。高さ降順。タイル注記と同名の棟は除外済み", f: rows }));
	console.log(`書き出し public/plateau-landmarks.json ${((await readFile(out)).length / 1024).toFixed(1)}KB ・ ${rows.length}棟（h>=${LM_H}m・突合済み${done.size}地区から）`);
	console.log(rows.slice(0, 15).map(r => `  ${r[3]}m ${r[0]}${r[4] ? "（" + r[4] + "）" : ""}`).join("\n"));
	process.exit(0);
}
if (EMIT) {
	// 公開用：地区ごとの配列にまとめる（棟の並びは名前順のまま）。表示側は d でしきい値を決める。
	const wards = {};
	const tot = { d2: 0, d1: 0, d0: 0, pair: 0, n: 0 };
	for (const name of [...done].sort()) {
		const j = JSON.parse(await readFile(path.join(MERGEDIR, name + ".json"), "utf8"));
		if (!j.named.length) continue;
		wards[name] = { bbox: j.bbox, f: j.named.map(r => [r.n, r.x, r.y, r.h ?? null, r.d, r.u || "", r.a || "", r.p || ""]) };
		for (const k of ["d2", "d1", "d0", "pair"]) tot[k] += j.stat[k];
		tot.n += j.named.length;
	}
	const body = { ver: 1, z: Z, note: "d:2=タイル注記と同名 1=包含一致(要確認) 0=PLATEAU固有。f=[名前,経度,緯度,高さm,d,用途,住所,同居企業名]", wards };
	await writeFile(PUBLIC, JSON.stringify(body));
	const bytes = (await readFile(PUBLIC)).length;
	console.log(`書き出し public/plateau-names.json ${(bytes / 1e6).toFixed(2)}MB ・ ${Object.keys(wards).length}地区 ${tot.n}棟`);
	console.log(`  内訳 完全一致(d2) ${tot.d2} / 包含(d1) ${tot.d1} / PLATEAU固有(d0) ${tot.d0}（うち同居企業名あり ${tot.pair}）`);
	process.exit(0);
}

const targets = baked.filter(n => (!ONLY.length || ONLY.includes(n)) && !done.has(n));
console.log(`対象 ${targets.length} 地区（突合済み ${done.size} / 焼き済み ${baked.length}）`);
let k = 0;
for (const name of targets) {
	k++;
	const ward = JSON.parse(await readFile(path.join(OUTDIR, name + ".json"), "utf8"));
	try {
		const m = await mergeWard(ward);
		await writeFile(path.join(MERGEDIR, name + ".json"), JSON.stringify(m));
		console.log(`[${k}/${targets.length}] ${name.padEnd(10)} 名前付き${String(ward.named.length).padStart(4)}棟 ` +
			`タイル${String(m.tiles16).padStart(5)}枚 → 同名${String(m.stat.d2).padStart(4)} 包含${String(m.stat.d1).padStart(3)} ` +
			`固有${String(m.stat.d0).padStart(4)}（企業名あり${m.stat.pair}）`);
	} catch (e) {
		console.log(`[${k}/${targets.length}] ${name.padEnd(10)} 突合できず（${e.message}）＝次回再挑戦`);
	}
}
console.log("完了。公開ファイルは --emit");
