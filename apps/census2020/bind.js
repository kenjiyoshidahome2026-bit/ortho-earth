// パネル⇄地図の双方向バインド＋gint単一スロットの調停＋URL ?area= ＝census2020 の背骨。
// パネル→地図: onDrill（census/ui.js のフック）→ flyTo・estat小地域境界・防災/筆トグルの活性化。
// 地図→パネル: gintクリック（admin_all=市区町村）→ drillTo／estat identify（小地域）→ drillToArea。
// スロット調停: 全国コロプレス(admin_all) ⇄ 市区町村スタック(筆/土砂/洪水) は同じ gint 単一スロットを
// 取り合う＝占有者(slotOwner)をここで一元管理し、スタック解除で必ず admin へ戻す。
import { onDrill, drillTo, drillToArea } from "./census/ui.js";
import { prefetchSmallAreaIdb } from "./census/small-area.js";
import { belongsTo } from "./jp/codes.js";
import { initBousai } from "./bousai.js";
import ESTAT_MANIFEST from "./estat/manifest.json" with { type: "json" };

const ESTAT_CODES = ESTAT_MANIFEST.map(e => e.code);
// 小地域(町丁目)の内側メッシュ線。淡すぎ＋地形とz-fightで時たま消える件（本人報告 2026-08-12）→
// 濃く細く(alpha 0.55→0.88・width 1→0.6)。地形からのリフトは overlay 共通としてレンダラ側で付与
// （OVERLAY_LIFT・p0.y＝z-fight 明滅の根治・N02/AI overlay にも効く一般改善）。
const ESTAT_STYLE = { lineColor: [0.22, 0.44, 0.78, 0.88], lineWidth: 0.6 };
const SA_MAX_ZOOM = 16.3;   // 丁目 bbox は極小＝寄り過ぎ防止の上限

export function initBind(map, { choro, legend }) {
	const overlay = map.overlay;
	let cityCode = null;         // ドリル中の市区町村（estat 境界の単位）
	let slotOwner = "admin";     // gint 単一スロットの占有者: 'admin' | 'stack'
	// ?area=＋hash 共有URLで開いた時は hash のカメラが正＝復元ドリルの flyTo を1回だけ抑止
	let suppressFly = !!location.hash && new URLSearchParams(location.search).has("area");

	const bousai = initBousai(map, {
		bboxForCode: code => choro.bboxForCode(code),
		cityGeomForCode: code => choro.geomForCode(code),   // A33 の境界クリップ（重心 点in面）用に市ポリゴンを渡す
		legend,   // 防災層＝自前の凡例（浸水深ランク/警戒区分）を出す。解除でコロプレス凡例へ復元
		onStackApplied: () => { slotOwner = "stack"; },
		onStackCleared: () => { if (slotOwner === "stack") { slotOwner = "admin"; choro.applyAdmin(); } choro.refreshLegend(); },
	});

	// --- URL ?area=（view hash・他クエリ（?gl2=1 等）は温存。書くのは area だけ） ---
	const writeArea = code => {
		const q = new URLSearchParams(location.search);
		if (code) q.set("area", code); else q.delete("area");
		const qs = q.toString();
		history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
	};

	// 政令市＝区コード列（estat ファイルは区単位）／それ以外＝自コード
	const estatCodesFor = code => {
		const members = ESTAT_CODES.filter(c => belongsTo(c, code));   // 政令市=区／東京都区部13100=23区／県=前方一致
		return members.length ? members : (ESTAT_CODES.includes(code) ? [code] : []);
	};

	function enterCity(code, { withBousai = true } = {}) {
		// 政令市の集約コード(34100 広島市 等)は bousai/moj データが区単位(34101〜)にしか無い＝集約コードを
		// probe すると 404 を撒く。防災/筆は区ドリル(terminal)でのみ有効化＝集約レベルではトグルを出さない。
		if (withBousai) bousai.enterCity(code);   // トグルUI更新は再入でも行う（在庫 probe 含む）
		else bousai.leaveCity();
		if (cityCode === code) return;
		cityCode = code;
		const codes = estatCodesFor(code);   // 集約コードは区コード列へ展開（estat 小地域は区単位で読む）
		if (codes.length) overlay.loadEstat(codes, "2020", ESTAT_STYLE, { moveCamera: false, quiet: true });
	}
	function leaveCity() {
		if (cityCode == null) return;
		cityCode = null;
		bousai.leaveCity();     // スタック解除 → onStackCleared → admin 復帰
		overlay.clearPlan();    // estat 境界とハイライトを消す
	}
	async function highlightAndFly(key) {
		const r = await overlay.highlightKey(key);
		if (r?.bbox && !suppressFly) {
			const b = r.bbox;
			map.flyTo((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, Math.min(SA_MAX_ZOOM, map.fitZoomForBbox(b)));
		}
	}

	// --- パネル → 地図 ---
	onDrill(async e => {
		await choro.ready.catch(err => console.warn("[bind] choro.ready 失敗（flyTo/コロプレスは効かない）", err));   // bbox台帳が要る（初回のみ待つ）
		console.log("[bind] drill %s %s", e.level, e.code ?? "");
		switch (e.level) {
			case "national":
				writeArea(null); leaveCity(); choro.showLevel(choro.nationalLevel); choro.setLevels(["pref", "mun"]); choro.setSelected(null);   // 全国＝県/市区町村トグル復元
				if (!suppressFly) map.flyTo(136.9, 38.2, 5.1);
				break;
			case "pref":
				writeArea(e.code); leaveCity(); choro.showLevel("mun"); choro.setLevels(e.code === "01" ? ["shicho", "mun"] : []); choro.setSelected(null);   // 県へ降下（北海道は振興局選択可）
				if (!suppressFly) choro.flyToCode(e.code);
				break;
			case "designated":   // 政令市＝区一覧＋政令市単位で防災も有効（A31=メッシュ・A33=県の直読み＝集約コードでも動く。
				// moj筆のみ区単位＝probeで自動不活性。旧「404を断つ」根拠は焼きデータ依存＝直読み化で解消・本人裁定2026-08-14）。
				writeArea(e.code); choro.setSelected(e.code); choro.setLevels([]);
				if (!suppressFly) choro.flyToCode(e.code);
				enterCity(e.code);
				break;
			case "city":
				writeArea(e.code); choro.setSelected(e.code); choro.setLevels([]);
				if (!suppressFly) choro.flyToCode(e.code);
				enterCity(e.code);
				break;
			case "sa-table":
				if (e.city && e.city !== cityCode) enterCity(e.city);
				if (e.code) { writeArea(e.code); highlightAndFly(e.code); }
				break;
			case "sa-leaf":
				if (e.city && e.city !== cityCode) enterCity(e.city);
				writeArea(e.code);
				highlightAndFly(e.code);
				break;
		}
		suppressFly = false;   // 抑止は復元の初回イベントだけ
	});

	// --- 地図 → パネル ---
	map.onGintClick((fid, props, lnglat) => {
		if (slotOwner !== "admin") { bousai.onFeatureClick(fid, props, lnglat); return; }
		const code = props?.code; if (!code) return;
		if (/^\d/.test(String(code))) drillTo(String(code));   // 数字始まり＝都道府県2桁/市区町村5桁＝ドリル（桁数で階層決定）
		else choro.descendAgg(fid);                            // 合成コード(SH.../GN…)＝集約(振興局/郡)＝その領域の市区町村へ降下
	});
	overlay.setIdentifyHandler(hit => {
		if (!hit) return;
		if (bousai.isActive()) return;   // 防災/筆の点検中はパネルを跳ばさない（tip/属性カードに専念）
		const key = hit.props?.KEY_CODE;
		if (key) drillToArea(String(key));
	});

	// --- 起動時の ?area= 復元（hash のカメラは engine が復元済み） ---
	const area = new URLSearchParams(location.search).get("area");
	if (area) {
		if (area.length <= 5) drillTo(area);
		else prefetchSmallAreaIdb().then(() => drillToArea(area)).catch(() => drillTo(area.slice(0, 5)));
	}
	return { get cityCode() { return cityCode; } };
}
