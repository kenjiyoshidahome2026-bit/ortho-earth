import * as d3 from 'd3';
import './tip.scss';
const tostr = s => s? s instanceof Element? s.outerHTML:
    typeof s == 'function'? s():
    Array.isArray(s)? s.map(trim).filter(t=>t).join("<br/>"): s: null;
d3.selection.prototype.tip = function(s) { return tip(this, s); };
d3.selection.prototype.pop = function(s) { return this.each(function(t,i){ d3.select(this).on("click",e=>pop(e, isFunction(s)?(()=>s(t,i)):s))}); };
export const cleanup = function() { d3.select(".overlap-tooltip").hide();
    d3.selectAll(".popup-frame").remove(); d3.selectAll(".popup-content").hide();
};
function tip(target, s) {
    const body = d3.select("body");
    let tooltip = body.select(".overlap-tooltip");
    tooltip.node() || (tooltip = body.append("div").classed("overlap-tooltip", true).classed("hidden", true));
    let leave = () => tooltip.hide();
    let enter = async () => { var ss = await tostr(s);  ss? tooltip.html(ss): leave(); };
    let move = e => { e.stopPropagation();
        const v = tooltip.node().getBoundingClientRect();
        let [w,h] = [v.width, v.height];
        let [W,H] = [window.innerWidth, window.innerHeight];
        let [x,y] = e.touches?[e.touches[0].pageX, e.touches[0].pageY]:[e.pageX, e.pageY];
        let osx = e.touches? 40: 15, osy = -h/2;
        s && tooltip.show()
        .style("left",(x + osx + w > W? x - w - osx: x+osx)+"px")
        .style("top",((y + osy < 0)? 0:(y + h +osy > H)? H - h:y +osy)+"px");
    };
    body.on("touchend.tip",leave);
    return target.on("mouseenter.tip",enter).on("mousemove.tip",move).on("mouseleave.tip",leave).on("click.tip", leave)
        .on("mousedown.tip",leave).on("mouseup.tip",leave).on("dragstart.tip", leave)
        .on("touchstart.tip",enter,{passive:true}).on("touchmove.tip",move,{passive:true}).on("touchend.tip",leave,{passive:true});
};
async function pop(e, s) {
    const body = d3.select("body");
    const rx = 8, ry = 8;
    let [x,y] = e.touches?[e.touches[0].pageX, e.touches[0].pageY]:[e.pageX, e.pageY];
    let content = body.append("div").classed("popup-content",true);
    content.node().appendChild(await tostr(s));
    let [W,H] = [window.innerWidth, window.innerHeight];
    let [w,h] = [+content.style("width").replace(/px$/,"")+40, +content.style("height").replace(/px$/,"")+50];
    let frame = body.append("div").classed("popup-frame",true);
    frame.style("width", w+"px").style("height", h+"px");
    frame.style("top", (y + (y < h?0:-h))+"px").style("left",((x < w/2)?0:(x + w/2 > W)?W-w:x-w/2)+"px");
    frame.on("click",e=>{ e.stopPropagation(); frame.hide()});
    let svg = frame.append("svg");
    frame.node().appendChild(content.node());
    content.style("top",(y<h?30:20)+"px").style("left",(20)+"px");//.style("color",fg);
    let x1 = (x < w/2)? x:(x + w/2 > W)?(w-W+x):w/2;
    let x2 = (x < w/2)? Math.max(30-x, -10):(x + w/2 > W)?Math.min(W-x-50,-10):-10;
    let d = "M"+x1+" "+(y<h?0:h)+"l"+x2+" "+(y<h?20:-20)+"h20z"
    svg.append("rect").attr("x",10).attr("y",y < h?20:10).attr("rx",rx).attr("ry",ry).attr("width",w-20).attr("height",h-30);//.attr("fill",bg)
    svg.append("path").attr("d",d);//.attr("fill",bg);
}