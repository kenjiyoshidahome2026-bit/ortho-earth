// 表示の整形（時刻・方位・長さ）。言語＝i18n の今の言語・時間帯＝表示の帯（現在地の帯ではなく端末の帯＝Date のローカル）
import { tr } from "@ortho-earth/globe/i18n.js";
const t = tr();
const fmts = {};
export function fmtTime(ms, lang, tz, seconds = false) {
	if (ms == null) return "—";
	const k = `${lang}|${tz}|${seconds}`;
	fmts[k] ??= new Intl.DateTimeFormat(lang === "ja" ? "ja-JP" : lang, { timeZone: tz, hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hourCycle: "h23" });
	return fmts[k].format(new Date(ms));
}
export function fmtDuration(ms) {
	if (ms == null) return "—";
	const m = Math.round(ms / 6e4), h = Math.floor(m / 60);
	return t("$1 h $2 min", h, String(m % 60).padStart(2, "0"));
}
export const fmtDeg = (x, digits = 0) => x == null ? "—" : `${x.toFixed(digits)}°`;
export const fmtCoord = (lat, lon) => `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? "E" : "W"}`;
// 時刻の差（分）を「+3 min」の形に
export const fmtDiffMin = ms => { const m = Math.round(ms / 6e4); return (m > 0 ? "+" : "") + t("$1 min", m); };
// 月齢（正午）
export const fmtAge = age => age == null ? "—" : age.toFixed(1);
export const pct = x => x == null ? "—" : `${Math.round(x * 100)}%`;
export const PHASE_KEYS = ["New moon", "First quarter", "Full moon", "Last quarter"];
