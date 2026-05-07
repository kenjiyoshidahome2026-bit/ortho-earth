import * as d3 from "d3";
import "common/d3/selection.js";
import './style.scss';
import { orthoEarth } from 'ortho-map';

const mapContainer = d3.select('#mapContainer');
const demoOverlay = d3.select('#demoOverlay');
const execDemo = d3.select('#execDemo');
const exitDemo = d3.select('#exitDemo').hide();
const main = demoOverlay.select('main');
d3.select('#btn-docs').on('click', () => window.location.href = '/docs/');

let timer;
const mapInst = await orthoEarth({target:mapContainer});
await initDemo();
execDemo.on('click', startDemo);
exitDemo.on('click', endDemo);

async function initDemo() {
	mapInst.explain = mapInst.gadget.explain({ width: 300 });
	mapInst.gadget.loading();//ファイル読み込み中表示
	mapInst.gadget.layers({big:true});//レイヤーの切り替え
	mapInst.isNarrow() || mapInst.gadget.zoom();//ズームイン・ズームアウト
	mapInst.isNarrow() || mapInst.gadget.full();//全画面表示
	mapInst.gadget.north();//北向きに修正
	mapInst.gadget.shot();//スクリーンショット
	mapInst.isNarrow() || mapInst.gadget.print();//印刷
	mapInst.gadget.cpos();//現在地表示
	mapInst.gadget.measure();//距離測定
	const mess = `This is the demonstration for orthographic renderer platfrom.
	You can draw your own geo features. Mousedown for "pan", scroll for "scaling" and (^|⌘)+scroll for "rotate".`
	mapInst.explain(`<h3 translate="no">Ortho Earth Demo</h3><p>${mess}</p>`);
	endDemo();
}
function startDemo() {
    timer && timer.stop();
	exitDemo.show();
	mapInst.overlays.style("opacity",1);
	demoOverlay.style("opacity",0).style("pointer-events",'none');
	main.style("transform", 'translateY(-20px)');
	exitDemo.style("visibility","visible");
}
function endDemo() {
	exitDemo.hide();
	mapInst.setView([0,0],3);
	mapInst.overlays.style("opacity",0);
	demoOverlay.style("opacity",1).style("pointer-events",'auto');
	main.style("transform",'translateY(0)');
	exitDemo.style("visibility","none");
	setTimeout(autoRotate, 100);
	function autoRotate() {
		const velocity = 0.01;
		timer = d3.timer((elapsed) => {
			const r = mapInst.proj.rotate();
			mapInst.proj.rotate([elapsed * velocity, r[1], r[2]]);
			mapInst.draw();
		});
	}
}

