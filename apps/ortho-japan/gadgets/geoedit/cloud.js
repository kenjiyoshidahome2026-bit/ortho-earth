// クラウド保存パネル＝共通の器（apps/ortho-japan/gadgets/cloud.js）へ geoedit の中身を注入する薄いアダプタ。
//   保存＝書き出しと同じ口（getPbf → geopbfFile）／開く＝ドロップ取込と同経路（loadBuffer＝新セッション扱い）／
//   一覧＝.scenes（scenes エディタの持ち物）以外＝地図データだけ見せる／公開台帳＝地図作品用に有効（サムネ＝生スナップ＋編集オーバレイ）。
// 器の位置決め＝geoedit の .ge-panel.ge-dialog（ツールバー直下の中央・一枠）。見た目は器（.oj-cloud）が自給＝同じ黒硝子。
import { cloudPanel as sharedCloudPanel } from "../cloud.js";

const isScenes = name => /\.scenes(\.gz)?$/i.test(name);

// hooks = { getPbf: async()=>pbf|null（書き出しと同じ口）, loadBuffer: async(ArrayBuffer)=>void, map（サムネ撮影用） }
export function cloudPanel(container, hooks, toast) {
	container.querySelector(".ge-dialog")?.remove();   // 書き出しダイアログと同じ一枠（二重開き防止）
	return sharedCloudPanel(container, {
		className: "ge-panel ge-dialog ge-cloud",
		getFile: async () => { const pbf = await hooks.getPbf(); return pbf ? pbf.geopbfFile() : null; },   // 書き出しと同じエンコード
		open: async buf => { await hooks.loadBuffer(buf); return true; },
		accept: name => !isScenes(name),
		defaultName: () => `edit-${new Date().toISOString().slice(0, 10)}.geopbf`,
		ext: ".geopbf",
		contentType: "application/x-geopbf",
		works: true,
		map: hooks.map,
		overlayEl: () => hooks.map?.mapEl?.querySelector(".ge-overlay"),   // @シンボル・帯・blur＝作品の見た目はここに乗っている
	}, toast);
}
