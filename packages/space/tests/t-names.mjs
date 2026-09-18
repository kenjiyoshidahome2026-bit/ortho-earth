#!/usr/bin/env node
// 宇宙の名前データの常設検定：正本（names.json）の網羅と取り違えの疑い・パックの形
import fs from "node:fs";
import { packs, LANGS } from "../build/packs.js";
let fail = 0;
const check = (name, ok, info = "") => { if (!ok) fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? "  " + info : ""}`); };
const names = JSON.parse(fs.readFileSync(new URL("../names.json", import.meta.url), "utf8"));
const IAU = ["And","Ant","Aps","Aqr","Aql","Ara","Ari","Aur","Boo","Cae","Cam","Cnc","CVn","CMa","CMi","Cap","Car","Cas","Cen","Cep","Cet","Cha","Cir","Col","Com","CrA","CrB","Crv","Crt","Cru","Cyg","Del","Dor","Dra","Equ","Eri","For","Gem","Gru","Her","Hor","Hya","Hyi","Ind","Lac","Leo","LMi","Lep","Lib","Lup","Lyn","Lyr","Men","Mic","Mon","Mus","Nor","Oct","Oph","Ori","Pav","Peg","Per","Phe","Pic","Psc","PsA","Pup","Pyx","Ret","Sge","Sgr","Sco","Scl","Sct","Ser","Sex","Tau","Tel","Tri","TrA","Tuc","UMa","UMi","Vel","Vir","Vol","Vul"];
check("88 constellations keyed by IAU abbreviation", IAU.every(a => names.constellations[a]) && Object.keys(names.constellations).length === 88);
check("every constellation has en (IAU name) + ja", IAU.every(a => names.constellations[a].en && names.constellations[a].ja));
check("every Messier entry has en + ja + zh", Object.values(names.messier).every(v => v.en && v.ja && v.zh));
check("Messier keys look like M1..M110", Object.keys(names.messier).every(k => /^M([1-9]\d?|10\d|110)$/.test(k)));
const langs = JSON.parse(fs.readFileSync(new URL("../../world/i18n/langs.json", import.meta.url), "utf8")).map(l => l.code);
check("covers the 26 UI languages (packages/world/i18n/langs.json)", langs.every(l => LANGS.includes(l)) && LANGS.length === langs.length, langs.filter(l => !LANGS.includes(l)).join());
check("no stray language codes in names.json", Object.values(names.constellations).concat(Object.values(names.messier)).every(v => Object.keys(v).every(l => LANGS.includes(l))));
for (const l of LANGS) {   // 同じ言語の中で二つの星座が同じ名前＝取り違えの疑い
	const seen = new Map(), dup = [];
	for (const a of IAU) { const v = names.constellations[a][l]; if (!v) continue; if (seen.has(v)) dup.push(`${seen.get(v)}/${a}=${v}`); seen.set(v, a); }
	if (dup.length) check(`${l}: no duplicate constellation names`, false, dup.join(" "));
}
const P = packs(names);
check("26 packs; en pack is complete", Object.keys(P).length === 26 && Object.keys(P.en.c).length === 88 && Object.keys(P.en.m).length === Object.keys(names.messier).length);
check("packs carry only that language", P.ja.c.Ori === "オリオン座" && P.ja.m.M42 === "オリオン大星雲" && !("M42" in P.ur.m) && P.en.m.M42 === "Orion Nebula");
check("pack size stays small (< 5 KB each)", Object.values(P).every(p => JSON.stringify(p).length < 5000), Math.max(...Object.values(P).map(p => JSON.stringify(p).length)) + " B max");
console.log(fail ? `\nFAIL  ${fail}` : "\nPASS");
process.exit(fail ? 1 : 0);
