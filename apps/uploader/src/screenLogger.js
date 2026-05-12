import { comma, isArray, isString, isNumber, isObject, isBlob, unique, concat } from "common";
import "./screenLogger.scss";
export class screenLogger {
	constructor (div) {
		this.target = div.classed("log", true); this.time = performance.now();
		this.dots = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		this.bars = {};
		this.mess = {};
	} 
	clear(s) { this.target.empty(); }
	log(...a) {
		const toS = _ => isString(_)? _.replace(/\n/g,"<br/>"): isNumber(_)? comma(_): JSON.stringify(_);
		const o2a = o => {
			const a = unique(concat(o.map(t=>Object.keys(t))));
			const b = o.map(t=> a.map(v=>t[v]||""));
			return [a].concat(b);
		};
		const isImageBlob = _ => isBlob(_) && _.type.match(/^image/);
		const p = this.target.append("p");
		if (a.length == 1) { a = a[0];
			if (isArray(a) && a.length > 1) { 
				if (a.every(isObject)) a = o2a(a);
				if (a.every(isArray)) { const table = p.append("table");
					a.forEach(t=>{ const tr = table.append("tr");
						t.forEach(t=>tr.append("td").text(t).classed("right", isNumber(t)))
					});
					return
				}
			} else if (isImageBlob(a)) {
				return p.append("img").attr("src", URL.createObjectURL(a));
			}
			return p.append("span").html(toS(a));
		} 
		a.forEach(t=>p.append("span").html(toS(t)));
	}
	progress(type, e) { console.log(type, e)
		const { name, loaded, total, size } = e.detail;
		if (type === "start") { if (this.bars[name]) return;
			const bar = this.target.append("p").classed("progress", true).text("⏳ " + name)
			this.bars[name] = [bar, performance.now(), 0];
		} else if (type === "progress" && this.bars[name]) {
			const bar = this.bars[name][0], count = this.bars[name][2] = this.bars[name][2]+1;
			const pct = Math.round((loaded / total) * 100), n = Math.floor(pct / 5);
			const p = `<span class='done'>${"█".repeat(n)}</span><span class='rest'>${"█".repeat(20 - n)}</span>`;
			const d = this.dots[count % this.dots.length];
			bar.html(`⏳ ${name}: ${d}[${p}] ${pct}% (${comma(loaded)}/${comma(total)})`);
		} else if (type === "end" && this.bars[name]) {
			const bar = this.bars[name][0], start = this.bars[name][1];
			const time = ((performance.now() - start)/1000).toFixed(3);
			const speed = comma(((size||total) / time / 1024 / 1024).toFixed(2));
			bar.text(`⏳ ${name}: ${comma(size||total)} bytes / ${comma(time)}sec (${speed} Mbytes/sec)`);
			this.bars[name] = null;
			delete this.bars[name];
		}
	}	
	event(type, e) {
		const { name, event, done, error } = e.detail;
		if (type === "start") { if (this.mess[name]) return;
			const bar = this.target.append("p").classed("event", true).text(`🔄 ${name}: ${event} `);
			this.mess[name] = [bar, performance.now()]
		} else if (type === "end" && this.mess[name]) {
			const bar = this.mess[name][0], start = this.mess[name][1];
			const time = ((performance.now() - start) / 1000).toFixed(3);
			error ? bar.classed("error", true).text("❌ [ERROR] " + error):
			bar.text(`🔄 ${name}: ${event} (${comma(time)}sec)`);
			this.mess[name] = null;
			delete this.mess[name];
		}
	}	
	warn(s) { this.target.append("p").classed("warn", true).text("⚠️ [WARNING] " + s); }
	error(s) { this.target.append("p").classed("error", true).text("❌ [ERROR] " + s); }
	title(s) { this.target.append("p").classed("title", true).html(`<span>✨ ${s} ✨</span>`); 
		this.time = performance.now();
	}
	success(s) { const time = ((performance.now() - this.time)/1000).toFixed(3);
		this.target.append("p").classed("success", true).text("✅ [SUCCESS] " + s + ` (${comma(time)}sec)`); 
	}
}
