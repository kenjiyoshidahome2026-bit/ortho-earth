#!/usr/bin/env node
// choju.ts の常設検定（Node だけ・外部網なし）＝CSV の読み（BOM・引用・引用内の改行）と、行 → 地図の点の変換（読めない行は落とす）。
import { parseCSV, toRecords, GROUPS, groupOf } from "../choju.ts";
let ok = 0, ng = 0;
const t = (name, cond, extra = "") => { if (cond) { ok++; console.log("✓ " + name); } else { ng++; console.error("✗ " + name + (extra ? "  " + extra : "")); } };

const caps = parseCSV("﻿hkk_tm,市区町村コード,緯度,経度,座標の出所,獣種,利用区分,estimate_length,estimate_weight,receipt_no,hkk_user_id\r\n" +
	"2025-01-01 08:22:05,10444,36.6991461,139.0949676,捕獲地点,シカ,不明（処分方法が未記入）,125.2,44.37,202501010001,10444a18\r\n" +
	"2026-07-03 01:14:26,46208,32.1,130.3,送信位置,イノシシ,\"廃棄（埋設・焼却）\",,,202607030001,46208a20\r\n" +
	"2026-07-03 01:14:26,46208,,,捕獲地点,イノシシ,廃棄（埋設・焼却）,,,202607030002,46208a20\r\n" +
	"2026-07-04 09:00:00,46208,32.1,130.3,捕獲地点,ゾウ,廃棄（埋設・焼却）,,,202607040001,46208a20\n");
const munis = parseCSV("市区町村コード,都道府県,市区町村名\n10444,群馬県,群馬県利根郡川場村\n46208,鹿児島県,\"鹿児島県出水市\"\n");
t("CSV：BOM を落として見出しを読む", caps.length === 4 && "hkk_tm" in caps[0], JSON.stringify(Object.keys(caps[0] || {})));
t("CSV：引用の値", caps[1]["利用区分"] === "廃棄（埋設・焼却）" && munis[1]["市区町村名"] === "鹿児島県出水市");
t("CSV：引用内の改行と \"\" を保つ", parseCSV('a,b\n"x\ny","say ""hi"""\n')[0].b === 'say "hi"' && parseCSV('a,b\n"x\ny",1\n')[0].a === "x\ny");
const recs = toRecords(caps, munis);
t("変換：座標の無い行・未知の獣種は落とす", recs.length === 2, String(recs.length));
t("変換：獣種・利用区分・日付・市区町村", recs[0].s === 1 && recs[0].k === 4 && recs[0].d === 20250101 && recs[0].tm === "2025/01/01 08:22" && recs[0].muni === "群馬県利根郡川場村");
t("変換：座標の出所と体長・体重（空は null）", recs[0].o === 0 && recs[0].len === 125.2 && recs[1].o === 1 && recs[1].len === null && recs[1].wt === null);
t("変換：受付番号・捕獲者 ID", recs[0].rno === "202501010001" && recs[0].uid === "10444a18");
t("変換：通し番号は詰めて振る", recs.map(d => d.i).join() === "0,1");
t("大分類：利用区分 5 つは 2 つの大分類のどれか 1 つに入る", GROUPS.length === 2 && [0, 1, 2, 3, 4].every(k => GROUPS.filter(g => g.ks.includes(k)).length === 1));
t("大分類：ジビエ＝施設搬入・食肉利用・ジビエ用アプリ／捕獲＝廃棄・不明", groupOf(0) === 0 && groupOf(1) === 0 && groupOf(3) === 0 && groupOf(2) === 1 && groupOf(4) === 1);
console.log(`\n${ng ? "✗" : "✓"} choju: ${ok} ok, ${ng} ng`);
process.exit(ng ? 1 : 0);
