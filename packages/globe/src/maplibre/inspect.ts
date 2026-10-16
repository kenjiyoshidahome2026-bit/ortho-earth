// MapLibre の口（src/maplibre/・公式例の門 §8）の検査表示＝maplibre-gl-inspect の MaplibreInspect と同じ形（#174・本人裁定＝互換クラスを出す）。
// `map.addControl(new MaplibreInspect({ ... }))` の書き方そのまま。中身はこの地図の検査表示ガジェット（map.gadget.inspect）への通訳だけ：
//   ・ボタン＝MapLibre の四隅の IControl（公式と同じ class＝maplibregl-ctrl-icon maplibregl-ctrl-inspect／検査中は maplibregl-ctrl-map）。見た目は頁の maplibre-gl-inspect.css
//   ・オプションは同じ名前のままガジェットへ渡す（ガジェット側のボタンは出さない＝showInspectButton:false）
//   ・通訳の地図（new Map）でもエンジンの地図（createGlobe）でも載る。準備前の addControl はエンジンを待って載せる
import { whenEngine } from "./map.ts";
import type { GlobeMap } from "../types/map.ts";
import type { InspectHandle, InspectOptions } from "../../globe.d.ts";

export class MaplibreInspect {
	declare options: InspectOptions;
	declare _ctl: InspectHandle | null;
	declare _map: object | null;
	declare _container?: HTMLElement;
	declare _btn?: HTMLButtonElement;
	constructor(options: InspectOptions = {}) { this.options = { showInspectButton: true, ...options }; this._ctl = null; this._map = null; }
	getDefaultPosition(): string { return "top-right"; }
	onAdd(map: object): HTMLElement {
		this._map = map;
		const c = this._container = document.createElement("div");
		c.className = "maplibregl-ctrl maplibregl-ctrl-group";
		if (this.options.showInspectButton) {
			const b = this._btn = document.createElement("button");
			b.type = "button"; b.className = "maplibregl-ctrl-icon maplibregl-ctrl-inspect"; b.title = "Toggle Inspect"; b.setAttribute("aria-label", "Toggle Inspect");
			b.addEventListener("click", () => this.toggleInspector());
			c.appendChild(b);
		} else c.style.display = "none";
		const own = this._map;
		(typeof (map as { gadget?: unknown }).gadget === "function" ? Promise.resolve(map as GlobeMap) : whenEngine(map)).then(eng => {
			if (!eng || this._map !== own) return;
			const cb = this.options.toggleCallback;
			this._ctl = eng.gadget.inspect({ ...this.options, showInspectButton: false, toggleCallback: (on: boolean) => {
				if (this._btn) this._btn.className = `maplibregl-ctrl-icon ${on ? "maplibregl-ctrl-map" : "maplibregl-ctrl-inspect"}`;   // 公式の setMapIcon／setInspectIcon
				cb?.(on);
			} });
		});
		return c;
	}
	onRemove(): void { this._ctl?.destroy(); this._ctl = null; this._container?.remove(); this._map = null; }
	toggleInspector() { return this._ctl?.toggle(); }
	render() { return this._ctl?.render(); }   // 公式の render＝検査の層を作り直す（source を足した後など）
}
