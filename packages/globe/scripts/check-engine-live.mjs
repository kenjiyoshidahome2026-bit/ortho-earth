#!/usr/bin/env node
// 共有エンジンを使うアプリの deploy の門（エンジン配布の恒久対策 B・2026-10-14）：wrangler deploy の直前に、このアプリが焼き込んだ
// エンジンの版（apps/engine/dist/site/globe/engine/current.json＝アプリの build が毎回焼き直す）が本番にもう在るかを見る。
// 無い＝エンジン（apps/engine）をまだ配っていない＝このまま出すとアプリは本番に無い版を指す（Worker が今の版へ 302 するので動きはするが、
// アプリと食い違うエンジンで走る）。順番を取り違えないよう、ここで止めて「先にエンジン」と言う。
//   node ../../packages/globe/scripts/check-engine-live.mjs   （各アプリの deploy から）
import { engineVersion } from "./lib/shared-engine.mjs";

const ORIGIN = process.env.ENGINE_ORIGIN || "https://www.ortho-earth.com";
const v = engineVersion(), url = `${ORIGIN}/globe/engine/${v}/globe.js`;
const res = await fetch(url, { method: "HEAD", redirect: "manual", cache: "no-store" }).catch(e => ({ status: 0, err: e }));
if (res.status === 200) { console.log(`ok:engine ${v} は本番に在る`); process.exit(0); }
console.error(res.status === 0
	? `✗ 本番のエンジンを確かめられない（${url}: ${res.err?.message || res.err}）＝deploy しない`
	: `✗ このアプリはエンジン ${v} を指すが、本番にまだ無い（${res.status}）＝先にエンジンを配る：repo 直下で npm run deploy:engine（エンジン → それを使う全アプリ）`);
process.exit(1);
