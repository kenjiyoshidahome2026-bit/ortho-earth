// SGP4/SDP4 — 人工衛星の軌道伝播（NORAD の一般摂動モデル）。Vallado ほか "Revisiting Spacetrack Report #3"
// (AIAA 2006-6753) の参照実装 sgp4unit を JS へ素直に移したもの＝CelesTrak が配る軌道要素（GP/OMM・TLE）は
// このモデルで平均化されている＝同じ式で戻さないと要素の意味が合わない（ケプラーで回すと一日で数百 km ずれる）。
//   近地球（周期 < 225 分）＝SGP4：J2〜J4＋大気抵抗(B*)
//   深宇宙（周期 ≥ 225 分）＝SDP4：日月の永年・長周期摂動＋半日(GPS)/一日(静止)共鳴
// 定数は WGS-72（要素がこれで作られている＝WGS-84 に替えると逆に狂う）。opsmode は 'i'（改良版＝現行の既定）。
// 出力は TEME 座標系（真赤道・平均春分点）の km・km/s。地上位置へは GMST で回す（teme → 経緯度は下の temeToGeodetic）。
// 公開面：parseOMM（CelesTrak JSON 1 行→要素）・parseTLE（2 行→要素）・sgp4init（要素→衛星）・propagate（衛星,日時→r,v）
//         ・gmst・temeToGeodetic。依存ゼロ・DOM なし＝worker でもそのまま動く。
const PI = Math.PI, TWOPI = 2 * PI, D2R = PI / 180, X2O3 = 2 / 3;
const MU = 398600.8, RE = 6378.135;                 // WGS-72
const XKE = 60 / Math.sqrt(RE * RE * RE / MU);
const J2 = 0.001082616, J3 = -0.00000253881, J4 = -0.00000165597, J3OJ2 = J3 / J2;
const VKMPERSEC = RE * XKE / 60;
const mod2pi = x => x % TWOPI;   // C の fmod と同じ（符号は被除数に従う）＝参照実装に合わせる

export const EARTH_RADIUS_KM = RE;

// ユリウス日 ⇔ Date
export const jdOf = date => (date instanceof Date ? date.getTime() : date) / 86400000 + 2440587.5;

// グリニッジ平均恒星時（rad）。IAU-82。参照実装 gstime と同式。
export function gmst(jdut1) {
	const t = (jdut1 - 2451545.0) / 36525;
	let g = -6.2e-6 * t * t * t + 0.093104 * t * t + (876600.0 * 3600 + 8640184.812866) * t + 67310.54841;   // 秒
	g = (g * D2R / 240) % TWOPI;
	return g < 0 ? g + TWOPI : g;
}

// "2026-09-18T15:48:46.939968"（CelesTrak の EPOCH＝UTC・Z なし・マイクロ秒）→ ユリウス日。
// Date.parse に渡すと Z 無しは「地方時」と解釈される＝日本時間だと 9 時間ずれる。自前で割る。
function jdOfIso(s) {
	const m = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d(?:\.\d+)?)/.exec(s);
	if (!m) throw new Error(`sgp4: bad EPOCH "${s}"`);
	return Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) / 86400000 + 2440587.5 + (+m[6]) / 86400;
}

// CelesTrak の OMM(JSON) 一件 → 要素（角度は rad・平均運動は rad/分）
export function parseOMM(o) {
	return {
		name: o.OBJECT_NAME, id: o.OBJECT_ID, norad: o.NORAD_CAT_ID,
		jdEpoch: jdOfIso(o.EPOCH),
		no: o.MEAN_MOTION * TWOPI / 1440,
		ecco: +o.ECCENTRICITY, inclo: o.INCLINATION * D2R, nodeo: o.RA_OF_ASC_NODE * D2R,
		argpo: o.ARG_OF_PERICENTER * D2R, mo: o.MEAN_ANOMALY * D2R, bstar: +o.BSTAR,
	};
}

// TLE 2 行 → 要素（名前行は呼び手が持つ）
export function parseTLE(l1, l2, name = "") {
	const f = (s, a, b) => s.slice(a, b).trim();
	const expo = s => { s = s.trim(); const m = /^([+-]?)(\d+)([+-]\d)$/.exec(s); return m ? +(`${m[1]}0.${m[2]}e${m[3]}`) : 0; };   // " 12345-4" ＝ 0.12345e-4
	const yy = +f(l1, 18, 20), doy = +f(l1, 20, 32), year = yy < 57 ? 2000 + yy : 1900 + yy;
	return {
		name, id: f(l1, 9, 17), norad: +f(l1, 2, 7),
		jdEpoch: Date.UTC(year, 0, 1) / 86400000 + 2440587.5 + doy - 1,
		no: +f(l2, 52, 63) * TWOPI / 1440,
		ecco: +("0." + f(l2, 26, 33)), inclo: +f(l2, 8, 16) * D2R, nodeo: +f(l2, 17, 25) * D2R,
		argpo: +f(l2, 34, 42) * D2R, mo: +f(l2, 43, 51) * D2R, bstar: expo(l1.slice(53, 61)),
	};
}

// ---- 深宇宙の下請け（参照実装 dpper / dscom / dsinit / dspace） ----

// 日月の長周期周期項。init=true は元期の値を覚えるだけ（参照実装も適用しない）。
function dpper(s, t, init, ep, inclp, nodep, argpp, mp) {
	const ZNS = 1.19459e-5, ZES = 0.01675, ZNL = 1.5835218e-4, ZEL = 0.05490;
	let zm = init ? s.zmos : s.zmos + ZNS * t;
	let zf = zm + 2 * ZES * Math.sin(zm), sinzf = Math.sin(zf);
	let f2 = 0.5 * sinzf * sinzf - 0.25, f3 = -0.5 * sinzf * Math.cos(zf);
	const ses = s.se2 * f2 + s.se3 * f3, sis = s.si2 * f2 + s.si3 * f3;
	const sls = s.sl2 * f2 + s.sl3 * f3 + s.sl4 * sinzf;
	const sghs = s.sgh2 * f2 + s.sgh3 * f3 + s.sgh4 * sinzf, shs = s.sh2 * f2 + s.sh3 * f3;
	zm = init ? s.zmol : s.zmol + ZNL * t;
	zf = zm + 2 * ZEL * Math.sin(zm); sinzf = Math.sin(zf);
	f2 = 0.5 * sinzf * sinzf - 0.25; f3 = -0.5 * sinzf * Math.cos(zf);
	const sel = s.ee2 * f2 + s.e3 * f3, sil = s.xi2 * f2 + s.xi3 * f3;
	const sll = s.xl2 * f2 + s.xl3 * f3 + s.xl4 * sinzf;
	const sghl = s.xgh2 * f2 + s.xgh3 * f3 + s.xgh4 * sinzf, shll = s.xh2 * f2 + s.xh3 * f3;
	let pe = ses + sel, pinc = sis + sil, pl = sls + sll, pgh = sghs + sghl, ph = shs + shll;
	if (init) return { ep, inclp, nodep, argpp, mp };
	pe -= s.peo; pinc -= s.pinco; pl -= s.plo; pgh -= s.pgho; ph -= s.pho;
	inclp += pinc; ep += pe;
	const sinip = Math.sin(inclp), cosip = Math.cos(inclp);
	if (inclp >= 0.2) {
		ph /= sinip; pgh -= cosip * ph;
		argpp += pgh; nodep += ph; mp += pl;
	} else {   // 低傾斜＝Lyddane 修正（昇交点が定まらない所の特異点除け）
		const sinop = Math.sin(nodep), cosop = Math.cos(nodep);
		let alfdp = sinip * sinop, betdp = sinip * cosop;
		alfdp += ph * cosop + pinc * cosip * sinop;
		betdp += -ph * sinop + pinc * cosip * cosop;
		nodep = mod2pi(nodep);
		let xls = mp + argpp + cosip * nodep;
		xls += pl + pgh - pinc * nodep * sinip;
		const xnoh = nodep;
		nodep = Math.atan2(alfdp, betdp);
		if (Math.abs(xnoh - nodep) > PI) nodep += nodep < xnoh ? TWOPI : -TWOPI;
		mp += pl;
		argpp = xls - mp - cosip * nodep;
	}
	return { ep, inclp, nodep, argpp, mp };
}

// 日月摂動の係数（元期で一度）
function dscom(epoch, ep, argpp, tc, inclp, nodep, np) {
	const ZES = 0.01675, ZEL = 0.05490, C1SS = 2.9864797e-6, C1L = 4.7968065e-7;
	const ZSINIS = 0.39785416, ZCOSIS = 0.91744867, ZCOSGS = 0.1945905, ZSINGS = -0.98088458;
	const nm = np, em = ep;
	const snodm = Math.sin(nodep), cnodm = Math.cos(nodep), sinomm = Math.sin(argpp), cosomm = Math.cos(argpp);
	const sinim = Math.sin(inclp), cosim = Math.cos(inclp);
	const emsq = em * em, betasq = 1 - emsq, rtemsq = Math.sqrt(betasq);
	const day = epoch + 18261.5 + tc / 1440;
	const xnodce = mod2pi(4.5236020 - 9.2422029e-4 * day);
	const stem = Math.sin(xnodce), ctem = Math.cos(xnodce);
	const zcosil = 0.91375164 - 0.03568096 * ctem, zsinil = Math.sqrt(1 - zcosil * zcosil);
	const zsinhl = 0.089683511 * stem / zsinil, zcoshl = Math.sqrt(1 - zsinhl * zsinhl);
	const gam = 5.8351514 + 0.0019443680 * day;
	let zx = 0.39785416 * stem / zsinil;
	const zy = zcoshl * ctem + 0.91744867 * zsinhl * stem;
	zx = gam + Math.atan2(zx, zy) - xnodce;
	const zcosgl = Math.cos(zx), zsingl = Math.sin(zx);
	let zcosg = ZCOSGS, zsing = ZSINGS, zcosi = ZCOSIS, zsini = ZSINIS, zcosh = cnodm, zsinh = snodm, cc = C1SS;
	const xnoi = 1 / nm;
	const out = { snodm, cnodm, sinim, cosim, sinomm, cosomm, day, em, emsq, gam, rtemsq, nm };
	for (let lsflg = 1; lsflg <= 2; lsflg++) {   // 1＝太陽・2＝月
		const a1 = zcosg * zcosh + zsing * zcosi * zsinh, a3 = -zsing * zcosh + zcosg * zcosi * zsinh;
		const a7 = -zcosg * zsinh + zsing * zcosi * zcosh, a8 = zsing * zsini;
		const a9 = zsing * zsinh + zcosg * zcosi * zcosh, a10 = zcosg * zsini;
		const a2 = cosim * a7 + sinim * a8, a4 = cosim * a9 + sinim * a10;
		const a5 = -sinim * a7 + cosim * a8, a6 = -sinim * a9 + cosim * a10;
		const x1 = a1 * cosomm + a2 * sinomm, x2 = a3 * cosomm + a4 * sinomm;
		const x3 = -a1 * sinomm + a2 * cosomm, x4 = -a3 * sinomm + a4 * cosomm;
		const x5 = a5 * sinomm, x6 = a6 * sinomm, x7 = a5 * cosomm, x8 = a6 * cosomm;
		const z31 = 12 * x1 * x1 - 3 * x3 * x3, z32 = 24 * x1 * x2 - 6 * x3 * x4, z33 = 12 * x2 * x2 - 3 * x4 * x4;
		let z1 = 3 * (a1 * a1 + a2 * a2) + z31 * emsq;
		let z2 = 6 * (a1 * a3 + a2 * a4) + z32 * emsq;
		let z3 = 3 * (a3 * a3 + a4 * a4) + z33 * emsq;
		const z11 = -6 * a1 * a5 + emsq * (-24 * x1 * x7 - 6 * x3 * x5);
		const z12 = -6 * (a1 * a6 + a3 * a5) + emsq * (-24 * (x2 * x7 + x1 * x8) - 6 * (x3 * x6 + x4 * x5));
		const z13 = -6 * a3 * a6 + emsq * (-24 * x2 * x8 - 6 * x4 * x6);
		const z21 = 6 * a2 * a5 + emsq * (24 * x1 * x5 - 6 * x3 * x7);
		const z22 = 6 * (a4 * a5 + a2 * a6) + emsq * (24 * (x2 * x5 + x1 * x6) - 6 * (x4 * x7 + x3 * x8));
		const z23 = 6 * a4 * a6 + emsq * (24 * x2 * x6 - 6 * x4 * x8);
		z1 = z1 + z1 + betasq * z31; z2 = z2 + z2 + betasq * z32; z3 = z3 + z3 + betasq * z33;
		const s3 = cc * xnoi, s2 = -0.5 * s3 / rtemsq, s4 = s3 * rtemsq, s1 = -15 * em * s4;
		const s5 = x1 * x3 + x2 * x4, s6 = x2 * x3 + x1 * x4, s7 = x2 * x4 - x1 * x3;
		const v = { s1, s2, s3, s4, s5, s6, s7, z1, z2, z3, z11, z12, z13, z21, z22, z23, z31, z32, z33 };
		if (lsflg === 1) {
			for (const k in v) out["s" + k] = v[k];   // 太陽側は ss1.. / sz1.. の名で控える（参照実装の命名）
			zcosg = zcosgl; zsing = zsingl; zcosi = zcosil; zsini = zsinil;
			zcosh = zcoshl * cnodm + zsinhl * snodm;
			zsinh = snodm * zcoshl - cnodm * zsinhl;
			cc = C1L;
		} else Object.assign(out, v);
	}
	const o = out;
	o.zmol = mod2pi(4.7199672 + 0.22997150 * day - gam);
	o.zmos = mod2pi(6.2565837 + 0.017201977 * day);
	// 太陽
	o.se2 = 2 * o.ss1 * o.ss6; o.se3 = 2 * o.ss1 * o.ss7;
	o.si2 = 2 * o.ss2 * o.sz12; o.si3 = 2 * o.ss2 * (o.sz13 - o.sz11);
	o.sl2 = -2 * o.ss3 * o.sz2; o.sl3 = -2 * o.ss3 * (o.sz3 - o.sz1); o.sl4 = -2 * o.ss3 * (-21 - 9 * emsq) * ZES;
	o.sgh2 = 2 * o.ss4 * o.sz32; o.sgh3 = 2 * o.ss4 * (o.sz33 - o.sz31); o.sgh4 = -18 * o.ss4 * ZES;
	o.sh2 = -2 * o.ss2 * o.sz22; o.sh3 = -2 * o.ss2 * (o.sz23 - o.sz21);
	// 月
	o.ee2 = 2 * o.s1 * o.s6; o.e3 = 2 * o.s1 * o.s7;
	o.xi2 = 2 * o.s2 * o.z12; o.xi3 = 2 * o.s2 * (o.z13 - o.z11);
	o.xl2 = -2 * o.s3 * o.z2; o.xl3 = -2 * o.s3 * (o.z3 - o.z1); o.xl4 = -2 * o.s3 * (-21 - 9 * emsq) * ZEL;
	o.xgh2 = 2 * o.s4 * o.z32; o.xgh3 = 2 * o.s4 * (o.z33 - o.z31); o.xgh4 = -18 * o.s4 * ZEL;
	o.xh2 = -2 * o.s2 * o.z22; o.xh3 = -2 * o.s2 * (o.z23 - o.z21);
	return o;
}

// 深宇宙の永年率と共鳴項の係数（元期で一度）。s に書き込む。
function dsinit(s, d, t, tc) {
	const Q22 = 1.7891679e-6, Q31 = 2.1460748e-6, Q33 = 2.2123015e-7;
	const ROOT22 = 1.7891679e-6, ROOT44 = 7.3636953e-9, ROOT54 = 2.1765803e-9, ROOT32 = 3.7393792e-7, ROOT52 = 1.1428639e-7;
	const RPTIM = 4.37526908801129966e-3, ZNL = 1.5835218e-4, ZNS = 1.19459e-5;
	const { cosim, sinim } = d;
	let { emsq, em, nm } = d;
	let inclm = s.inclo;
	s.irez = 0;
	if (nm < 0.0052359877 && nm > 0.0034906585) s.irez = 1;              // 一日共鳴（静止）
	if (nm >= 8.26e-3 && nm <= 9.24e-3 && em >= 0.5) s.irez = 2;        // 半日共鳴（モルニア・GPS 系の高離心）
	// 太陽
	const ses = d.ss1 * ZNS * d.ss5, sis = d.ss2 * ZNS * (d.sz11 + d.sz13);
	const sls = -ZNS * d.ss3 * (d.sz1 + d.sz3 - 14 - 6 * emsq);
	const sghs = d.ss4 * ZNS * (d.sz31 + d.sz33 - 6);
	let shs = -ZNS * d.ss2 * (d.sz21 + d.sz23);
	if (inclm < 5.2359877e-2 || inclm > PI - 5.2359877e-2) shs = 0;
	if (sinim !== 0) shs /= sinim;
	const sgs = sghs - cosim * shs;
	// 月
	s.dedt = ses + d.s1 * ZNL * d.s5;
	s.didt = sis + d.s2 * ZNL * (d.z11 + d.z13);
	s.dmdt = sls - ZNL * d.s3 * (d.z1 + d.z3 - 14 - 6 * emsq);
	const sghl = d.s4 * ZNL * (d.z31 + d.z33 - 6);
	let shll = -ZNL * d.s2 * (d.z21 + d.z23);
	if (inclm < 5.2359877e-2 || inclm > PI - 5.2359877e-2) shll = 0;
	s.domdt = sgs + sghl;
	s.dnodt = shs;
	if (sinim !== 0) { s.domdt -= cosim / sinim * shll; s.dnodt += shll / sinim; }
	let dndt = 0;
	const theta = mod2pi(s.gsto + tc * RPTIM);
	em += s.dedt * t; inclm += s.didt * t;
	if (s.irez !== 0) {
		const aonv = Math.pow(nm / XKE, X2O3);
		if (s.irez === 2) {
			const cosisq = cosim * cosim, emo = em, emsqo = emsq;
			em = s.ecco; emsq = s.eccsq;
			const eoc = em * emsq;
			const g201 = -0.306 - (em - 0.64) * 0.440;
			let g211, g310, g322, g410, g422, g520, g521, g532, g533;
			if (em <= 0.65) {
				g211 = 3.616 - 13.2470 * em + 16.2900 * emsq;
				g310 = -19.302 + 117.3900 * em - 228.4190 * emsq + 156.5910 * eoc;
				g322 = -18.9068 + 109.7927 * em - 214.6334 * emsq + 146.5816 * eoc;
				g410 = -41.122 + 242.6940 * em - 471.0940 * emsq + 313.9530 * eoc;
				g422 = -146.407 + 841.8800 * em - 1629.014 * emsq + 1083.4350 * eoc;
				g520 = -532.114 + 3017.977 * em - 5740.032 * emsq + 3708.2760 * eoc;
			} else {
				g211 = -72.099 + 331.819 * em - 508.738 * emsq + 266.724 * eoc;
				g310 = -346.844 + 1582.851 * em - 2415.925 * emsq + 1246.113 * eoc;
				g322 = -342.585 + 1554.908 * em - 2366.899 * emsq + 1215.972 * eoc;
				g410 = -1052.797 + 4758.686 * em - 7193.992 * emsq + 3651.957 * eoc;
				g422 = -3581.690 + 16178.110 * em - 24462.770 * emsq + 12422.520 * eoc;
				g520 = em > 0.715 ? -5149.66 + 29936.92 * em - 54087.36 * emsq + 31324.56 * eoc
					: 1464.74 - 4664.75 * em + 3763.64 * emsq;
			}
			if (em < 0.7) {
				g533 = -919.22770 + 4988.6100 * em - 9064.7700 * emsq + 5542.21 * eoc;
				g521 = -822.71072 + 4568.6173 * em - 8491.4146 * emsq + 5337.524 * eoc;
				g532 = -853.66600 + 4690.2500 * em - 8624.7700 * emsq + 5341.4 * eoc;
			} else {
				g533 = -37995.780 + 161616.52 * em - 229838.20 * emsq + 109377.94 * eoc;
				g521 = -51752.104 + 218913.95 * em - 309468.16 * emsq + 146349.42 * eoc;
				g532 = -40023.880 + 170470.89 * em - 242699.48 * emsq + 115605.82 * eoc;
			}
			const sini2 = sinim * sinim;
			const f220 = 0.75 * (1 + 2 * cosim + cosisq), f221 = 1.5 * sini2;
			const f321 = 1.875 * sinim * (1 - 2 * cosim - 3 * cosisq), f322 = -1.875 * sinim * (1 + 2 * cosim - 3 * cosisq);
			const f441 = 35 * sini2 * f220, f442 = 39.3750 * sini2 * sini2;
			const f522 = 9.84375 * sinim * (sini2 * (1 - 2 * cosim - 5 * cosisq) + 0.33333333 * (-2 + 4 * cosim + 6 * cosisq));
			const f523 = sinim * (4.92187512 * sini2 * (-2 - 4 * cosim + 10 * cosisq) + 6.56250012 * (1 + 2 * cosim - 3 * cosisq));
			const f542 = 29.53125 * sinim * (2 - 8 * cosim + cosisq * (-12 + 8 * cosim + 10 * cosisq));
			const f543 = 29.53125 * sinim * (-2 - 8 * cosim + cosisq * (12 + 8 * cosim - 10 * cosisq));
			const xno2 = nm * nm, ainv2 = aonv * aonv;
			let temp1 = 3 * xno2 * ainv2, temp = temp1 * ROOT22;
			s.d2201 = temp * f220 * g201; s.d2211 = temp * f221 * g211;
			temp1 *= aonv; temp = temp1 * ROOT32;
			s.d3210 = temp * f321 * g310; s.d3222 = temp * f322 * g322;
			temp1 *= aonv; temp = 2 * temp1 * ROOT44;
			s.d4410 = temp * f441 * g410; s.d4422 = temp * f442 * g422;
			temp1 *= aonv; temp = temp1 * ROOT52;
			s.d5220 = temp * f522 * g520; s.d5232 = temp * f523 * g532;
			temp = 2 * temp1 * ROOT54;
			s.d5421 = temp * f542 * g521; s.d5433 = temp * f543 * g533;
			s.xlamo = mod2pi(s.mo + s.nodeo + s.nodeo - theta - theta);
			s.xfact = s.mdot + s.dmdt + 2 * (s.nodedot + s.dnodt - RPTIM) - s.no;
			em = emo; emsq = emsqo;
		}
		if (s.irez === 1) {
			const g200 = 1 + emsq * (-2.5 + 0.8125 * emsq), g310 = 1 + 2 * emsq, g300 = 1 + emsq * (-6 + 6.60937 * emsq);
			const f220 = 0.75 * (1 + cosim) * (1 + cosim);
			const f311 = 0.9375 * sinim * sinim * (1 + 3 * cosim) - 0.75 * (1 + cosim);
			let f330 = 1 + cosim; f330 = 1.875 * f330 * f330 * f330;
			let del1 = 3 * nm * nm * aonv * aonv;
			s.del2 = 2 * del1 * f220 * g200 * Q22;
			s.del3 = 3 * del1 * f330 * g300 * Q33 * aonv;
			s.del1 = del1 * f311 * g310 * Q31 * aonv;
			s.xlamo = mod2pi(s.mo + s.nodeo + s.argpo - theta);
			s.xfact = s.mdot + s.xpidot - RPTIM + s.dmdt + s.domdt + s.dnodt - s.no;
		}
		s.xli = s.xlamo; s.xni = s.no; s.atime = 0;
		nm = s.no + dndt;
	}
}

// 深宇宙の永年・共鳴項の時間発展。共鳴は 720 分刻みの数値積分（atime/xli/xni は衛星に持ち越し＝連続呼びは差分だけ進む）。
function dspace(s, t, el) {
	const FASX2 = 0.13130908, FASX4 = 2.8843198, FASX6 = 0.37448087;
	const G22 = 5.7686396, G32 = 0.95240898, G44 = 1.8014998, G52 = 1.0508330, G54 = 4.4108898;
	const RPTIM = 4.37526908801129966e-3, STEPP = 720, STEPN = -720, STEP2 = 259200;
	const theta = mod2pi(s.gsto + t * RPTIM);
	el.em += s.dedt * t; el.inclm += s.didt * t; el.argpm += s.domdt * t; el.nodem += s.dnodt * t; el.mm += s.dmdt * t;
	if (s.irez === 0) return;
	let ft = 0, xndt = 0, xnddt = 0, xldot = 0;
	if (s.atime === 0 || t * s.atime <= 0 || Math.abs(t) < Math.abs(s.atime)) { s.atime = 0; s.xni = s.no; s.xli = s.xlamo; }
	const delt = t > 0 ? STEPP : STEPN;
	for (;;) {
		const xli = s.xli, xni = s.xni;
		if (s.irez !== 2) {
			xndt = s.del1 * Math.sin(xli - FASX2) + s.del2 * Math.sin(2 * (xli - FASX4)) + s.del3 * Math.sin(3 * (xli - FASX6));
			xldot = xni + s.xfact;
			xnddt = (s.del1 * Math.cos(xli - FASX2) + 2 * s.del2 * Math.cos(2 * (xli - FASX4)) + 3 * s.del3 * Math.cos(3 * (xli - FASX6))) * xldot;
		} else {
			const xomi = s.argpo + s.argpdot * s.atime, x2omi = xomi + xomi, x2li = xli + xli;
			xndt = s.d2201 * Math.sin(x2omi + xli - G22) + s.d2211 * Math.sin(xli - G22) + s.d3210 * Math.sin(xomi + xli - G32)
				+ s.d3222 * Math.sin(-xomi + xli - G32) + s.d4410 * Math.sin(x2omi + x2li - G44) + s.d4422 * Math.sin(x2li - G44)
				+ s.d5220 * Math.sin(xomi + xli - G52) + s.d5232 * Math.sin(-xomi + xli - G52) + s.d5421 * Math.sin(xomi + x2li - G54)
				+ s.d5433 * Math.sin(-xomi + x2li - G54);
			xldot = xni + s.xfact;
			xnddt = (s.d2201 * Math.cos(x2omi + xli - G22) + s.d2211 * Math.cos(xli - G22) + s.d3210 * Math.cos(xomi + xli - G32)
				+ s.d3222 * Math.cos(-xomi + xli - G32) + s.d5220 * Math.cos(xomi + xli - G52) + s.d5232 * Math.cos(-xomi + xli - G52)
				+ 2 * (s.d4410 * Math.cos(x2omi + x2li - G44) + s.d4422 * Math.cos(x2li - G44) + s.d5421 * Math.cos(xomi + x2li - G54)
					+ s.d5433 * Math.cos(-xomi + x2li - G54))) * xldot;
		}
		if (Math.abs(t - s.atime) >= STEPP) {
			s.xli = xli + xldot * delt + xndt * STEP2;
			s.xni = xni + xndt * delt + xnddt * STEP2;
			s.atime += delt;
		} else { ft = t - s.atime; break; }
	}
	const nm = s.xni + xndt * ft + xnddt * ft * ft * 0.5;
	const xl = s.xli + xldot * ft + xndt * ft * ft * 0.5;
	el.mm = s.irez !== 1 ? xl - 2 * el.nodem + 2 * theta : xl - el.nodem - el.argpm + theta;
	el.nm = nm;   // 参照実装の nm = no + (nm − no) と同値
}

// 要素 → 衛星（伝播に要る係数を一度だけ作る）。返り値は propagate に渡す不透明な塊。
export function sgp4init(e) {
	const s = { ...e, error: 0, method: "n", isimp: 0, peo: 0, pinco: 0, plo: 0, pgho: 0, pho: 0 };
	const epoch = e.jdEpoch - 2433281.5;   // 1950 年 1 月 0 日起算の日数（参照実装の単位）
	const { ecco, inclo, bstar, argpo, mo } = s;
	const no_kozai = s.no;
	// initl：Kozai 平均運動 → Brouwer 平均運動
	const eccsq = ecco * ecco, omeosq = 1 - eccsq, rteosq = Math.sqrt(omeosq);
	const cosio = Math.cos(inclo), cosio2 = cosio * cosio;
	const ak = Math.pow(XKE / no_kozai, X2O3);
	const d1 = 0.75 * J2 * (3 * cosio2 - 1) / (rteosq * omeosq);
	let del = d1 / (ak * ak);
	const adel = ak * (1 - del * del - del * (1 / 3 + 134 * del * del / 81));
	del = d1 / (adel * adel);
	s.no = no_kozai / (1 + del);
	const ao = Math.pow(XKE / s.no, X2O3);
	const sinio = Math.sin(inclo), po = ao * omeosq;
	const con42 = 1 - 5 * cosio2;
	s.con41 = -con42 - cosio2 - cosio2;
	const posq = po * po, rp = ao * (1 - ecco);
	s.gsto = gmst(epoch + 2433281.5);
	s.eccsq = eccsq;

	const ss = 78 / RE + 1, qzms2t = Math.pow((120 - 78) / RE, 4);
	if (rp < 220 / RE + 1) s.isimp = 1;
	let sfour = ss, qzms24 = qzms2t;
	const perige = (rp - 1) * RE;
	if (perige < 156) {   // 低い近地点は大気密度の関数を下げる
		sfour = perige < 98 ? 20 : perige - 78;
		qzms24 = Math.pow((120 - sfour) / RE, 4);
		sfour = sfour / RE + 1;
	}
	const pinvsq = 1 / posq, tsi = 1 / (ao - sfour);
	s.eta = ao * ecco * tsi;
	const etasq = s.eta * s.eta, eeta = ecco * s.eta, psisq = Math.abs(1 - etasq);
	const coef = qzms24 * Math.pow(tsi, 4), coef1 = coef / Math.pow(psisq, 3.5);
	const cc2 = coef1 * s.no * (ao * (1 + 1.5 * etasq + eeta * (4 + etasq)) + 0.375 * J2 * tsi / psisq * s.con41 * (8 + 3 * etasq * (8 + etasq)));
	s.cc1 = bstar * cc2;
	let cc3 = 0;
	if (ecco > 1e-4) cc3 = -2 * coef * tsi * J3OJ2 * s.no * sinio / ecco;
	s.x1mth2 = 1 - cosio2;
	s.cc4 = 2 * s.no * coef1 * ao * omeosq * (s.eta * (2 + 0.5 * etasq) + ecco * (0.5 + 2 * etasq)
		- J2 * tsi / (ao * psisq) * (-3 * s.con41 * (1 - 2 * eeta + etasq * (1.5 - 0.5 * eeta))
			+ 0.75 * s.x1mth2 * (2 * etasq - eeta * (1 + etasq)) * Math.cos(2 * argpo)));
	s.cc5 = 2 * coef1 * ao * omeosq * (1 + 2.75 * (etasq + eeta) + eeta * etasq);
	const cosio4 = cosio2 * cosio2;
	const temp1 = 1.5 * J2 * pinvsq * s.no, temp2 = 0.5 * temp1 * J2 * pinvsq, temp3 = -0.46875 * J4 * pinvsq * pinvsq * s.no;
	s.mdot = s.no + 0.5 * temp1 * rteosq * s.con41 + 0.0625 * temp2 * rteosq * (13 - 78 * cosio2 + 137 * cosio4);
	s.argpdot = -0.5 * temp1 * con42 + 0.0625 * temp2 * (7 - 114 * cosio2 + 395 * cosio4) + temp3 * (3 - 36 * cosio2 + 49 * cosio4);
	const xhdot1 = -temp1 * cosio;
	s.nodedot = xhdot1 + (0.5 * temp2 * (4 - 19 * cosio2) + 2 * temp3 * (3 - 7 * cosio2)) * cosio;
	s.xpidot = s.argpdot + s.nodedot;
	s.omgcof = bstar * cc3 * Math.cos(argpo);
	s.xmcof = ecco > 1e-4 ? -X2O3 * coef * bstar / eeta : 0;
	s.nodecf = 3.5 * omeosq * xhdot1 * s.cc1;
	s.t2cof = 1.5 * s.cc1;
	s.xlcof = Math.abs(cosio + 1) > 1.5e-12 ? -0.25 * J3OJ2 * sinio * (3 + 5 * cosio) / (1 + cosio)
		: -0.25 * J3OJ2 * sinio * (3 + 5 * cosio) / 1.5e-12;
	s.aycof = -0.5 * J3OJ2 * sinio;
	s.delmo = Math.pow(1 + s.eta * Math.cos(mo), 3);
	s.sinmao = Math.sin(mo);
	s.x7thm1 = 7 * cosio2 - 1;

	if (TWOPI / s.no >= 225) {   // 深宇宙（周期 225 分以上）
		s.method = "d"; s.isimp = 1;
		const d = dscom(epoch, ecco, argpo, 0, inclo, s.nodeo, s.no);
		for (const k of ["e3", "ee2", "se2", "se3", "sgh2", "sgh3", "sgh4", "sh2", "sh3", "si2", "si3", "sl2", "sl3", "sl4",
			"xgh2", "xgh3", "xgh4", "xh2", "xh3", "xi2", "xi3", "xl2", "xl3", "xl4", "zmol", "zmos"]) s[k] = d[k];
		dsinit(s, d, 0, 0);
	}
	if (s.isimp !== 1) {
		const cc1sq = s.cc1 * s.cc1;
		s.d2 = 4 * ao * tsi * cc1sq;
		const temp = s.d2 * tsi * s.cc1 / 3;
		s.d3 = (17 * ao + sfour) * temp;
		s.d4 = 0.5 * temp * ao * tsi * (221 * ao + 31 * sfour) * s.cc1;
		s.t3cof = s.d2 + 2 * cc1sq;
		s.t4cof = 0.25 * (3 * s.d3 + s.cc1 * (12 * s.d2 + 10 * cc1sq));
		s.t5cof = 0.2 * (3 * s.d4 + 12 * s.cc1 * s.d3 + 6 * s.d2 * s.d2 + 15 * cc1sq * (2 * s.d2 + cc1sq));
	}
	sgp4(s, 0);
	return s;
}

// 元期からの経過（分）→ { r:[km], v:[km/s] }（TEME）。落ちた/発散した衛星は null（s.error に理由番号）。
export function sgp4(s, t) {
	s.error = 0;
	const xmdf = s.mo + s.mdot * t, argpdf = s.argpo + s.argpdot * t, nodedf = s.nodeo + s.nodedot * t;
	const t2 = t * t;
	const el = { argpm: argpdf, mm: xmdf, nodem: nodedf + s.nodecf * t2, em: s.ecco, inclm: s.inclo, nm: s.no };
	let tempa = 1 - s.cc1 * t, tempe = s.bstar * s.cc4 * t, templ = s.t2cof * t2;
	if (s.isimp !== 1) {
		const delomg = s.omgcof * t;
		const delm = s.xmcof * (Math.pow(1 + s.eta * Math.cos(xmdf), 3) - s.delmo);
		const temp = delomg + delm;
		el.mm = xmdf + temp; el.argpm = argpdf - temp;
		const t3 = t2 * t, t4 = t3 * t;
		tempa -= s.d2 * t2 + s.d3 * t3 + s.d4 * t4;
		tempe += s.bstar * s.cc5 * (Math.sin(el.mm) - s.sinmao);
		templ += s.t3cof * t3 + t4 * (s.t4cof + t * s.t5cof);
	}
	if (s.method === "d") dspace(s, t, el);
	let { nm, em, inclm, argpm, nodem, mm } = el;
	if (nm <= 0) { s.error = 2; return null; }
	const am = Math.pow(XKE / nm, X2O3) * tempa * tempa;
	nm = XKE / Math.pow(am, 1.5);
	em -= tempe;
	if (em >= 1 || em < -0.001) { s.error = 1; return null; }
	if (em < 1e-6) em = 1e-6;
	mm += s.no * templ;
	let xlm = mm + argpm + nodem;
	nodem = mod2pi(nodem); argpm = mod2pi(argpm); xlm = mod2pi(xlm);
	mm = mod2pi(xlm - argpm - nodem);

	let ep = em, xincp = inclm, argpp = argpm, nodep = nodem, mp = mm;
	let sinip = Math.sin(inclm), cosip = Math.cos(inclm);
	let aycof = s.aycof, xlcof = s.xlcof, con41 = s.con41, x1mth2 = s.x1mth2, x7thm1 = s.x7thm1;
	if (s.method === "d") {
		({ ep, inclp: xincp, nodep, argpp, mp } = dpper(s, t, false, ep, xincp, nodep, argpp, mp));
		if (xincp < 0) { xincp = -xincp; nodep += PI; argpp -= PI; }
		if (ep < 0 || ep > 1) { s.error = 3; return null; }
		sinip = Math.sin(xincp); cosip = Math.cos(xincp);
		aycof = -0.5 * J3OJ2 * sinip;
		xlcof = Math.abs(cosip + 1) > 1.5e-12 ? -0.25 * J3OJ2 * sinip * (3 + 5 * cosip) / (1 + cosip)
			: -0.25 * J3OJ2 * sinip * (3 + 5 * cosip) / 1.5e-12;
	}
	// 長周期項
	const axnl = ep * Math.cos(argpp);
	let temp = 1 / (am * (1 - ep * ep));
	const aynl = ep * Math.sin(argpp) + temp * aycof;
	const xl = mp + argpp + nodep + temp * xlcof * axnl;
	// ケプラー方程式（Newton・一歩 0.95 rad で打ち切り＝参照実装どおり）
	const u = mod2pi(xl - nodep);
	let eo1 = u, tem5 = 9999.9, sineo1 = 0, coseo1 = 0;
	for (let ktr = 1; Math.abs(tem5) >= 1e-12 && ktr <= 10; ktr++) {
		sineo1 = Math.sin(eo1); coseo1 = Math.cos(eo1);
		tem5 = (u - aynl * coseo1 + axnl * sineo1 - eo1) / (1 - coseo1 * axnl - sineo1 * aynl);
		if (Math.abs(tem5) >= 0.95) tem5 = tem5 > 0 ? 0.95 : -0.95;
		eo1 += tem5;
	}
	// 短周期項
	const ecose = axnl * coseo1 + aynl * sineo1, esine = axnl * sineo1 - aynl * coseo1;
	const el2 = axnl * axnl + aynl * aynl, pl = am * (1 - el2);
	if (pl < 0) { s.error = 4; return null; }
	const rl = am * (1 - ecose), rdotl = Math.sqrt(am) * esine / rl, rvdotl = Math.sqrt(pl) / rl;
	const betal = Math.sqrt(1 - el2);
	temp = esine / (1 + betal);
	const sinu = am / rl * (sineo1 - aynl - axnl * temp), cosu = am / rl * (coseo1 - axnl + aynl * temp);
	let su = Math.atan2(sinu, cosu);
	const sin2u = (cosu + cosu) * sinu, cos2u = 1 - 2 * sinu * sinu;
	temp = 1 / pl;
	const temp1 = 0.5 * J2 * temp, temp2 = temp1 * temp;
	if (s.method === "d") {
		const cosisq = cosip * cosip;
		con41 = 3 * cosisq - 1; x1mth2 = 1 - cosisq; x7thm1 = 7 * cosisq - 1;
	}
	const mrt = rl * (1 - 1.5 * temp2 * betal * con41) + 0.5 * temp1 * x1mth2 * cos2u;
	su -= 0.25 * temp2 * x7thm1 * sin2u;
	const xnode = nodep + 1.5 * temp2 * cosip * sin2u;
	const xinc = xincp + 1.5 * temp2 * cosip * sinip * cos2u;
	const mvt = rdotl - nm * temp1 * x1mth2 * sin2u / XKE;
	const rvdot = rvdotl + nm * temp1 * (x1mth2 * cos2u + 1.5 * con41) / XKE;
	const sinsu = Math.sin(su), cossu = Math.cos(su), snod = Math.sin(xnode), cnod = Math.cos(xnode);
	const sini = Math.sin(xinc), cosi = Math.cos(xinc);
	const xmx = -snod * cosi, xmy = cnod * cosi;
	const ux = xmx * sinsu + cnod * cossu, uy = xmy * sinsu + snod * cossu, uz = sini * sinsu;
	const vx = xmx * cossu - cnod * sinsu, vy = xmy * cossu - snod * sinsu, vz = sini * cossu;
	if (mrt < 1) { s.error = 6; return null; }   // 地表下＝落下済み
	return {
		r: [mrt * ux * RE, mrt * uy * RE, mrt * uz * RE],
		v: [(mvt * ux + rvdot * vx) * VKMPERSEC, (mvt * uy + rvdot * vy) * VKMPERSEC, (mvt * uz + rvdot * vz) * VKMPERSEC],
	};
}

// 衛星と日時（Date かユリウス日）→ TEME の { r, v } または null
export function propagate(s, when) {
	const jd = typeof when === "number" ? when : jdOf(when);
	return sgp4(s, (jd - s.jdEpoch) * 1440);
}

// TEME 位置[km] と GMST → 測地経緯度（度）と楕円体高（km）。WGS-84 楕円体・反復 Bowring 風（3 回で mm 級）。
export function temeToGeodetic(r, g) {
	const A = 6378.137, F = 1 / 298.257223563, E2 = F * (2 - F);
	const c = Math.cos(g), s = Math.sin(g);
	const x = r[0] * c + r[1] * s, y = -r[0] * s + r[1] * c, z = r[2];   // TEME → 地球固定（極運動は無視＝~10 m 級）
	const p = Math.hypot(x, y);
	let lat = Math.atan2(z, p * (1 - E2)), N = A;
	for (let i = 0; i < 4; i++) {
		const sl = Math.sin(lat);
		N = A / Math.sqrt(1 - E2 * sl * sl);
		lat = Math.atan2(z + N * E2 * sl, p);
	}
	const cl = Math.cos(lat);
	const h = Math.abs(cl) > 1e-10 ? p / cl - N : Math.abs(z) - A * (1 - F);
	return { lon: Math.atan2(y, x) / D2R, lat: lat / D2R, h };
}
