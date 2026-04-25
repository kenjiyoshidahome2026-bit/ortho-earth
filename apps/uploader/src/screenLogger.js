import { comma, isArray, isString, isNumber, isObject, isBlob, unique, concat } from "common";

export class screenLogger {
	constructor (div) { this.target = div.classed("log", true); }
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
	title(s) { this.target.append("p").classed("title", true).text("✨ " + s +" ✨"); }
	warn(s) { this.target.append("p").classed("warn", true).text("⚠️ " + s); }
	error(s) { this.target.append("p").classed("error", true).text("❌ " + s); }
	success(s) { this.target.append("p").classed("success", true).text("✅ " + s); }
}
