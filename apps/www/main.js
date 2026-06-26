import * as d3 from "d3";
import './main.scss';
import orthoMap from 'ortho-map';
import { setApiUrl } from "geopbf";
//------------------------------------------------------
const API_BASE = "https://api.ortho-earth.com";
const TILER_BASE = "https://tiler.ortho-earth.com";
setApiUrl(API_BASE);
d3.select(".logo").html(`${await (await fetch("/favicon.svg")).text() }Ortho Earth`);
const zoom = Math.log2(Math.min(window.innerWidth, window.innerHeight)/2*0.8 / 256 * Math.PI * 2);
const mapInst = await orthoMap({target:d3.select('#mapContainer'), center:[0,0], zoom, apiUrl: API_BASE, tilerBase: TILER_BASE});
const exitButton = mapInst.append("button").attr("class", "close").html(`<img src="close.svg"/>`).on("click", exitDemo).hide();
await initDemo(mapInst);
d3.select('#execDemo').on('click', execDemo);
d3.select('#showDocs').on('click', showDocs);
d3.select('body').on('keydown.demo', e => { if (e.key === 'Escape') exitDemo(); });
//------------------------------------------------------
async function initDemo(map) {
	map.explain = map.gadget.explain({ width: 300 });
	map.gadget.loading();//ファイル読み込み中表示
	map.gadget.layers({big:true});//レイヤーの切り替え
	map.isNarrow() || map.gadget.zoom();//ズームイン・ズームアウト
	map.isNarrow() || map.gadget.full();//全画面表示
	map.gadget.north();//北向きに修正
	map.gadget.shot();//スクリーンショット
	map.isNarrow() || map.gadget.print();//印刷
	map.gadget.cpos();//現在地表示
	map.gadget.measure();//距離測定
	const mess = `This is the demonstration for orthographic renderer platfrom.
	You can draw your own geo features. Mousedown for "pan", scroll for "scaling" and (^|⌘)+scroll for "rotate".`
	map.explain(`<h3 translate="no">Ortho Earth Demo</h3><p>${mess}</p>`);
	exitDemo();
}
function execDemo() {
	mapInst.autoRotate(false);
	exitButton.show();
	d3.select('#demoOverlay').style("opacity",0).style("pointer-events",'none');
}
function exitDemo() {
	mapInst.setView([0,0], zoom);
	mapInst.autoRotate(true);
	exitButton.hide();
	d3.select('#demoOverlay').style("opacity",1).style("pointer-events",'auto');
}
function showDocs() { open('/docs/', '_blank'); }