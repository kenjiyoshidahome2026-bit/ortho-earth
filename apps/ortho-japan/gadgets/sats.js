// ガジェット本体：人工衛星＝いま軌道にいる衛星を球のまわりに浮かべる。
// データ：CelesTrak の GP（米宇宙軍の公開カタログの再配布・OMM の CSV）。active（運用中 約 1.6 万機・gzip で約 0.7 MB）一本だけ取り、
//   分類は名前（Starlink）と軌道の形（高度帯・離心率）で手元で付ける。
//   読む先はミラー（www.ortho-earth.com/sats/active.csv＝専用 Worker apps/sats-mirror が cron で 2 時間に 1 回だけ CelesTrak から素通しで KV に置く）。
//   ⚠CelesTrak は同じグループを同一 IP から 2 時間に 1 回しか返さない（間は CSV でなく断り文・実測 2026-09-19）＝学校など IP を
//   共有する所では直読みだと 2 人目以降が読めない（本人裁定 9/19＝ミラー）。ミラーが無い/壊れた時だけ CelesTrak 直読みへ落ちる。
//   手元は Cache API に 30 分置く（開き直しで 0.7 MB を取り直さない）。全部だめなら古い手元の要素で回す（数日なら km 級）。
// 伝播：ephem/sgp4（自前の SGP4/SDP4＝参照実装の移植・satellite.js と全機 cm 一致を検定済み）。
//   全機の伝播は 1 秒に 1 回（約 6 ms）。間のフレームは位置＋速度×経過で直線外挿（1 秒で 数 m の誤差＝画面では 0 px）。
//   描画は地球固定（ECEF）へ GMST で回して app 注入の makeSkyProjector へ＝毎フレーム経緯度に戻さない。
// 表示：点＝分類ごとの色（凡例＝パネルの行・押すと出し入れ）。有人の宇宙ステーションは名前つき。点をクリック＝その衛星の
//   軌道（前後半周＝地球の自転込みの実際の通り道）と地上軌跡・真下への糸・高度と速さを出す。既定の選択は ISS。
// 四戒：独立（注入 makeSkyProjector/makeProjector/setClick のみ・app を import しない）／遅延（sats-stub が初回クリックで import）／
//   抽象アクセス（frame hook は onBody 経由で app が配線）／表示域はガジェットが知らない（搭載側 zoom 宣言＋地球の見かけの大きさで畳む）。
import { parseOMM, sgp4init, sgp4, gmst, temeToGeodetic, jdOf } from "ephem/sgp4";
import { gunzip } from "geopbf/gzip";
import { tr, getLang } from "../i18n.js";
const t = tr();

const MIRROR = "https://www.ortho-earth.com/sats/active.csv";   // 専用 Worker apps/sats-mirror（CORS 開放＝開発機や lib 利用先からも読める）
const SRC = "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=csv";      // 本家（ミラーが無い時だけ）
const CACHE = "ortho-sats-v1", FRESH_MS = 30 * 60e3;
const PROP_MS = 1000, IDLE_MS = 100;       // 全機の伝播間隔／カメラが止まっている間の描き直し間隔（衛星は動き続ける）
const MIN_EARTH_PX = 14;                    // 地球の見かけの半径がこれ未満（太陽系圏の奥）＝点が地球に団子＝畳む
// 分類（描く順＝配列順＝数の多い Starlink が一番下）。label は関数＝言語パック到着後に引く（モジュール評価時に t() を呼ばない掟）
const CATS = [
	{ key: "starlink", color: "#6f9dff", label: () => "Starlink" },
	{ key: "leo", color: "#25b394", label: () => t("Low Earth orbit") },
	{ key: "meo", color: "#f09a28", label: () => t("Medium Earth orbit (GPS etc.)") },
	{ key: "geo", color: "#ec5b73", label: () => t("Geostationary orbit") },
	{ key: "heo", color: "#b07cf2", label: () => t("Highly elliptical orbit") },
];
const STATIONS = new Map([[25544, "ISS"], [48274, "Tiangong"]]);   // 有人の宇宙ステーション（NORAD 番号→表示名）＝常に名前つき
const DEFAULT_PICK = 25544;
const PATH_N = 240;                         // 選択衛星の軌道の標本数（前後半周）

const CSS = `
#sats-lines { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
#sats-panel { position: absolute; top: 8px; left: 52px; width: min(260px, calc(100vw - 64px));
	display: none; flex-direction: column; gap: 2px; background: rgba(255,255,255,.96); color: #3f4757; border-radius: 10px;
	box-shadow: 0 4px 18px rgba(0,0,0,.18); font: 12px/1.5 system-ui; padding: 8px 8px 6px; }
#sats-panel.on { display: flex; }
#sats-head { display: flex; align-items: baseline; gap: 6px; padding: 0 2px 2px; }
#sats-head b { font-weight: 600; }
#sats-n { color: #8a93a3; flex: 1; }
#sats-x { border: 0; background: none; color: #8a93a3; font: 16px/1 system-ui; cursor: pointer; padding: 0 2px; }
.sats-cat { display: flex; align-items: center; gap: 8px; width: 100%; border: 0; background: none; text-align: start;
	padding: 3px 4px; border-radius: 6px; cursor: pointer; font: 12px system-ui; color: inherit; }
.sats-cat:hover { background: #eef1f6; }
.sats-cat i { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.sats-cat span { flex: 1; }
.sats-cat em { font-style: normal; color: #8a93a3; font-variant-numeric: tabular-nums; }
.sats-cat.off { opacity: .4; }
.sats-cat.off i { background: transparent !important; box-shadow: inset 0 0 0 1.5px #8a93a3; }
#sats-sel { padding: 4px; border-top: 1px solid #e3e7ee; margin-top: 2px; }
#sats-sel b { font-weight: 600; }
#sats-sel .m { color: #6b7385; font-variant-numeric: tabular-nums; }
#sats-foot { padding: 2px 4px 0; color: #9aa2b1; font-size: 10px; }
#sats-tip { position: absolute; pointer-events: none; display: none; padding: 1px 6px; border-radius: 5px; white-space: nowrap;
	background: rgba(20,24,32,.82); color: #fff; font: 11px/1.6 system-ui; transform: translate(10px, -50%); }`;

export function sats({ btn, makeSkyProjector, makeProjector, setClick, signal } = {}) {
	const mapEl = this.mapEl;
	if (mapEl.querySelector("#sats-lines")) return null;   // 二重搭載は無害
	const dpr = window.devicePixelRatio || 1;
	const font = (getComputedStyle(document.documentElement).getPropertyValue("--qm-font") || "system-ui").trim();
	if (!mapEl.querySelector("#sats-style")) { const st = document.createElement("style"); st.id = "sats-style"; st.textContent = CSS; mapEl.append(st); }
	if (!btn) {   // 直搭載（stub 非経由＝単体でも動く）
		btn = document.createElement("button"); btn.id = "sats-btn";
		btn.dataset.tip = t("Satellites in orbit now"); btn.setAttribute("aria-label", t("Satellites in orbit now"));
		import("./sats-stub.js").then(m => { btn.innerHTML = m.ICON; });
		(mapEl.querySelector("#gadgets") || mapEl).append(btn);
	}
	const canvas = document.createElement("canvas"); canvas.id = "sats-lines"; mapEl.append(canvas);
	const ctx = canvas.getContext("2d");
	const tip = document.createElement("div"); tip.id = "sats-tip"; mapEl.append(tip);
	const panel = document.createElement("div"); panel.id = "sats-panel";
	panel.innerHTML = `
		<div id="sats-head"><b>${t("Satellites in orbit now")}</b><span id="sats-n"></span><button id="sats-x" aria-label="${t("Close")}">×</button></div>
		<div id="sats-cats"></div>
		<div id="sats-sel"></div>
		<div id="sats-foot"></div>`;
	panel.addEventListener("pointerdown", e => e.stopPropagation());
	mapEl.append(panel);
	const $ = id => panel.querySelector("#" + id);
	const nf = new Intl.NumberFormat(getLang());

	// ---- 状態 ----
	let active = false, loading = null, cw = 0, ch = 0;
	let S = [], cat = null, names = [], norad = null;   // 衛星（sgp4init 済み）と分類・名前・NORAD 番号
	let R = null, V = null, ok = null, tProp = 0;      // 直近の伝播（TEME km・km/s）と時刻(ms)
	let SX = null, SY = null;                          // 直近の画面位置（CSS px・NaN＝見えない）＝ホバー/クリックの当たり
	const vis = new Set(CATS.map(c => c.key));
	let pick = -1, path = null, pathAt = 0;            // 選択衛星・その軌道（ECEF km と経緯度）
	let raf = 0, lastDraw = 0, dirty = true, dataAt = 0;

	btn.addEventListener("click", () => (active ? close() : open()));
	$("sats-x").addEventListener("click", () => close());

	// ---- データ ----
	async function fetchCsv() {
		let cache = null, hit = null;
		try { cache = await caches.open(CACHE); hit = await cache.match(SRC); } catch (e) { /* Cache API 無し（非セキュア文脈等）＝毎回取る */ }
		const at = hit ? +hit.headers.get("x-fetched-at") || 0 : 0;
		if (hit && Date.now() - at < FRESH_MS) return await hit.text();
		const isCsv = text => text.startsWith("OBJECT_NAME,");
		for (const [name, url] of [["mirror", MIRROR], ["celestrak", SRC]]) {
			try {
				const r = await fetch(url, { signal });
				if (!r.ok) { console.warn(`[sats] ${name}: HTTP ${r.status}`); continue; }
				const text = await (await gunzip(await r.blob())).text();   // ミラーは gzip 配信＝通常はブラウザが解く。解かれずに届いても gunzip が解く（平文は素通し）
				if (!isCsv(text)) { console.warn(`[sats] ${name} did not return CSV (rate limit?):`, text.slice(0, 120)); continue; }
				cache?.put(SRC, new Response(text, { headers: { "content-type": "text/csv", "x-fetched-at": String(Date.now()) } })).catch(() => {});
				return text;
			} catch (e) { if (signal?.aborted) throw e; console.warn(`[sats] ${name} fetch failed`, e); }
		}
		if (hit) return await hit.text();
		throw new Error("no orbital data");
	}
	function parseCsv(text) {
		const lines = text.split(/\r?\n/).filter(Boolean), head = lines[0].split(",");
		const rows = [];
		for (let i = 1; i < lines.length; i++) {
			const f = splitCsv(lines[i]); if (f.length < head.length) continue;
			const o = {}; head.forEach((h, j) => { o[h] = f[j]; }); rows.push(o);
		}
		return rows;
	}
	function splitCsv(line) {   // 名前に , が入る時だけ "…" で括られる＝最小の CSV 読み
		if (!line.includes('"')) return line.split(",");
		const out = []; let cur = "", q = false;
		for (let i = 0; i < line.length; i++) {
			const c = line[i];
			if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
			else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
		}
		out.push(cur); return out;
	}
	const classify = o => {
		const n = +o.MEAN_MOTION, e = +o.ECCENTRICITY;
		if (/^STARLINK/.test(o.OBJECT_NAME)) return 0;
		if (e > 0.25) return 4;        // 長楕円（モルニア・静止トランスファー等）
		if (n > 11.25) return 1;       // 低軌道（周期 128 分未満＝高度 約 2,000 km 以下）
		if (n > 0.9 && n < 1.1) return 3;   // 静止・対地同期（一日一周）
		return 2;                      // 中軌道（GPS・GLONASS・Galileo・北斗など）
	};
	function load() {
		return loading ||= (async () => {
			setFoot(t("Loading orbits…"));
			const text = await fetchCsv();
			const rows = parseCsv(text), sats = [], cats = [], nm = [], ids = [];
			for (const o of rows) {
				let s; try { s = sgp4init(parseOMM(o)); } catch (e) { continue; }
				if (s.error) continue;
				sats.push(s); cats.push(classify(o)); nm.push(o.OBJECT_NAME); ids.push(+o.NORAD_CAT_ID);
			}
			S = sats; cat = Uint8Array.from(cats); names = nm; norad = Int32Array.from(ids);
			const nowMs = Date.now();   // 最新の元期＝この要素の新しさ（取得時刻より正直）。未来の元期（打ち上げ予定の名目要素等・実測 2 日先）は除く
			dataAt = S.reduce((m, s) => { const e = (s.jdEpoch - 2440587.5) * 864e5; return e <= nowMs && e > m ? e : m; }, 0);
			const n = S.length;
			R = new Float64Array(n * 3); V = new Float64Array(n * 3); ok = new Uint8Array(n);
			SX = new Float32Array(n).fill(NaN); SY = new Float32Array(n).fill(NaN);
			if (pick < 0) pick = norad.indexOf(DEFAULT_PICK);
			propagateAll(Date.now());
			buildCats(); setFoot(); showSel();
		})().catch(e => { loading = null; if (!signal?.aborted) { console.error("[sats]", e); setFoot(t("Could not load orbital data")); } });
	}

	// ---- 伝播 ----
	function propagateAll(now) {
		const jd = jdOf(now);
		for (let i = 0; i < S.length; i++) {
			const s = S[i], p = sgp4(s, (jd - s.jdEpoch) * 1440);
			if (!p) { ok[i] = 0; continue; }
			ok[i] = 1;
			R[i * 3] = p.r[0]; R[i * 3 + 1] = p.r[1]; R[i * 3 + 2] = p.r[2];
			V[i * 3] = p.v[0]; V[i * 3 + 1] = p.v[1]; V[i * 3 + 2] = p.v[2];
		}
		tProp = now;
	}
	function buildPath(now) {   // 選択衛星の前後半周（最長 1 日）＝地球固定での通り道（自転込み）
		const s = S[pick], period = Math.min(1440, 2 * Math.PI / s.no);
		const pts = [];
		for (let k = 0; k <= PATH_N; k++) {
			const jd = jdOf(now) + ((k / PATH_N - 0.5) * period) / 1440;
			const p = sgp4(s, (jd - s.jdEpoch) * 1440);
			if (!p) { pts.push(null); continue; }
			const g = gmst(jd), c = Math.cos(g), sn = Math.sin(g);
			const X = p.r[0] * c + p.r[1] * sn, Y = -p.r[0] * sn + p.r[1] * c, Z = p.r[2];
			const ll = temeToGeodetic(p.r, g);
			pts.push({ X, Y, Z, lon: ll.lon, lat: ll.lat });
		}
		path = pts; pathAt = now;
	}

	// ---- 描画 ----
	function syncSize() {
		const w = mapEl.clientWidth, h = mapEl.clientHeight;
		if (w !== cw || h !== ch) { cw = w; ch = h; canvas.width = w * dpr; canvas.height = h * dpr; }
	}
	function draw() {
		syncSize();
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, cw, ch);
		tip.style.display = "none";
		if (!active || !S.length) return;
		const now = Date.now();
		if (now - tProp > PROP_MS) propagateAll(now);
		const pr = makeSkyProjector();
		if (pr.earthPx < MIN_EARTH_PX) { SX.fill(NaN); return; }
		const dt = (now - tProp) / 1000, g = gmst(jdOf(now)), c = Math.cos(g), sn = Math.sin(g);
		const r = 0.8 + Math.min(0.8, pr.earthPx / 1200);   // 点の半幅＝寄るほど少し大きく（一辺 1.6〜3.2 px）。大きいと地球の前面が点で塗り潰れる
		const byCat = CATS.map(() => []);
		for (let i = 0; i < S.length; i++) {
			SX[i] = NaN;
			if (!ok[i] || !vis.has(CATS[cat[i]].key)) continue;
			const x = R[i * 3] + V[i * 3] * dt, y = R[i * 3 + 1] + V[i * 3 + 1] * dt, z = R[i * 3 + 2] + V[i * 3 + 2] * dt;
			const q = pr(x * c + y * sn, -x * sn + y * c, z);
			if (!q) continue;
			SX[i] = q[0]; SY[i] = q[1];
			byCat[cat[i]].push(i);
		}
		const d = r * 2;
		ctx.globalAlpha = 0.8;
		byCat.forEach((list, k) => {
			ctx.fillStyle = CATS[k].color;
			for (const i of list) ctx.fillRect(SX[i] - r, SY[i] - r, d, d);
		});
		ctx.globalAlpha = 1;
		// 選択衛星の軌道（宙の通り道＋地上軌跡＋真下への糸）＝点の上に引く（地球の前面は 1 万点で埋まる＝下に敷くと沈んで見えない）
		if (pick >= 0 && ok[pick]) {
			if (!path || now - pathAt > 15000) buildPath(now);
			const col = STATIONS.has(norad[pick]) ? "#ffffff" : CATS[cat[pick]].color;
			const sp = makeProjector();
			ctx.lineWidth = 1; ctx.strokeStyle = col; ctx.globalAlpha = 0.35;
			strokePath(p => { const q = sp(p.lon, p.lat); return q[2] < 0 ? null : q; });   // 地上軌跡
			ctx.lineWidth = 1.5; ctx.globalAlpha = 0.85;
			strokePath(p => pr(p.X, p.Y, p.Z));                                            // 宙の通り道
			if (!isNaN(SX[pick])) {   // 真下への糸（高さが見える）
				const ll = temeToGeodetic([R[pick * 3] + V[pick * 3] * dt, R[pick * 3 + 1] + V[pick * 3 + 1] * dt, R[pick * 3 + 2] + V[pick * 3 + 2] * dt], g), q = sp(ll.lon, ll.lat);
				if (q[2] >= 0) { ctx.globalAlpha = 0.5; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(SX[pick], SY[pick]); ctx.lineTo(q[0], q[1]); ctx.stroke(); }
			}
			ctx.globalAlpha = 1;
		}
		// 宇宙ステーション＋選択衛星＝白縁の丸と名前
		ctx.font = `600 11px ${font}`; ctx.textBaseline = "middle";
		for (let i = 0; i < S.length; i++) {
			const st = STATIONS.get(norad[i]);
			if ((!st && i !== pick) || isNaN(SX[i])) continue;
			ctx.beginPath(); ctx.arc(SX[i], SY[i], 4, 0, Math.PI * 2);
			ctx.fillStyle = st ? "#ffffff" : CATS[cat[i]].color; ctx.fill();
			ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(20,24,32,.85)"; ctx.stroke();
			label(st || names[i], SX[i] + 8, SY[i]);
		}
		if (hoverI >= 0 && hoverI !== pick && !STATIONS.has(norad[hoverI]) && !isNaN(SX[hoverI])) {   // ホバー中の衛星名（DOM の吹き出し）＝名前を描き済みの点には出さない
			tip.textContent = names[hoverI]; tip.style.left = SX[hoverI] + "px"; tip.style.top = SY[hoverI] + "px"; tip.style.display = "block";
		}
		lastDraw = now; dirty = false;
		if (pick >= 0) showSel(dt, g);
	}
	function strokePath(proj) {
		ctx.beginPath(); let pen = false;
		for (const p of path) {
			const q = p && proj(p);
			if (!q) { pen = false; continue; }
			pen ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); pen = true;
		}
		ctx.stroke();
	}
	function label(text, x, y) {
		ctx.lineWidth = 3; ctx.strokeStyle = "rgba(20,24,32,.8)"; ctx.lineJoin = "round"; ctx.strokeText(text, x, y);
		ctx.fillStyle = "#fff"; ctx.fillText(text, x, y);
	}
	const loop = () => {
		raf = 0; if (!active) return;
		if (dirty || Date.now() - lastDraw >= IDLE_MS) draw();
		raf = requestAnimationFrame(loop);
	};

	// ---- パネル ----
	function buildCats() {
		const counts = CATS.map(() => 0); for (const k of cat) counts[k]++;
		$("sats-n").textContent = nf.format(S.length);
		$("sats-cats").innerHTML = CATS.map((c, k) => `<button class="sats-cat${vis.has(c.key) ? "" : " off"}" data-k="${c.key}" aria-pressed="${vis.has(c.key)}">
			<i style="background:${c.color}"></i><span>${c.label()}</span><em>${nf.format(counts[k])}</em></button>`).join("");
	}
	panel.addEventListener("click", e => {
		const b = e.target.closest(".sats-cat"); if (!b) return;
		const k = b.dataset.k; vis.has(k) ? vis.delete(k) : vis.add(k);
		b.classList.toggle("off", !vis.has(k)); b.setAttribute("aria-pressed", vis.has(k)); dirty = true;
	});
	let selKey = "";
	function showSel(dt = 0, g = 0) {
		const el = $("sats-sel");
		if (pick < 0 || !S.length) { el.style.display = "none"; return; }
		el.style.display = "";
		const i = pick;
		if (!ok[i]) { el.innerHTML = `<b>${esc(names[i])}</b>`; return; }
		const r = [R[i * 3] + V[i * 3] * dt, R[i * 3 + 1] + V[i * 3 + 1] * dt, R[i * 3 + 2] + V[i * 3 + 2] * dt];
		const h = temeToGeodetic(r, g).h, v = Math.hypot(V[i * 3], V[i * 3 + 1], V[i * 3 + 2]);
		const name = names[i];
		const key = `${i}|${Math.round(h)}|${v.toFixed(2)}`;
		if (key === selKey) return; selKey = key;   // 変わった時だけ DOM を書く（毎フレーム innerHTML しない）
		el.innerHTML = `<b>${esc(name)}</b><div class="m">${t("Altitude $1 km · speed $2 km/s", nf.format(Math.round(h)), v.toFixed(2))}</div>`;
	}
	function setFoot(msg) {
		const when = dataAt ? new Date(dataAt).toLocaleString(getLang(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
		$("sats-foot").textContent = msg ?? `${t("Orbital data: CelesTrak (NORAD GP) · $1", when)} · ${t("Click a dot to see its orbit")}`;
	}
	const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

	// ---- 当たり（ホバー＝名前・クリック＝選択） ----
	let hoverI = -1;
	function nearest(x, y, rad) {
		if (!SX) return -1;
		let best = -1, bd = rad * rad;
		for (let i = 0; i < SX.length; i++) {
			const dx = SX[i] - x; if (!(dx * dx <= bd)) continue;   // NaN も落ちる
			const dy = SY[i] - y, d2 = dx * dx + dy * dy;
			if (d2 < bd) { bd = d2; best = i; }
		}
		return best;
	}
	mapEl.addEventListener("pointermove", e => {
		if (!active || e.pointerType === "touch") return;
		const b = mapEl.getBoundingClientRect(), i = nearest(e.clientX - b.left, e.clientY - b.top, 7);
		if (i !== hoverI) { hoverI = i; dirty = true; }
	}, { signal, passive: true });
	mapEl.addEventListener("pointerleave", () => { if (hoverI >= 0) { hoverI = -1; dirty = true; } }, { signal });
	function onClick(x, y) {
		const i = nearest(x, y, 10);
		if (i < 0) return false;
		pick = i; path = null; selKey = ""; dirty = true;
		return true;
	}

	// ---- 開閉 ----
	function open() {
		if (active) return;
		active = true; btn.classList.add("on"); panel.classList.add("on");
		setClick(onClick); load(); dirty = true;
		raf ||= requestAnimationFrame(loop);
	}
	function close() {
		if (!active) return;
		active = false; btn.classList.remove("on"); panel.classList.remove("on");
		setClick(null); hoverI = -1;
		if (raf) { cancelAnimationFrame(raf); raf = 0; }
		draw();   // 消去
	}
	signal?.addEventListener("abort", () => { close(); canvas.remove(); tip.remove(); panel.remove(); }, { once: true });
	const _update = () => { if (active) draw(); };   // カメラが動いた＝同じフレームで描き直す（球と 1 フレームずれない）。静止中は自前のループが衛星の動きを描く
	return { _update, open, close, toggle: () => (active ? close() : open()), stats: () => ({ total: S.length, visible: SX ? SX.reduce((n, x) => n + (x === x), 0) : 0, pick: pick >= 0 ? names[pick] : null }) };
}
