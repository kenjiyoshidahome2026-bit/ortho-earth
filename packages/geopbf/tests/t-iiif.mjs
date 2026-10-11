#!/usr/bin/env node
// t-iiif: src/georef/iiif.js（IIIF Image API v2/v3 の info.json → 段・タイル URL）の検定（改良点 17・2026-10-12）。外部通信なし。
import { iiifImage, infoUrl } from "../src/georef/iiif.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };

// v3・タイル申告あり
{
	const im = iiifImage({ "@context": "http://iiif.io/api/image/3/context.json", id: "https://x/iiif/img1/", type: "ImageService3", protocol: "http://iiif.io/api/image", profile: "level1", width: 5000, height: 3000, tiles: [{ width: 512, height: 512, scaleFactors: [8, 1, 2, 4] }], preferredFormats: ["webp", "tif"] });
	ok(im.version === 3 && im.id === "https://x/iiif/img1" && im.width === 5000 && im.height === 3000, "v3: id の末尾 / を落とす・寸法");
	ok(im.format === "webp", "v3: preferredFormats の先頭（web で解ける物）");
	ok(im.levels.map(l => l.scale).join() === "1,2,4,8" && im.levels[0].cols === 10 && im.levels[0].rows === 6 && im.levels[3].cols === 2 && im.levels[3].rows === 1 && im.levels.every(l => l.tiled), "段は scaleFactor 昇順・列数 = ceil(W / (tw·s))");
	const t = im.tile(im.levels[1], 4, 2);
	ok(t.x === 4096 && t.y === 2048 && t.w === 904 && t.h === 952 && t.sw === 452 && t.sh === 476 && t.url === "https://x/iiif/img1/4096,2048,904,952/452,476/0/default.webp", `右下の端のタイル（region と size を切り詰め）: ${t.url}`);
	ok(im.tile(im.levels[0], 0, 0).url === "https://x/iiif/img1/0,0,512,512/512,512/0/default.webp", "v3 の size は w,h");
	ok(im.levelFor(0.5) === im.levels[0] && im.levelFor(1) === im.levels[0] && im.levelFor(3.9) === im.levels[1] && im.levelFor(4) === im.levels[2] && im.levelFor(100) === im.levels[3], "levelFor: 足跡を下回らない一番粗い段");
	ok(JSON.stringify(im.tilesIn(im.levels[1], [1000, 1000, 1100, 1100])) === "[[0,0],[1,0],[0,1],[1,1]]", "tilesIn: 境界をまたぐ範囲は 4 枚");
	ok(im.tilesIn(im.levels[0], [-10, -10, 1, 1]).length === 1 && im.tilesIn(im.levels[3], [0, 0, 1e9, 1e9]).length === 2, "tilesIn: 外側は切り詰め・全体は段の枚数");
}
// v2・profile の formats・@id・sizes のみ
{
	const im = iiifImage({ "@context": "http://iiif.io/api/image/2/context.json", "@id": "https://x/iiif/img2", protocol: "http://iiif.io/api/image", profile: ["http://iiif.io/api/image/2/level0.json", { formats: ["png", "tif"] }], width: 1200, height: 800, sizes: [{ width: 150, height: 100 }, { width: 600, height: 400 }, { width: 1200, height: 800 }] });
	ok(im.version === 2 && im.format === "png", "v2: level0・formats に jpg が無ければ png");
	ok(im.levels.length === 3 && im.levels.map(l => l.scale).join() === "1,2,8" && im.levels.every(l => !l.tiled && l.cols === 1), "sizes だけ＝段ごとに 1 枚");
	const t = im.tile(im.levels[2], 0, 0);
	ok(t.x === 0 && t.w === 1200 && t.sw === 150 && t.url === "https://x/iiif/img2/full/150,/0/default.png", `v2 の size は "w,"・full: ${t.url}`);
	ok(im.tilesIn(im.levels[0], [100, 100, 200, 200]).length === 1 && im.tilesIn(im.levels[0], [2000, 0, 2100, 10]).length === 0, "1 枚の段の tilesIn");
}
// level1/2 でタイル申告なし＝512 の仮想タイル・2 の冪
{
	const im = iiifImage({ "@context": "http://iiif.io/api/image/2/context.json", "@id": "https://x/iiif/img3", profile: ["http://iiif.io/api/image/2/level2.json"], width: 3000, height: 1000 });
	ok(im.format === "jpg" && im.levels.map(l => l.scale).join() === "1,2,4,8" && im.levels[0].tw === 512 && im.levels[3].cols === 1 && im.levels[3].rows === 1, "level2: 512 の仮想タイル・1 枚に収まるまで 2 の冪（1,2,4,8）");
}
// 相対 id と base・infoUrl・不正
{
	const im = iiifImage({ "@context": "http://iiif.io/api/image/3/context.json", id: "tiles/abc", width: 10, height: 10, profile: "level0" }, { base: "https://host/static/map1/info.json" });
	ok(im.id === "https://host/static/map1/tiles/abc", "相対の id は info.json の URL で解く");
	ok(infoUrl("https://x/iiif/img/") === "https://x/iiif/img/info.json" && infoUrl("https://x/iiif/img/info.json") === "https://x/iiif/img/info.json", "infoUrl: 末尾 / と info.json の有無を吸収");
	let msg = ""; try { iiifImage({ id: "https://x/a", width: 0, height: 10 }); } catch (e) { msg = e.message; }
	ok(/lacks id\/width\/height/.test(msg), "幅 0 は例外");
	const a = iiifImage({ id: "https://x/a", width: 10, height: 10, attribution: { en: ["Museum"] } });
	ok(/Museum/.test(a.attribution), "attribution は文字列化");
}
if (fails) { console.error(`${fails} 件失敗`); process.exit(1); }
console.log("全件通過");
