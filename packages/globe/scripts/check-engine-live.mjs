#!/usr/bin/env node
// 共有エンジンを使うアプリの deploy の門（エンジン配布の恒久対策 B・2026-10-14）：wrangler deploy の直前に、このアプリが焼き込んだ
// エンジンの版（apps/engine/dist/site/globe/engine/current.json＝アプリの build が毎回焼き直す）が本番にもう在るかを見る。
// 無い＝エンジン（apps/engine）をまだ配っていない＝このまま出すとアプリは本番に無い版を指す（Worker が今の版へ 302 するので動きはするが、
// アプリと食い違うエンジンで走る）。順番を取り違えないよう、ここで止めて「先にエンジン」と言う。
//   node ../../packages/globe/scripts/check-engine-live.mjs   （各アプリの deploy から）
import { engineVersion } from "./lib/shared-engine.mjs";

const ORIGIN = process.env.ENGINE_ORIGIN || "https://www.ortho-earth.com";
const v = engineVersion(), url = `${ORIGIN}/globe/engine/${v}/globe.js`;
// 待つ訳＝deploy:engine はエンジンの wrangler deploy の直後にここへ来る。新しい版の assets が各地の edge に届くまで数十秒は旧版のまま
// （302）＝すぐ 1 回だけ見ると、出したばかりのエンジンを「無い」と誤って止める（2026-10-15 ortho-globe の deploy:built で踏んだ）。
// 302 の間だけ 10 秒おきに 90 秒まで見直す（届かない＝0 は待たない）。
const head = () => fetch(url, { method: "HEAD", redirect: "manual", cache: "no-store" }).catch(e => ({ status: 0, err: e }));
let res = await head();
for (let i = 0; i < 9 && res.status === 302; i++) {
	console.log(`… engine ${v} はまだ本番の全域に届いていない（302）＝10 秒待って見直す（${i + 1}/9）`);
	await new Promise(r => setTimeout(r, 10000));
	res = await head();
}
if (res.status === 200) { console.log(`ok:engine ${v} は本番に在る`); process.exit(0); }
console.error(res.status === 0
	? `✗ 本番のエンジンを確かめられない（${url}: ${res.err?.message || res.err}）＝deploy しない`
	: `✗ このアプリはエンジン ${v} を指すが、本番にまだ無い（${res.status}）＝先にエンジンを配る：repo 直下で npm run deploy:engine（エンジン → それを使う全アプリ）`);
process.exit(1);
