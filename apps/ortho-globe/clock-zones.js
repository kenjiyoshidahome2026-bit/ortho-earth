// 世界時計（/globe/clock）の芯＝「この点はいま何時か」を決める純な関数（DOM なし・node の試験 tests/t-clock.mjs も同じ物を使う）。
// 点 →（admin0 の国・NE の時間帯の面）→ IANA の名前 → ブラウザの Intl で現在時刻（夏時間の規則は同梱しない＝ブラウザが持つ）。
//
// NE の時間帯（ne_10m_time_zones）は 2012 年の姿で、面は「UTC との差が同じ所」を束ねただけ（夏時間の区切りを持たない）＝そのままだと
// トルコ（2016〜通年 +3）・ベネズエラ（2016〜 −4）・カザフスタン（2024〜全土 +5）・ロシア（2014 の組み替え）で時刻が狂う。
// 国がどこかは admin0 が正しく知っている＝時刻は「国」と「NE の面」の組で決める（issue #309「時刻の決め方」）：
//   1. 時間帯が 1 つの国（その国の名前が今年いっしょに動く＝冬と夏の UTC との差が全部同じ）＝国の名前が勝つ（NE の面が古くても正しい）
//   2. 時間帯が複数ある国＝手直しの表 → NE の面の tz_name1st（その国の名前なら）→ 標準時の差が NE の面と同じ名前 → 一番近い名前
//   3. 海の上（国が無い所）・南極＝NE の面の UTC との差そのまま（夏時間なし）
//   ＋ 海外の領土（admin0 のフランスは仏領ギアナ・レユニオンを含む）・国境の細い切れ端＝手直しの表で（規則で推すと国境の切れ端を外国の時刻にしてしまう）
// 国の中で夏時間が分かれる所（米アリゾナなど）は admin1 が要る＝第一版では見ない（NE の面の代表＝デンバー）。

// 国の名前が zone.tab に無い所・-99 の国（admin0 の ADM0_A3 で引く）
export const COUNTRY_ZONE = {
	KOS: "Europe/Belgrade",    // コソボ（zone.tab に XK が無い）
	SOL: "Africa/Mogadishu",   // ソマリランド
	CYN: "Asia/Famagusta",     // 北キプロス
	CHN: "Asia/Shanghai",      // 中国＝法定は全土 UTC+8（zone.tab の Asia/Urumqi は新疆の通称の時刻＝NE の +6 の切れ端が拾ってしまう）
};
// 手直しの表＝ADM0_A3 → NE の面の zone（UTC との差・時間）→ 今の IANA の名前。段 0 の照合（scripts/clock-audit.mjs）で数えた食い違いのうち、
// 規則（上の 2・海外の領土）で直らない物だけを置く
export const OVERRIDE = {
	// ロシア＝2011〜2014 の「通年夏時間」の区切り（NE は 2012 年）→ 2014 年の組み替えの後の名前
	RUS: { 3: "Europe/Kaliningrad", 4: "Europe/Moscow", 6: "Asia/Yekaterinburg", 7: "Asia/Novosibirsk", 8: "Asia/Krasnoyarsk", 9: "Asia/Irkutsk", 10: "Asia/Yakutsk", 11: "Asia/Vladivostok", 12: "Asia/Kamchatka" },
	// フランスの海外県（admin0 のフランスに含まれる）
	FRA: { [-4]: "America/Martinique", [-3]: "America/Cayenne", 3: "Indian/Mayotte", 4: "Indian/Reunion" },
	// メキシコ＝2022 年に夏時間をやめた。NE の −7 の面の名前（デンバー）は米国＝国内の −7 は夏時間なしのマサトラン（ソノラ・シナロア・南バハ）。
	// zone.tab の順で拾うと国境の Ciudad_Juarez（米国に合わせて夏時間あり）になる
	MEX: { [-7]: "America/Mazatlan" },
	// オランダのカリブ（ボネール・シント・ユースタティウス・サバ）
	NLD: { [-4]: "America/Kralendijk" },
	// オーストラリアのインド洋の領土（クリスマス島・ココス諸島＝ISO は AU）
	IOA: { 7: "Indian/Christmas", 6.5: "Indian/Cocos" },
};

// ── 時刻の道具（Intl だけ）──
const fmtCache = new Map();
const dtf = (key, make) => fmtCache.get(key) ?? (fmtCache.set(key, make()), fmtCache.get(key));
export function isZone(tz) {
	if (!tz || typeof tz !== "string" || tz.endsWith("/")) return false;
	try { dtf("z|" + tz, () => new Intl.DateTimeFormat("en-US", { timeZone: tz })); return true; } catch { return false; }
}
// その時刻のその名前の UTC との差（分）。Intl の各欄を UTC として組み直した時刻との差（longOffset に頼らない＝古いブラウザでも同じ）
export function offsetMin(tz, date) {
	const f = dtf("o|" + tz, () => new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }));
	const p = {}; for (const x of f.formatToParts(date)) p[x.type] = x.value;
	const t = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
	return Math.round((t - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}
// 今年の冬と夏（1 月・7 月の中頃）の差＝[1 月, 7 月]。標準時＝小さい方（夏時間は差を増やす）
const seasons = (tz, year) => [offsetMin(tz, new Date(Date.UTC(year, 0, 15, 12))), offsetMin(tz, new Date(Date.UTC(year, 6, 15, 12)))];
export const standardMin = (tz, year) => Math.min(...seasons(tz, year));
// 名前の振る舞い（今年の冬と夏の差の対）＝同じなら同じ時計
const behaviour = (tz, year) => seasons(tz, year).join("/");

// ── 点 → 名前 ──
// place＝{ a3: admin0 の ADM0_A3, iso2: ISO_A2_EH, zone: NE の面の zone（時間・null＝面の外）, tz: NE の面の tz_name1st }
// 戻り＝{ tz: IANA の名前 | null, fixed: UTC との差（分・tz が null の時）, how: 決め方 }
export function createResolver(table) {
	const byCountry = new Map();   // iso2 → { zones, single }（年ごとに作り直す）
	let year = 0;
	const country = (iso2, y) => {
		if (y !== year) { byCountry.clear(); year = y; }
		if (byCountry.has(iso2)) return byCountry.get(iso2);
		const zones = (table[iso2] ?? []).filter(isZone);
		const v = zones.length ? { zones, single: new Set(zones.map(z => behaviour(z, y))).size === 1 } : null;
		byCountry.set(iso2, v); return v;
	};
	const fixed = (zone, how) => zone == null ? { tz: null, fixed: 0, how: "none" } : { tz: null, fixed: Math.round(zone * 60), how };
	return function resolve({ a3, iso2, zone = null, tz = null } = {}, date = new Date()) {
		const y = date.getUTCFullYear();
		const neTz = isZone(tz) ? tz : null;
		if (a3 && COUNTRY_ZONE[a3]) return { tz: COUNTRY_ZONE[a3], how: "country" };
		if (a3 && zone != null && OVERRIDE[a3]?.[zone]) return { tz: OVERRIDE[a3][zone], how: "override" };
		if (!a3 || a3 === "ATA") return fixed(zone, a3 ? "antarctica" : "sea");
		const c = iso2 && country(iso2, y);
		if (!c) return neTz ? { tz: neTz, how: "ne-name" } : fixed(zone, "ne-offset");
		if (c.single) return { tz: c.zones[0], how: "country" };
		if (neTz && c.zones.includes(neTz)) return { tz: neTz, how: "ne-name" };
		if (zone == null) return { tz: c.zones[0], how: "country" };
		const want = Math.round(zone * 60);
		const same = c.zones.find(z => standardMin(z, y) === want);
		if (same) return { tz: same, how: "offset" };
		let best = c.zones[0], d = Infinity;
		for (const z of c.zones) { const dz = Math.abs(standardMin(z, y) - want); if (dz < d) { d = dz; best = z; } }
		return { tz: best, how: "nearest" };
	};
}

// ── 名前 → 見せる物 ──
// r＝resolve の戻り。lang＝表示言語。戻り＝{ time "14:05", date "Tue, Oct 14", name "Japan Standard Time", offset 分, utc "UTC+9", dst 真偽, key（同じ時計の印） }
const pad2 = n => String(n).padStart(2, "0");
export function utcLabel(min) {
	const s = min < 0 ? "−" : "+", a = Math.abs(min);
	return a === 0 ? "UTC" : `UTC${s}${Math.floor(a / 60)}${a % 60 ? ":" + pad2(a % 60) : ""}`;
}
export function describe(r, date, lang = "en") {
	if (!r) return null;
	let off, name, dst = false, at = date, tz = r.tz;
	if (tz) {
		off = offsetMin(tz, date);
		dst = off > standardMin(tz, date.getUTCFullYear());
		try { name = dtf(`n|${lang}|${tz}`, () => new Intl.DateTimeFormat(lang, { timeZone: tz, timeZoneName: "long" })).formatToParts(date).find(p => p.type === "timeZoneName")?.value; } catch { /* 古い Intl */ }
	} else { off = r.fixed; at = new Date(date.getTime() + off * 60000); tz = "UTC"; }
	const time = dtf(`t|${lang}|${tz}`, () => new Intl.DateTimeFormat(lang, { timeZone: tz, hour: "numeric", minute: "2-digit" })).format(at);
	const day = dtf(`d|${lang}|${tz}`, () => new Intl.DateTimeFormat(lang, { timeZone: tz, weekday: "short", month: "short", day: "numeric" })).format(at);
	const utc = utcLabel(off), key = `${off}|${name || utc}`;   // 同じ時計の印＝Intl の名前のまま（下で都市に替える前）
	if (r.tz && (!name || /^(GMT|UTC)([+−-]|$)/.test(name))) name = cityOf(r.tz);   // 名前の無い時間帯（イスタンブール＝"GMT+03:00"）は都市の名前で（差は utc の欄が出す）
	return { tz: r.tz, time, date: day, name: name || utc, offset: off, utc, dst, key };
}
// 同じ時計に束ねる（Shift の国の一覧）＝今の差と名前が同じ物を 1 行に。並び＝西から東（差の小さい順）
export function groupZones(zones, date, lang) {
	const m = new Map();
	for (const tz of zones) {
		const d = describe({ tz }, date, lang); if (!d) continue;
		const g = m.get(d.key) ?? m.set(d.key, { ...d, zones: [] }).get(d.key);
		g.zones.push(tz);
	}
	return [...m.values()].sort((a, b) => a.offset - b.offset);
}
// IANA の名前の都市（"America/Argentina/Buenos_Aires" → "Buenos Aires"）
export const cityOf = tz => (tz || "").split("/").pop().replace(/_/g, " ");
