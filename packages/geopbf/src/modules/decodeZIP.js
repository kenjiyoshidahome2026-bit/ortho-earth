// 橋渡し（TS 化 段 3・batch E・2026-10-16）＝本体は ./decodeZIP.ts。src/cog／src/convert／bin/geopbf.mjs（batch F）がまだ "../modules/decodeZIP.js" で import するので、
// Node（.js → .ts を引かない）でも動くように同名の .js を残す。cog／convert／bin の指定子が .ts になったらこのファイルを消す（整合役）
export * from "./decodeZIP.ts";
