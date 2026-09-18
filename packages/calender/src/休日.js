import { dayNumber, yearDay, ymd2day, initAngle, SunDegreeDay } from "./共通関数.js";
// 祝日法（1948/7/20 施行）の変遷を年で切り替える。キー=年通日-1（dayNumber）
const 休日tub = {};
export function 年間休日(year) {
	if (休日tub[year]) return 休日tub[year];
	const 祝日 = {};
	const 日 = (m, d, name) => { 祝日[dayNumber([year, m, d])] = name; };
	const 月曜 = (m, nth, name) => 日(m, 1 + (8 - ymd2day([year, m, 1])) % 7 + (nth - 1) * 7, name);
	const 節日 = r => Math.floor(SunDegreeDay(year, r) - initAngle(year, 9)) - 1;
	if (year < 1948) return (休日tub[year] = {});
	if (year > 1948) {
		日(1, 1, "元日");
		year < 2000 ? 日(1, 15, "成人の日") : 月曜(1, 2, "成人の日");
		祝日[節日(0)] = "春分の日";
		日(4, 29, year < 1989 ? "天皇誕生日" : year < 2007 ? "みどりの日" : "昭和の日");
		日(5, 3, "憲法記念日");
		year >= 2007 && 日(5, 4, "みどりの日");
		日(5, 5, "こどもの日");
	}
	year >= 1967 && 日(2, 11, "建国記念の日");
	year >= 2020 && 日(2, 23, "天皇誕生日");
	1989 <= year && year <= 2018 && 日(12, 23, "天皇誕生日");
	if (year >= 1996) year < 2003 ? 日(7, 20, "海の日") : 月曜(7, 3, "海の日");
	year >= 2016 && 日(8, 11, "山の日");
	if (year >= 1966) year < 2003 ? 日(9, 15, "敬老の日") : 月曜(9, 3, "敬老の日");
	祝日[節日(180)] = "秋分の日";
	if (year >= 1966) year < 2000 ? 日(10, 10, "体育の日") : 月曜(10, 2, year < 2020 ? "体育の日" : "スポーツの日");
	日(11, 3, "文化の日");
	日(11, 23, "勤労感謝の日");
	// 特例法（皇室行事・五輪の移動）
	const 移 = (from, to, name) => { delete 祝日[dayNumber([year, ...from])]; 日(...to, name); };
	({
		1959: () => 日(4, 10, "皇太子明仁親王の結婚の儀"),
		1989: () => 日(2, 24, "昭和天皇の大喪の礼"),
		1990: () => 日(11, 12, "即位礼正殿の儀"),
		1993: () => 日(6, 9, "皇太子徳仁親王の結婚の儀"),
		2019: () => { 日(5, 1, "天皇の即位の日"); 日(10, 22, "即位礼正殿の儀の行われる日"); },
		2020: () => { 移([7, 20], [7, 23], "海の日"); 移([10, 12], [7, 24], "スポーツの日"); 移([8, 11], [8, 10], "山の日"); },
		2021: () => { 移([7, 19], [7, 22], "海の日"); 移([10, 11], [7, 23], "スポーツの日"); 移([8, 11], [8, 8], "山の日"); },
	})[year]?.();
	const 休日 = { ...祝日 };
	const 曜 = n => ymd2day(yearDay(year, n));
	const 日順 = Object.keys(祝日).map(Number).sort((a, b) => a - b);
	// 振替休日（1973/4/12〜）：祝日が日曜 → 翌日（2007〜は祝日でない最初の日）
	for (const n of 日順) {
		if (曜(n) !== 0 || year < 1973 || (year === 1973 && n < dayNumber([1973, 4, 12]))) continue;
		let k = n + 1;
		if (year >= 2007) while (祝日[k]) k++;
		if (!祝日[k]) 休日[k] = "振替休日";
	}
	// 国民の休日（1985/12/27〜）：前日と翌日が祝日の平日（2006 までは日曜・振替休日を除く）
	if (year >= 1986) for (let i = 0; i + 1 < 日順.length; i++) {
		const k = 日順[i] + 1;
		if (日順[i + 1] - 日順[i] !== 2 || 休日[k]) continue;
		if (year >= 2007 || 曜(k) !== 0) 休日[k] = "国民の休日";
	}
	return (休日tub[year] = 休日);
}
export function 月間休日(YM) {
	const v = 年間休日(YM[0]), u = {};
	for (const k in v) {
		const ymd = yearDay(YM[0], +k);
		if (ymd[1] === YM[1]) u[ymd[2]] = v[k];
	}
	return u;
}
