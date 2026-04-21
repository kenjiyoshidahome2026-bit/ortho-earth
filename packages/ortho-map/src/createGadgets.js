import * as d3 from 'd3';
import "common/d3/selection.js";
import { leftPanel, rightPanel, layers, zoom, north, cpos, full, shot, print, measure } from "./modules/gadget1.js"
import { explain, legend, loading, tip, pop, contextmenu } from "./modules/gadget2.js";

export function createGadgets(map) {
    const appendFrame = (name, parent) => map[name] = map[name] || map[parent].append("div").attr("name", name);
    const prependFrame = (name, parent) => map[name] = map[name] || map[parent].prepend("div").attr("name", name);
    function underlaysFrames() {
        appendFrame("whiteEarth", "base");
        map.whiteEarth.appendNode(map.mapFrame.node());
    }
    appendFrame("overlays", "mapFrame");
    map.addFrame = (name, v) => ({
        leftFrame: v => (underlaysFrames(), prependFrame("leftFrame", "whiteEarth"), map.leftFrame.css({ width: v + "px" })),
        rightFrame: v => (underlaysFrames(), prependFrame("rightFrame", "whiteEarth"), map.rightFrame.css({ width: v + "px" })),
        leftTop: () => prependFrame("leftTop", "overlays"),
        rightTop: () => prependFrame("rightTop", "overlays"),
        leftBottom: () => prependFrame("leftBottom", "overlays"),
        rightBottom: () => prependFrame("rightBottom", "overlays"),
        popPlane: () => appendFrame("popPlane", "overlays"),
        modalFrame: () => appendFrame("modalFrame", "overlays")
    }[name](v));
    map.removeFrame = name => map[name] && (map[name].remove(), map[name] = null);
    ////-----------------------------------------------------------------------------------		
    map.gadget = function (name, func) {
        typeof name == 'function' && name.name && (func = name, name = func.name);
        map.gadget[name] = function () { return func.apply(map, arguments) }
    };
    const gadgets = {
        leftPanel, rightPanel, layers, zoom, north, cpos, full, shot, print, measure,// (1)
        explain, legend, loading, tip, pop, contextmenu
    };
    Object.entries(gadgets).forEach(t => map.gadget(...t));
    ////-----------------------------------------------------------------------------------		
    map.onDrawing("overlays", () => map.overlays.showIF(map.isEditable()));
    map.overlays.showIF(map.isEditable());
    map.onResize("overlays", resize); resize();
    function resize() {
        const narrow = map.isNarrow ? 20 : 0;
        map.leftTop && map.leftTop.style("top", (narrow + 5) + "px");
        map.rightTop && map.rightTop.style("top", (narrow + 5) + "px");
        map.leftBottom && map.leftBottom.style("bottom", (narrow + 30) + "px");
        map.rightBottom && map.rightBottom.style("bottom", (narrow + 30) + "px");
    }
}