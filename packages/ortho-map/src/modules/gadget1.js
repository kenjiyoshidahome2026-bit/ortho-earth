import * as d3 from 'd3';
import "common/d3/selection.js";
import html2canvas from 'html2canvas';
import { datimArray, download } from "common";
import { cleanup } from "common/d3/tip-pop.js"
import { createPolygon } from "common";
import { gadgetIcons, tooltips } from "../modules/icons.js"
import { Layers } from "./layers.js";

function createButton(map, name, opts) {
    const icon = opts.icon || gadgetIcons[name]||"<svg/>";
    const tip = opts.tip || tooltips[map.lang][name]||"";
    const target = map.addFrame(opts.target || "leftTop"); if (!target) return console.error("Frame Error");
    var btn = target.append("button").classed("gadget", true).classed("big", opts.big).html(icon).tip(tip);
    btn.icon = s => btn.html(gadgetIcons[s]).tip(tooltips[map.lang][s]);
    btn.tooltip = s => btn.tip(s);
    btn.onClick = func => btn.on("click", e => (e.stopPropagation(), func(e)));
    return btn;
}
////--------------------------------------------------------- 背景地図の変更
export async function layers(opts = {}) {
    const map = this, name = "layers";
    const btn = createButton(map, "layer", opts);
    const listArea = map.overlays.append("div").attr("name", "Layers").classed("noprint", "true").hide();
    listArea.on("mousemove touchmove", e => e.stopPropagation(), { passive: true });
    map.onClick(() => (listArea.shrinkHide(btn), btn.classed("flip", false)));
    btn.onClick(() => {
        let flip = btn.classed("flip");
        btn.classed("flip", !flip); if (!btn.classed("flip")) return listArea.shrinkHide(btn);
        listArea.empty().selectAll("button").data(Object.values(Layers)).enter().append("button").classed("gadget", true)
            .text(d => d.trans(map.lang)).classed("flip", d => d.name === map.baseName)
            .on("click", (e, d) => {
                e.stopPropagation(); if (d.name === map.baseName) return;
                listArea.shrinkHide(btn); btn.classed("flip", false);
                map.setBase(d.name);
            });
        listArea.resumeShow(btn)
    });
}
/////--------------------------------------------------------- パネル開閉関数の生成(flag:true => 右, flag:false => 左)
const createPanel = flag => function (opts = {}) {
    const map = this, width = Math.min(opts.width || 300, map.width) + 30;
    const C = map.mapFrame;
    const [name, rname, tip, move] = flag ? ["right", "left", "closeR", -width] : ["left", "right", "closeL", width];
    let left = 0, right = 0, trans = 0;
    const ease = opts.ease || d3.easeCubic, duration = opts.duration || 1000;
    opts.target = opts.target || name + "Top";
    map.addFrame(name + "Frame", width);
    const btn = createButton(map, rname, opts).onClick(e => opts.active ? active() : modal());
    return map[name + "Frame"].append("div").classed("content", true);
    async function panel(w, resize_flag) {
        return new Promise(resolve => {
            if (resize_flag && !w) {
                left && C.style("left", 0); right && C.style("right", 0);
                C.style("transform", `translateX(${left - right}px)`);
                left = right = 0; map.resize();
            }
            C.transition().ease(ease).duration(duration).style("transform", `translateX(${trans = w}px)`)
                .on("end", () => {
                    if (resize_flag && w) {
                        C.style("transform", `translateX(${trans = 0}px)`).style(name, Math.abs(w) + "px");
                        (w > 0) ? (left = w) : (right = -w); map.resize();
                    }
                    resolve();
                });
        })
    }
    async function modal() {
        const revoke = e => { e.stopPropagation(); panel(0, false).then(() => (map.removeFrame("modalFrame"), cleanup(), btn.show())); }
        map.addFrame("modalFrame").tip(tooltips[map.lang][tip]).on("click", revoke); btn.hide();
        await panel(move, false);
    }
    async function active() {
        const revoke = e => panel(0, true).then(() => btn.icon(rname).onClick(active));
        await panel(move, true); btn.icon(name).tooltip(tooltips[map.lang][tip]).onClick(revoke);
    }
};

////--------------------------------------------------------- 左右パネル開閉
export const leftPanel = createPanel(false);
export const rightPanel = createPanel(true);
////--------------------------------------------------------- 地図のズームイン・ズームアウト
export async function zoom(opts = {}) {
    const map = this, name = "zoom";
    const mag = opts.mag || 2, duration = opts.duration || 1000;
    createButton(map, "plus", opts).classed("upper", true).onClick(zoomin);
    createButton(map, "minus", opts).classed("lower", true).onClick(zoomout);
    async function zoomin() { await map.mag(mag, duration); return false; }
    async function zoomout() { await map.mag(1 / mag, duration); return false; }
}
////--------------------------------------------------------- 地図の全画面表示
export async function full(opts = {}) {
    const map = this, name = "full";
    const fullScreen = () => document.body.requestFullscreen && document.body.requestFullscreen();
    const resumeScreen = () => document.exitFullscreen && document.exitFullscreen();
    const zout = createButton(map, "zout", opts).onClick(fullScreen);
    const zin = createButton(map, "zin", opts).onClick(resumeScreen).hide();
    map.onResize(name, () => {
        const flag = screen.width == window.innerWidth;
        zin.showIF(flag); zout.showIF(!flag);
    });
}
////--------------------------------------------------------- 地図を北に向ける
export async function north(opts = {}) {
    const map = this, name = "north";
    const duration = opts.duration || 1000;
    const btn = createButton(map, "north", opts).onClick(() => map.north(duration));
    const svg = btn.select("svg");
    map.onDrawing(name, () => svg.style("transform", "rotate(" + (-map.proj.rotate()[2]) + "deg)"));
}
////--------------------------------------------------------- 現在地表示
export async function cpos(opts = {}) {
    const map = this, name = "cpos";
    const blink = `
	<svg name="cpos" viewBox="0 0 50 50" xmlns="http://www.w3.org/2000/svg">
		<circle cx="25" cy="25" r="20" fill="none" stroke="#800" stroke-width="4">
			<animate attributeName="r" values="10;25;10" dur="2s" repeatCount="indefinite"/>
			<animate attributeName="opacity" values="1;0;1" dur="2s" repeatCount="indefinite"/>
		</circle>
		<circle cx="25" cy="25" r="8" fill="#fff" stroke="c#00" stroke-width="2"/>
		<circle cx="25" cy="25" r="4" fill="#c00"/>
	</svg>`;
    let flag = false, cpos = [0, 0];
    const svg = (new DOMParser()).parseFromString(blink, 'image/svg+xml').documentElement;
//    console.log(map.overlays, svg)
    map.overlays.appendNode(svg);
    const target = map.select("svg[name=cpos]").hide();
    const btn = createButton(map, "cpos", opts).onClick(async () => {
        btn.classed("flip", flag = !btn.classed("flip"));
        target.showIF(flag);
        if (flag) {
            cpos = await getCurrentPosition() || cpos;
            await map.flyToFeature({ type: "Point", coordinates: cpos }, { keep: true });
        }
    });
    map.onDrawing(name, draw);
    async function getCurrentPosition() {
        return new Promise(resolve => {
            let success = q => q.coords && resolve([q.coords.longitude, q.coords.latitude]);
            let fail = () => { console.warn("getCurrentPosition error"); resolve(null); };
            let opt = { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 };
            navigator.geolocation.getCurrentPosition(success, fail, opt);
        })
    };
    function draw() {
        if (!flag) return;
        const p = map.tester(cpos); if (!p) return target.hide();
        const [left, top] = p; target.show().css({ left, top });
    }
}
////--------------------------------------------------------- スクリーンショット
async function map2canvas(map, dpr) {
    dpr = dpr || window.devicePixelRatio || 1;
    const width = map.width * dpr, height = map.height * dpr;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    map.mapFrame.selectAll("canvas")
        .each(function () { ctx.drawImage(this, 0, 0, this.width, this.height, 0, 0, width, height); });
    const v = await html2canvas(map.overlays.node(), {
        ignoreElements: el => el.tagName === 'BUTTON' || el.classList.contains("noprint"),
        scale: dpr, backgroundColor: null, useCORS: true, allowTaint: true
    });
    ctx.drawImage(v, 0, 0, v.width, v.height, 0, 0, width, height);
    return canvas;
}
////--------------------------------------------------------- スクリーンショットのダウンロード
export function shot(opts = {}) {
    const map = this, name = "shot";
    createButton(map, name, opts).onClick(() => map2canvas(map).then(downloadCanvas));
    async function downloadCanvas(canvas) {
        const name = `screen-shot-${datimArray().join("-")}-${canvas.width}x${canvas.height}.webp`;
        download(new File([await canvas.convertToBlob({ type: "image/webp" })], name, { type: "image/webp" }));
    }
}
////--------------------------------------------------------- 印刷 (パネルが閉じた時のみ表示)
export function print(opts = {}) {
    const map = this, name = "print";
    createButton(map, name, opts).onClick(() => map2canvas(map, 3).then(printCanvas));
    async function printCanvas(canvas) {
        const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: "image/png" }) :
            canvas.toBlob ? await new Promise(r => canvas.toBlob(r)) : await (await fetch(canvas.toDataURL("image/png"))).blob();
        const url = URL.createObjectURL(blob);
        const win = window.open('', '_blank', 'width=1000,height=800');
        if (!win) { alert("ポップアップがブロックされました。"); return; }
        const htmlContent = `
        <head>
            <title>OrthoEarthPrint</title>
            <style>
                @page { size: landscape; margin: 0; }
                html, body { margin: 0 !important; padding: 0 !important; width: 100vw; height: 100vh; overflow: hidden !important; background: white; }
                #wrapper { width: 100vw; height: 100vh; display: flex; justify-content: center; align-items: center; overflow: hidden; }
                img { display: block; box-shadow: none; border: none; }
                img.landscape { width: 98vw; height: 98vh; object-fit: contain; }
                img.portrait { transform: rotate(-90deg); width: 95vh; height: 95vw; object-fit: contain; }
            </style>
        </head>
        <body>
            <div id="wrapper">
                <img src="${url}" class="${canvas.height > canvas.width ? 'portrait' : 'landscape'}" onload="window.print(); window.close();">
            </div>
        </body>`;
        win.document.documentElement.innerHTML = htmlContent;
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}
////--------------------------------------------------------- 距離・面積を測定
export function measure(opts = {}) {
    const map = this;
    const btn = createButton(map, "measure", opts).onClick(() => {
        let layer = ((map.getLayer("measure") || map.createLayer({ name: "measure", append: map.overlays }))).show();
        (btn.toggleClass("flip") ? setMeasure : clearMeasure)();
        async function setMeasure() {
            map.cancelEvent("Click");
            createPolygon(layer, { color: opts.color || "#880000", width: opts.width || 1, radius: [3, 1], measure: true });
        }
        function clearMeasure() {
            layer.exit();
            map.removeLayer("measure");
            map.restoreEvent("Click");
        }
    });
}
