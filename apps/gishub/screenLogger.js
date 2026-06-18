import * as d3 from "d3";
import "common/d3/selection";
import { comma, isArray, isString, isNumber, isObject, isBlob, unique, concat } from "common";
import "./screenLogger.scss";
export class screenLogger {
	constructor (div) {
		this.target = div.classed("log", true); this.time = performance.now();
		this.dots = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		this.bars = {};
		this.mess = {};
		this._ac = new AbortController();
		const { signal } = this._ac;
		addEventListener("FetchStart",    e => this.progress("start", e),    { signal });
		addEventListener("FetchProgress", e => this.progress("progress", e), { signal });
		addEventListener("FetchEnd",      e => this.progress("end", e),      { signal });
		addEventListener("ConvertStart",  e => this.event("start", e),       { signal });
		addEventListener("ConvertEnd",    e => this.event("end", e),         { signal });
	}
	destroy() { this._ac.abort(); this.clear(); }
	hide() { this.target.hide(); return this; }
	show() { this.target.show(); return this; }
	clear() { this.target.empty(); return this; }
	empty() { const div = this.target, p = div.append("p");
		requestAnimationFrame(() => div.node().scrollTop = div.node().scrollHeight);
		return p;
	}
	log(...a) {
		const toS = _ => isString(_)? _.replace(/\n/g,"<br/>"): isNumber(_)? comma(_): JSON.stringify(_);
		const o2a = o => {
			const a = unique(concat(o.map(t=>Object.keys(t))));
			const b = o.map(t=> a.map(v=>t[v]||""));
			return [a].concat(b);
		};
		const isImageBlob = _ => isBlob(_) && _.type.match(/^image/);
		const p = this.empty();
		if (a.length == 1) { a = a[0];
			if (isArray(a) && a.length > 1) {
				if (a.every(isObject)) a = o2a(a);
				if (a.every(isArray)) { const table = p.append("table");
					a.forEach(t=>{ const tr = table.append("tr");
						t.forEach(t=>tr.append("td").text(t).classed("right", isNumber(t)))
					});
					return p;
				}
			} else if (isImageBlob(a)) {
				return p.append("img").attr("src", URL.createObjectURL(a));
			} else if (isObject(a)) {
				const dl = p.append("dl");
				Object.entries(a).forEach(([k, v]) => {
					dl.append("dt").text(k);
					dl.append("dd").html(toS(v));
				});
				return p;
			}
			return p.append("span").html(toS(a));
		}
		a.forEach(t=>p.append("span").html(toS(t)));
		return p;
	}
	progress(type, e) {
		const { name, loaded, total, size } = e.detail;
		if (type === "start") { if (this.bars[name]) return;
			const bar = this.empty().classed("progress", true).text("⏳ " + name)
			this.bars[name] = [bar, performance.now(), 0];
		} else if (type === "progress" && this.bars[name]) {
			const bar = this.bars[name][0], count = this.bars[name][2] = this.bars[name][2]+1;
			const d = this.dots[~~(count/10) % this.dots.length];
			let p, info;
			if (total) {
				const pct = Math.round((loaded / total) * 100), n = Math.floor(pct / 5);
				p = `<span class='done'>${"█".repeat(n)}</span><span class='rest'>${"█".repeat(20 - n)}</span>`;
				info = `${pct}% (${comma(loaded)}/${comma(total)})`;
			} else {
				const pos = count % 17;
				p = `<span class='rest'>${"░".repeat(pos)}</span><span class='done'>████</span><span class='rest'>${"░".repeat(16 - pos)}</span>`;
				info = `${comma(loaded)} bytes`;
			}
			bar.html(`⏳ ${name}: ${d}[${p}] ${info}`);
		} else if (type === "end" && this.bars[name]) {
			const bar = this.bars[name][0], start = this.bars[name][1];
			const time = ((performance.now() - start)/1000).toFixed(3);
			const speed = comma(((size||total) / time / 1024 / 1024).toFixed(2));
			bar.text(`⏳ ${name}: ${comma(size||total)} bytes / ${comma(time)}sec (${speed} Mbytes/sec)`);
			delete this.bars[name];
		}
	}
	event(type, e) {
		const { name, event, error } = e.detail;
		if (type === "start") { if (this.mess[name]) return;
			let count = 0;
			const bar = this.empty().classed("event", true).html(`🔄 ${name}: ${event} <span id="spinner"/>`);
			const spinner = bar.select("#spinner");
			const updateSpinner = () => spinner.text(this.dots[~~(count++) % this.dots.length]);
			const timer = setInterval(updateSpinner, 250);
			this.mess[name] = [bar, performance.now(), timer];
		} else if (type === "end" && this.mess[name]) {
			const [bar, start, timer] = this.mess[name];
			clearInterval(timer);
			const time = ((performance.now() - start) / 1000).toFixed(3);
			!error ? bar.text(`🔄 ${name}: ${event} (${comma(time)}sec)`) : this.error(error);
			delete this.mess[name];
		}
	}
	warn(s) { this.empty().classed("warn", true).text(`⚠️ [WARNING] ${s}`); }
	error(s) { this.empty().classed("error", true).text(`❌ [ERROR] ${s}`); }
	title(s,sub="") { const p = this.empty().classed("title", true).html(`<span class="title">✨ ${s} ✨</span><span class="subtitle">${sub}</span>`);
		this.time = performance.now();
		return p;
	}
	success(s) { const time = ((performance.now() - this.time)/1000).toFixed(3);
		this.empty().classed("success", true).text(`✅ [SUCCESS] ${s} (${comma(time)}sec)`);
	}
    async prompt(s, def = "") {
        return new Promise(resolve => {
            const p = this.empty().classed("prompt", true);
            p.append("span").text(`> ${s} ? `);
            const ans = p.append("span").classed("answer", true).attr("contenteditable", true);
            if (def) ans.text(def);
            const btn = p.append("button").text("OK").style("margin-left", "10px");
            const submit = () => {
                const result = ans.text().trim();
                ans.attr("contenteditable", false);
                btn.remove();
                resolve(result || def);
            };
            btn.on("click", submit);
            ans.on("keydown", e => { if (e.key === "Enter") { e.preventDefault(); submit(); }});
            const node = ans.node();
            node.focus();
            if (def) {
                const range = document.createRange();
                range.selectNodeContents(node);
                window.getSelection().removeAllRanges();
                window.getSelection().addRange(range);
            }
        });
    }
	async select(s, sel) { return new Promise(resolve => { let idx = 0;
		sel = isArray(sel) ? sel.map(t=>isArray(t)?t:[t,t]) : Object.entries(sel);
		const p = this.empty().classed("select", true).append("span").text(`> ${s} ? `);
		p.append("div").classed("select-buttons", true).selectAll("button").data(sel).join("button")
		.each((d, i, nodes) => d3.select(nodes[i]).text(d[0]).on("click", () => done(d[1])));
		const btns = p.selectAll("button"), len = sel.length;
		const flip = n => btns.classed("flip", (d, i) => n === i); flip(idx);
		const done = (res) => {
			this.target.on("keydown.select", false);
			p.remove();
			resolve(res);
		};
		this.target.on("keydown.select", e =>{ console.log(e, idx);
			if (e.code === 'Space') { e.preventDefault();
				if (++idx == len) idx = 0; flip(idx);
			} else if (e.code === 'Enter') { e.preventDefault();
				const btn = p.selectAll("button").filter((d, i) => i === idx);
				btn.node().click();
			}
		});
	}); }
	async confirm(s, def = true) { return this.select(s, def? { "Yes": true, "No": false}: { "No": false, "Yes": true}); }
};
