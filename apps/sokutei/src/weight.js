// 体長（＋任意で胸囲）→ 体重（kg）の換算と、実測体重からの係数の再推定。DOM に依らない純関数（tests/t-sokutei.mjs で検定）。
//
// 式は獣種ごとに 2 本：
//   体長だけ      W = k × L³            （相似則＝体の寸法が揃って伸びれば体積∝長さの 3 乗。k は獣種ごとの係数）
//   体長＋胸囲    W = L × G² / c         （家畜の体重推定で広く使われる形。胸囲 G が入ると精度が大きく上がる）
// ★係数は暫定。k は他社アプリの推定値（捕獲データ_全列.csv の estimate_length／estimate_weight、体長 40〜200cm）の
//   W/L³ の中央値から逆算（イノシシ 3.3e-5・シカ 2.3e-5）、c は家畜の経験式（豚 14400）を元にした仮の値。
//   どちらも「実測体重」を記録に入れていけば fitK／fitC で置き換えられる（設定画面の「係数を実測から出し直す」）。
// 性別・成幼で式は変えない（寸法が体重を決める＝L と G に既に表れている）。記録には残し、将来の層別に使う。

export const SPECIES = [
	{ id: "boar", name: "イノシシ", k: 3.3e-5, c: 14400 },
	{ id: "deer", name: "シカ", k: 2.3e-5, c: 15000 },
	{ id: "other", name: "その他", k: null, c: null },   // 体長だけ測る（体重は出さない）
];

export const speciesOf = id => SPECIES.find(s => s.id === id) || SPECIES[2];

/**
 * 体重を推定する。
 * @param {{species:string, length:number|null, girth?:number|null, coef?:{k?:number,c?:number}}} a  length・girth は cm。coef は設定で上書きした係数
 * @returns {{kg:number|null, method:"girth"|"length"|null}}
 */
export function estimateWeight({ species, length, girth, coef }) {
	const sp = speciesOf(species);
	const k = coef?.k ?? sp.k, c = coef?.c ?? sp.c;
	if (!(length > 0)) return { kg: null, method: null };
	if (girth > 0 && c > 0) return { kg: round1(length * girth * girth / c), method: "girth" };
	if (k > 0) return { kg: round1(k * length ** 3), method: "length" };
	return { kg: null, method: null };
}

const round1 = x => Math.round(x * 10) / 10;
const median = xs => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };

/** 実測体重のある記録から k（W/L³ の中央値）を出す。3 件未満なら null（偶然に振られる）。 */
export function fitK(records) {
	const xs = records.filter(r => r.length > 0 && r.actWeight > 0).map(r => r.actWeight / r.length ** 3);
	return xs.length >= 3 ? median(xs) : null;
}

/** 実測体重と胸囲のある記録から c（L·G²/W の中央値）を出す。3 件未満なら null。 */
export function fitC(records) {
	const xs = records.filter(r => r.length > 0 && r.girth > 0 && r.actWeight > 0).map(r => r.length * r.girth ** 2 / r.actWeight);
	return xs.length >= 3 ? median(xs) : null;
}

/** 推定と実測の食い違い（%）の中央値＝今の係数の当たり具合。該当が無ければ null。 */
export function errorStats(records, coefOf) {
	const errs = records.filter(r => r.actWeight > 0 && r.length > 0).map(r => {
		const { kg } = estimateWeight({ species: r.species, length: r.length, girth: r.girth, coef: coefOf?.(r.species) });
		return kg == null ? null : Math.abs(kg - r.actWeight) / r.actWeight * 100;
	}).filter(e => e != null);
	return errs.length ? { n: errs.length, medianPct: Math.round(median(errs)) } : null;
}
