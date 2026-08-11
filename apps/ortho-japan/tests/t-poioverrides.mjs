// §12 手差分（poi/overrides.json）の意味論を検証する Node ハーネス。
//   node tests/t-poioverrides.mjs
// 二枚実装（焼き側 uploader/src/poi/schema.js applyOverrides ＝正典／表示側 app.js applyPoiOvr ＝実行時版）の
// 「同値」を機械検証する＝複製の錆び止め（t-chome と同じく実ソースを切り出す＝写経した複製を試験しない）。
// 検証する意味論：match=名前完全一致∧300m最近傍1件／id昇順fold（rename後は新名でmatch）／
// moveは pos-src を手管理(3)へ・typeSrc維持／add=手管理0x33／焼き込み後の再適用が冪等（bake+runtime二重掛け）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as POI from "../../uploader/src/poi/schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, "../app.js"), "utf8");
const from = src.indexOf("const POI_SRC_MANUAL"), to = src.indexOf("let poiOvr = null");
if (from < 0 || to < 0 || to < from) { console.error("app.js から applyPoiOvr を切り出せない（実装が移動した？）"); process.exit(1); }
const applyPoiOvr = new Function(src.slice(from, to) + "\nreturn applyPoiOvr;")();

// ── 共通フィクスチャ（schema形 {name,ll,type,rank,src} ⇄ 表示形 {n,anchor,r,s}）──────────────
// A-B は同名で約319m（>300m＝別施設として拾わない距離）・C は注記権威（posSrc=1）。
const S = () => [
	{ ll: [135.7000, 35.000], name: "学校A", type: 0x11, rank: 120, src: 0x00, kana: "" },
	{ ll: [135.7035, 35.000], name: "学校A", type: 0x11, rank: 120, src: 0x00, kana: "" },
	{ ll: [135.7100, 35.010], name: "寺X", type: 0x71, rank: 90, src: 0x11, kana: "" },
];
const toDisp = list => list.map(p => ({ anchor: p.ll, n: p.name, r: p.rank, s: p.src }));
const OVR = [
	{ id: 1, op: "move", n: "学校A", ll: [135.7001, 35.0001], to: [135.7003, 35.0004] },   // 最近傍＝A（~13m）・Bは~310m
	{ id: 2, op: "rename", n: "寺X", ll: [135.7100, 35.010], to: "寺Y" },
	{ id: 3, op: "move", n: "寺Y", ll: [135.7100, 35.010], to: [135.7102, 35.0101] },      // fold順＝rename後の名でmatch
	{ id: 4, op: "del", n: "学校A", ll: [135.7035, 35.0000] },                              // 最近傍＝B
	{ id: 5, op: "add", n: "新食堂", ll: [135.7050, 35.002], t: 0x57, r: 77 },
];
// 比較は両形の共通部分（名前・位置・rank・出典バイト）のタプルで
const tup = list => list.map(p => [p.name ?? p.n, (p.ll ?? p.anchor)[0].toFixed(7), (p.ll ?? p.anchor)[1].toFixed(7), p.rank ?? p.r, p.src ?? p.s].join("|")).sort();

let pass = 0, fail = 0;
const eq = (t, a, b) => {
	const ja = JSON.stringify(a), jb = JSON.stringify(b);
	if (ja === jb) { console.log(`  ✔ ${t}`); pass++; } else { console.error(`  ✖ ${t}\n    got  ${ja}\n    want ${jb}`); fail++; }
};

console.log("① 焼き側 applyOverrides（正典）の意味論");
{
	const out = POI.applyOverrides(S(), OVR);
	eq("件数＝3（del1件・add1件）", out.length, 3);
	const a = out.find(p => p.name === "学校A");
	eq("move＝位置がtoへ", a.ll, [135.7003, 35.0004]);
	eq("move＝posSrc手管理(3)・typeSrc維持(0)", a.src, 0x30);
	const c = out.find(p => p.name === "寺Y");
	eq("rename→move の連鎖（fold順）", !!c && c.ll[0] === 135.7102, true);
	eq("moveでANNOのtypeSrc(1)維持", c.src, 0x31);
	eq("del＝同名の最近傍だけ消す", out.filter(p => p.name === "学校A").length, 1);
	const add = out.find(p => p.name === "新食堂");
	eq("add＝手管理0x33・t/r搬送", [add.src, add.type, add.rank], [0x33, 0x57, 77]);
	eq("withAdds:false＝addを焼かない（柵）", POI.applyOverrides(S(), OVR, { withAdds: false }).length, 2);
	const input = S();   // 渡した実体そのものを掴んで検証（新品と比べると構造的に落ちない断言になる）
	POI.applyOverrides(input, OVR);
	eq("元配列は不変（コピー適用）", tup(input), tup(S()));
}

console.log("② 表示側 applyPoiOvr（実行時版）＝正典と同値");
{
	const d = applyPoiOvr(toDisp(S()), OVR, null);
	eq("正典と同じ結果（共通タプル）", tup(d), tup(POI.applyOverrides(S(), OVR)));
	eq("tileLoaded=false圏＝addを出さない", applyPoiOvr(toDisp(S()), OVR, () => false).length, 2);
}

console.log("③ 縁と冪等");
{
	const far = [{ id: 1, op: "move", n: "学校A", ll: [135.7100, 35.000], to: [135.7, 35.1] }];   // 両候補から>300m
	eq("300m外＝no-op", tup(applyPoiOvr(toDisp(S()), far, null)), tup(toDisp(S())));
	// 焼き込みの運用プロトコル（§12.4）：焼きが applied を報告→manifest.baked→表示は未焼き分だけ適用。
	// これが無い素朴な全再適用だと、del#4（Bの墓標）が焼き後のタイルで同名近傍の生存者Aを最近傍matchで誤爆する。
	const applied = [];
	const baked = POI.applyOverrides(S(), OVR, { withAdds: false, applied });
	eq("焼きが効いたrec idを報告（add除く）", applied, [1, 2, 3, 4]);
	const runtime = OVR.filter(r => !applied.includes(r.id));
	eq("焼き＋未焼き分のみ適用＝全適用と同じ絵", tup(applyPoiOvr(toDisp(baked), runtime, null)), tup(applyPoiOvr(toDisp(S()), OVR, null)));
	eq("全再適用だと誤爆する（封じた穴の確認）", applyPoiOvr(toDisp(baked), OVR, null).length < applyPoiOvr(toDisp(S()), OVR, null).length, true);
	// 追加した点をその後 del ＝ fold が畳む
	const addDel = [{ id: 1, op: "add", n: "X", ll: [135.7, 35.0], t: 0x0F, r: 60 }, { id: 2, op: "del", n: "X", ll: [135.7, 35.0] }];
	eq("add→delは消える", applyPoiOvr([], addDel, null).length, 0);
	eq("同 schema側", POI.applyOverrides([], addDel).length, 0);
}

console.log("④ マニフェスト合流（mergeManifest＝形の正典）");
{
	const m1 = POI.mergeManifest(null, ["1/2", "1/3"], [1, 2]);
	const m2 = POI.mergeManifest(m1, new Map([["1/3", 0], ["2/2", 0]]).keys(), [4]);   // 実呼び出しと同じ Map#keys も受ける
	eq("tiles＝既存と合流・重複なし・sort", m2.tiles, ["1/2", "1/3", "2/2"]);
	eq("baked＝既存と合流・昇順", m2.baked, [1, 2, 4]);
	eq("appliedIds省略＝bakedは既存維持", POI.mergeManifest(m1, [], undefined).baked, [1, 2]);
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
