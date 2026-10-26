import * as d3 from "d3";
import "./d3/selection.ts";
import { comma, isArray, isString, isNumber, isObject, isBlob, unique, concat } from "./index.ts";
import "./screenLogger.scss";

/** 画面の器（d3 のセレクション）＝constructor が受ける物 */
export type LogDiv = d3.Selection<HTMLElement, unknown, d3.BaseType, unknown>;
/** 器に足した 1 行（p／span／img）＝log() 等の返り */
export type LogLine = d3.Selection<HTMLElement, unknown, d3.BaseType, unknown>;
type P = LogLine;
/** FetchStart／FetchProgress／FetchEnd の detail（native-bucket の Fetch が投げる） */
export interface FetchDetail { name: string; loaded: number; total?: number; size?: number }
/** ConvertStart／ConvertEnd／ConvertWarning の detail（geopbf が投げる） */
export interface ConvertDetail { name: string; event: string; error?: unknown; warning?: unknown }

// URL・ファイル名の %E5%8D%83… を読める字に戻す（表示専用・壊れた符号はそのまま）
export const readable = (s: unknown): string => { try { return decodeURI(String(s ?? "")); } catch { return String(s ?? ""); } };
const escHtml = (s: unknown): string => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export class screenLogger {
	target: LogDiv;
	time: number;
	dots: string[];
	bars: Record<string, [P, number, number]>;
	mess: Record<string, [P, number, ReturnType<typeof setInterval>]>;
	_ac: AbortController;
	constructor (div: LogDiv | HTMLElement) {
		// 器は自分の d3 で選び直す＝呼び手の d3 が別の実体（共有エンジンの外でアプリが焼き込んだ d3）でも、
		// .show/.hide/.empty 等の拡張（./d3/selection.ts）が付いた selection で持つ（2026-10-26・gishub-jp の読込が .hide で全部止まった）
		const node = div instanceof Element ? div : div.node();
		this.target = (d3.select(node) as LogDiv).classed("log", true); this.time = performance.now();
		this.dots = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		this.bars = {};
		this.mess = {};
		this._ac = new AbortController();
		const { signal } = this._ac;
		addEventListener("FetchStart",    e => this.progress("start", e as CustomEvent<FetchDetail>),    { signal });
		addEventListener("FetchProgress", e => this.progress("progress", e as CustomEvent<FetchDetail>), { signal });
		addEventListener("FetchEnd",      e => this.progress("end", e as CustomEvent<FetchDetail>),      { signal });
		addEventListener("ConvertStart",   e => this.event("start", e as CustomEvent<ConvertDetail>),              { signal });
		addEventListener("ConvertEnd",     e => this.event("end", e as CustomEvent<ConvertDetail>),                { signal });
		addEventListener("ConvertWarning", e => this.warn((e as CustomEvent<ConvertDetail>).detail.warning),         { signal });
	}
	destroy(): void { this._ac.abort(); this.clear(); }
	hide(): this { this.target.hide(); return this; }
	show(): this { this.target.show(); return this; }
	clear(): this { this.target.empty(); return this; }
	empty(): P { const div = this.target, p = div.append<HTMLElement>("p");
		requestAnimationFrame(() => div.node()!.scrollTop = div.node()!.scrollHeight);
		return p;
	}
	log(...a: unknown[]): LogLine {
		const toS = (_: unknown): string => isString(_)? _.replace(/\n/g,"<br/>"): isNumber(_)? comma(_): JSON.stringify(_);
		const o2a = (o: Record<string, unknown>[]): unknown[][] => {
			const a = unique(concat(o.map(t=>Object.keys(t))));
			const b = o.map(t=> a.map(v=>t[v]||""));
			return [a as unknown[]].concat(b);
		};
		const isImageBlob = (_: unknown): _ is Blob => isBlob(_) && !!_.type.match(/^image/);
		const p = this.empty();
		if (a.length == 1) { let v: unknown = a[0];
			if (isArray(v) && v.length > 1) {
				let rows: unknown[] = v;
				if (rows.every(isObject)) rows = o2a(rows);
				v = rows;
				if (rows.every(isArray)) { const table = p.append("table");
					rows.forEach(t=>{ const tr = table.append("tr");
						t.forEach((t: unknown)=>tr.append("td").text(t as string).classed("right", isNumber(t)))
					});
					return p;
				}
			} else if (isImageBlob(v)) {
				return p.append<HTMLElement>("img").attr("src", URL.createObjectURL(v));
			} else if (isObject(v)) {
				const dl = p.append("dl");
				Object.entries(v).forEach(([k, val]) => {
					dl.append("dt").text(k);
					dl.append("dd").html(toS(val));
				});
				return p;
			}
			return p.append<HTMLElement>("span").html(toS(v));
		}
		a.forEach(t=>p.append("span").html(toS(t)));
		return p;
	}
	progress(type: string, e: CustomEvent<FetchDetail>): void {
		const { name, loaded, total, size } = e.detail;
		const label = readable(name);   // 表示だけ復号（bars の鍵は受け取った name のまま）
		if (type === "start") { if (this.bars[name]) return;
			const bar = this.empty().classed("progress", true).text("⏳ " + label)
			this.bars[name] = [bar, performance.now(), 0];
		} else if (type === "progress" && this.bars[name]) {
			const bar = this.bars[name][0], count = this.bars[name][2] = this.bars[name][2]+1;
			const d = this.dots[~~(count/10) % this.dots.length];
			let p: string, info: string;
			if (total) {
				const pct = Math.round((loaded / total) * 100), n = Math.floor(pct / 5);
				p = `<span class='done'>${"█".repeat(n)}</span><span class='rest'>${"█".repeat(20 - n)}</span>`;
				info = `${pct}% (${comma(loaded)}/${comma(total)})`;
			} else {
				const pos = count % 17;
				p = `<span class='rest'>${"░".repeat(pos)}</span><span class='done'>████</span><span class='rest'>${"░".repeat(16 - pos)}</span>`;
				info = `${comma(loaded)} bytes`;
			}
			bar.html(`⏳ ${escHtml(label)}: ${d}[${p}] ${info}`);
		} else if (type === "end" && this.bars[name]) {
			const bar = this.bars[name][0], start = this.bars[name][1];
			const time = ((performance.now() - start)/1000).toFixed(3);
			const speed = comma(((size||total)! / +time / 1024 / 1024).toFixed(2));
			bar.text(`⏳ ${label}: ${comma(size||total)} bytes / ${comma(time)}sec (${speed} Mbytes/sec)`);
			delete this.bars[name];
		}
	}
	event(type: string, e: CustomEvent<ConvertDetail>): void {
		const { name, event, error } = e.detail;
		if (type === "start") { if (this.mess[name]) return;
			let count = 0;
			const bar = this.empty().classed("event", true).html(`🔄 ${escHtml(name)}: ${escHtml(event)} <span id="spinner"/>`);
			const spinner = bar.select("#spinner");
			const updateSpinner = (): unknown => spinner.text(this.dots[~~(count++) % this.dots.length]);
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
	warn(s: unknown): void { this.empty().classed("warn", true).text(`⚠️ [WARNING] ${s}`); }
	error(s: unknown): void { this.empty().classed("error", true).text(`❌ [ERROR] ${s}`); }
	title(s: unknown, sub: unknown = ""): P { const p = this.empty().classed("title", true).html(`<span class="title">✨ ${escHtml(s)} ✨</span><span class="subtitle">${escHtml(sub)}</span>`);
		this.time = performance.now();
		return p;
	}
	success(s: unknown): void { const time = ((performance.now() - this.time)/1000).toFixed(3);
		this.empty().classed("success", true).text(`✅ [SUCCESS] ${s} (${comma(time)}sec)`);
	}
	async prompt(s: unknown, def = ""): Promise<string> {
		return new Promise(resolve => {
			const p = this.empty().classed("prompt", true);
			p.append("span").text(`> ${s} ? `);
			const ans = p.append("span").classed("answer", true).attr("contenteditable", true);
			if (def) ans.text(def);
			const btn = p.append("button").text("OK").style("margin-left", "10px");
			const submit = (): void => {
				const result = ans.text().trim();
				ans.attr("contenteditable", false);
				btn.remove();
				resolve(result || def);
			};
			btn.on("click", submit);
			ans.on("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); submit(); }});
			const node = ans.node()!;
			node.focus();
			if (def) {
				const range = document.createRange();
				range.selectNodeContents(node);
				window.getSelection()!.removeAllRanges();
				window.getSelection()!.addRange(range);
			}
		});
	}
	/** 選択肢＝[表示, 値] の配列（値だけなら表示＝値）か { 表示: 値 }。Space で送り・Enter で決める */
	async select(s: unknown, sel: unknown[] | Record<string, unknown>): Promise<unknown> { return new Promise(resolve => { let idx = 0;
		const pairs: unknown[][] = isArray(sel) ? sel.map((t: unknown)=>isArray(t)?t:[t,t]) : Object.entries(sel);
		const p = this.empty().classed("select", true).append("span").text(`> ${s} ? `);
		p.append("div").classed("select-buttons", true).selectAll("button").data(pairs).join("button")
		.each((d, i, nodes) => d3.select(nodes[i]).text(d[0] as string).on("click", () => done(d[1])));
		const btns = p.selectAll("button"), len = pairs.length;
		const flip = (n: number): unknown => btns.classed("flip", (d, i) => n === i); flip(idx);
		const done = (res: unknown): void => {
			this.target.on("keydown.select", null);   // 外す（旧＝false＝d3 の実装では null と同じ扱い）
			p.remove();
			resolve(res);
		};
		this.target.on("keydown.select", (e: KeyboardEvent) =>{ console.log(e, idx);
			if (e.code === 'Space') { e.preventDefault();
				if (++idx == len) idx = 0; flip(idx);
			} else if (e.code === 'Enter') { e.preventDefault();
				const btn = p.selectAll<HTMLButtonElement, unknown>("button").filter((d, i) => i === idx);
				btn.node()!.click();
			}
		});
	}); }
	async confirm(s: unknown, def = true): Promise<unknown> { return this.select(s, def? { "Yes": true, "No": false}: { "No": false, "Yes": true}); }
};
