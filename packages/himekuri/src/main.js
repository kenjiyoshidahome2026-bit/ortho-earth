import { 日カレンダー, 世界時計, tip } from "./index.js";
import { date2ymd, dayAfter, monthLength } from "./共通関数.js";

const $ = id => document.getElementById(id);
const iso = ([y, m, d]) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const parse = s => { const m = /^(\d{1,4})-(\d{1,2})-(\d{1,2})$/.exec(s || ""); return m && [+m[1], +m[2], +m[3]]; };
const today = () => date2ymd().slice(0, 3);

let hideTip = () => {};
let ymd = parse(new URLSearchParams(location.search).get("d")) || today();

function show(dir = 0) {
	const page = document.createElement("div");
	page.innerHTML = 日カレンダー(ymd);
	if (dir) page.className = dir > 0 ? "flip-next" : "flip-prev";
	$("page").replaceChildren(page);
	hideTip();   // めくったら前の頁の吹き出しは消す
	$("pick").value = iso(ymd);
	const url = new URL(location.href);
	const isToday = iso(ymd) === iso(today());
	isToday ? url.searchParams.delete("d") : url.searchParams.set("d", iso(ymd));
	history.replaceState(null, "", url);
}
const move = n => { ymd = dayAfter(ymd, n); show(Math.sign(n)); };
const moveMonth = n => {
	let [y, m, d] = ymd;
	m += n; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; }
	ymd = [y, m, Math.min(d, monthLength([y, m]))];
	show(Math.sign(n));
};

$("prev").onclick = () => move(-1);
$("next").onclick = () => move(1);
$("today").onclick = () => { ymd = today(); show(); };
$("pick").onchange = e => { const v = parse(e.target.value); if (v) { ymd = v; show(); } };
addEventListener("keydown", e => {
	if (e.target.tagName === "INPUT" || e.metaKey || e.ctrlKey || e.altKey) return;
	if (e.key === "ArrowLeft") e.shiftKey ? moveMonth(-1) : move(-1);
	else if (e.key === "ArrowRight") e.shiftKey ? moveMonth(1) : move(1);
	else if (e.key === "t" || e.key === "T") { ymd = today(); show(); }
	else return;
	e.preventDefault();
});
// スワイプ：横に 40px 以上
let x0 = null;
$("page").addEventListener("pointerdown", e => { x0 = e.clientX; });
$("page").addEventListener("pointerup", e => {
	if (x0 === null) return;
	const dx = e.clientX - x0; x0 = null;
	if (Math.abs(dx) > 40) move(dx < 0 ? 1 : -1);
});
// 日付が変わったら「今日」を追いかける（今日を表示しているときだけ）
let shown = iso(today());
setInterval(() => {
	const t = iso(today());
	if (t !== shown) { if (iso(ymd) === shown) { ymd = today(); show(1); } shown = t; }
}, 30000);

show();
hideTip = tip($("page"));

const 都市 = [
	["TOKYO", "Asia/Tokyo"],
	["LONDON", "Europe/London"],
	["NEW YORK", "America/New_York"],
	["LOS ANGELES", "America/Los_Angeles"],
	["SYDNEY", "Australia/Sydney"],
];
for (const [label, zone] of 都市) {
	const box = document.createElement("div");
	box.append(世界時計({ offset: zone, label }));
	$("clocks").append(box);
}
