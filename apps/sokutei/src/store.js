// 記録の保存（IndexedDB）と設定（localStorage）と CSV 書き出し。端末の中だけで完結＝サーバー無し・網なしで動く。
// 記録 1 件＝{ id, at, species, sex, age, length, girth, estWeight, estMethod, actWeight, lat, lon, note, refMode, refSize, points, thumb }
//   at＝ISO 日時、length/girth/estWeight/actWeight＝cm/kg（無ければ null）、thumb＝縮小した JPEG の data URL（記録の見返し用・画素座標 points は元画像の寸法 imgW×imgH で持つ）
// CSV 列は捕獲データ（csv/列の説明.csv）の語に寄せる＝後で地図アプリ（choju）に流せる形。

const DB = "sokutei", STORE = "records", SETTINGS = "sokutei:settings";

function openDB() {
	return new Promise((ok, ng) => {
		const req = indexedDB.open(DB, 1);
		req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" }).createIndex("at", "at"); };
		req.onsuccess = () => ok(req.result); req.onerror = () => ng(req.error);
	});
}
const tx = (db, mode, f) => new Promise((ok, ng) => { const t = db.transaction(STORE, mode), r = f(t.objectStore(STORE)); t.oncomplete = () => ok(r?.result ?? r); t.onerror = () => ng(t.error); });

export async function listRecords() {
	const db = await openDB();
	const all = await new Promise((ok, ng) => { const r = db.transaction(STORE).objectStore(STORE).getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => ng(r.error); });
	return all.sort((a, b) => (a.at < b.at ? 1 : -1));
}
export async function putRecord(rec) { const db = await openDB(); await tx(db, "readwrite", s => s.put(rec)); return rec; }
export async function deleteRecord(id) { const db = await openDB(); await tx(db, "readwrite", s => s.delete(id)); }
export async function getRecord(id) { const db = await openDB(); return new Promise((ok, ng) => { const r = db.transaction(STORE).objectStore(STORE).get(id); r.onsuccess = () => ok(r.result); r.onerror = () => ng(r.error); }); }

export const newId = () => new Date().toISOString().replace(/\D/g, "").slice(0, 14) + Math.random().toString(36).slice(2, 6);

/** 設定＝{ coef: { boar:{k,c}, deer:{k,c} }, ref:{id,w,h}, line:{len} }。壊れていれば空。 */
export function loadSettings(storage = globalThis.localStorage) {
	try { return JSON.parse(storage?.getItem(SETTINGS) || "{}") || {}; } catch { return {}; }
}
export function saveSettings(s, storage = globalThis.localStorage) { storage?.setItem(SETTINGS, JSON.stringify(s)); }

const SEX = { "": "", m: "オス", f: "メス" }, AGE = { "": "", adult: "成獣", young: "幼獣" };
const COLS = ["日時", "獣種", "性別", "成幼", "体長cm", "胸囲cm", "推定体重kg", "推定の方法", "実測体重kg", "緯度", "経度", "基準物", "メモ", "id"];
const q = v => { const s = v == null ? "" : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

/** 記録 → CSV（BOM 付き・Excel でそのまま開ける）。speciesName＝id → 表示名。 */
export function toCSV(records, speciesName = x => x) {
	const rows = records.map(r => [r.at?.replace("T", " ").slice(0, 19), speciesName(r.species), SEX[r.sex] ?? r.sex, AGE[r.age] ?? r.age,
		r.length, r.girth, r.estWeight, r.estMethod === "girth" ? "体長＋胸囲" : r.estMethod === "length" ? "体長" : "", r.actWeight, r.lat, r.lon,
		r.refMode === "a4" ? `${r.refSize?.w}×${r.refSize?.h}mm` : r.refMode === "line" ? `${r.refSize?.len}mm の 2 点` : "", r.note, r.id]);
	return "﻿" + [COLS, ...rows].map(r => r.map(q).join(",")).join("\r\n") + "\r\n";
}
