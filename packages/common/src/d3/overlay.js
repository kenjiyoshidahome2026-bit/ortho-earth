import * as d3 from 'd3';
import {createAutocomplete} from 'd3-autocomplete';
import './d3-overlay.scss';

d3.emoji = _ => `<span class="emoji">&#x${_};</span>`;
d3.comma = _ => { for (_=(new String(_)).replace(/,/g,""); _!=(_=_.replace(/^(-?\d+)(\d{3})/,"$1,$2"));){}; return _; };

d3.selection.prototype.show = function() { return this.classed("hidden", false); };
d3.selection.prototype.hide = function() { return this.classed("hidden", true); };
d3.selection.prototype.toggle = function() { return this.classed("hidden", !this.classed("hidden")); };
d3.selection.prototype.showIF = function(flag) { return this.classed("hidden", !flag); };
d3.selection.prototype.isVisible = function() { return !this.classed("hidden"); };

d3.selection.prototype.shrinkHide = function(target, opts) { return shrinkHide(this, target, opts); };
d3.selection.prototype.resumeShow = function(target, opts) { return resumeShow(this, target, opts); };

d3.overlay = overlay();

function clone(dom, target) {
    if (target && target.node) target = target.node();
    const div = document.createElement("div");
    div.appendChild(dom.cloneNode(true));
    dom.parentNode.appendChild(div);

    const setOrigin = () => {
        if (!target) return "50% 50%";
        const tr = target.getBoundingClientRect();
        const dr = div.getBoundingClientRect();
        const ox = (tr.left + tr.width / 2) - dr.left;
        const oy = (tr.top + tr.height / 2) - dr.top;
        return `${ox}px ${oy}px`;
    };

    return d3.select(div)
        .classed("overlay-fullbody", true)
        .style("transform-origin", setOrigin());
}
function shrinkHide(selection, target, opts = {}) {
    const cover = clone(selection.node(), target);
    selection.hide();
    return new Promise(resolve => {
        cover.transition()
            .ease(opts.ease || d3.easeCubic)
            .duration(opts.trans || 500)
            .style("transform", "scale(0)")
            .on("end", () => {
                cover.remove();
                if (opts.fallback) opts.fallback(selection);
                resolve(selection);
            });
    });
}
function resumeShow(selection, target, opts = {}) {
    selection.show();
    const cover = clone(selection.node(), target).style("transform", "scale(0)");
    selection.hide();
    return new Promise(resolve => {
        cover.transition()
            .ease(opts.ease || d3.easeCubic)
            .duration(opts.trans || 500)
            .style("transform", "scale(1)")
            .on("end", () => {
                selection.show();
                cover.remove();
                if (opts.fallback) opts.fallback(selection);
                resolve(selection);
            });
    });
}

function overlay() {
    // 共通のベース生成処理
    const createBase = (className, html) => {
        const plane = d3.select("body").append("div").classed("overlay-fullbody", true);
        const div = plane.append("div")
            .classed("overlay-contents", true)
            .classed(className, true)
            .html(html);
        
        // サイズの固定（リフロー防止）
        const rect = div.node().getBoundingClientRect();
        div.style("width", `${rect.width}px`).style("height", `${rect.height}px`);
        div.classed("centered", true);
        
        return { plane, div };
    };

    const overlay = (html, className, target) => {
        const { plane, div } = createBase(className, html);
        
        // ターゲットがあればアニメーション開始
        if (target) div.resumeShow(target);

        // 拡張メソッドの定義
        div.parent = plane;
        div.fit = () => {
            div.classed("centered", false).style("width", "auto").style("height", "auto");
            const r = div.node().getBoundingClientRect();
            div.style("width", `${r.width - 20}px`).style("height", `${r.height - 20}px`);
            div.classed("centered", true);
        };

        div.clear = async () => {
            await div.shrinkHide(target);
            plane.remove();
        };

        return div;
    };

    // --- 各種プリセットメソッド ---

    overlay.notice = (mess, time = 1000, target) => {
        const div = overlay(mess, "notice", target);
        setTimeout(() => div.clear(), time);
    };

    // Alert / Warn の統合
    const dialog = (mess, type) => new Promise(resolve => {
        const icon = type === "warn" ? d3.emoji("26A0") : "";
        const div = overlay(`${icon}${mess}`, type);
        div.parent.on("click", () => div.clear().then(resolve));
    });

    overlay.alert = mess => dialog(mess, "alert");
    overlay.warn  = mess => dialog(mess, "warn");
    overlay.wait  = (mess = "Wait a moment!") => overlay(`${d3.emoji("23F3")}${mess}`, "wait");

    // ボタン選択系の統合 (Confirm / Execute)
    overlay.execute = (mess, obj, target, fallback = null) => new Promise(resolve => {
        const buttons = Object.keys(obj).map(k => `<button class="btn-${k}">${k}</button>`).join("");
        const div = overlay(`${mess}<hr/>${buttons}`, "execute", target);
        
        if (fallback) fallback(div);

        Object.entries(obj).forEach(([key, func]) => {
            div.select(`.btn-${key}`).on("click", async () => {
                const res = await func();
                await div.clear();
                resolve(res);
            });
        });
    });

    overlay.confirm = (mess, yes = "YES", no = "NO", target) => {
        return overlay.execute(mess, { [yes]: () => true, [no]: () => false }, target);
    };

    overlay.prompt = (mess, list, exec = "EXEC", cancel = "CANCEL") => new Promise(resolve => {
        const isList = Array.isArray(list) && list.length > 1;
        const html = `${mess}<br/><input ${isList ? 'list="prompt-ac"' : ''}/><hr/>
                      <button class="exec">${exec}</button><button class="cancel">${cancel}</button>`;
        const div = overlay(html, "prompt");
        const input = div.select("input");

        if (isList) {
            let dl = d3.select("datalist#prompt-ac");
            if (dl.empty()) dl = d3.select("body").append("datalist").attr("id", "prompt-ac");
            dl.selectAll("option").data(list).join("option").attr("value", d => d);
        } else if (list) {
            input.property("value", list);
        }

        input.node().focus();

        const doExec = () => div.clear().then(() => resolve(input.property("value")));
        const doCancel = () => div.clear().then(() => resolve(null));

        input.on("keydown", e => { if (e.key === "Enter") doExec(); });
        div.select(".exec").on("click", doExec);
        div.select(".cancel").on("click", doCancel);
    });
    overlay.modernPrompt = (mess, list) => new Promise(resolve => {
        const div = d3.overlay(`${mess}<br/><div id="ac-target"></div><hr/><button class="cancel">Cancel</button>`, "prompt");
            const ac = createAutocomplete("#ac-target", {
            items: list,
            onSelect: (val) => {
                div.clear().then(() => resolve(val));
            }
        });
        div.select(".cancel").on("click", () => div.clear().then(() => resolve(null)));
        ac.input.node().focus();
    });
    return overlay;
}