// gint のラベル（label.field＝GintExpr）の値→文字の検定（node・網なし）。数・真偽の定数は文字列の定数と同じく出す（旧＝黙って出なかった・2026-10-16）
import { gintLabelText, hasLabelField } from "../src/gint/layers.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const pr = { name: "東京", pop: 1400 };
const ev = e => (e[0] === "get" ? pr[e[1]] : "?");

ok("文字列はそのまま", gintLabelText("固定", pr, ev) === "固定");
ok("式は evalArr へ", gintLabelText(["get", "name"], pr, ev) === "東京");
ok("関数は props で", gintLabelText(p => p.pop, pr, ev) === 1400);
ok("数＝String", gintLabelText(42, pr, ev) === "42");
ok("数 0＝\"0\"", gintLabelText(0, pr, ev) === "0");
ok("小数＝String", gintLabelText(1.5, pr, ev) === "1.5");
ok("true＝\"true\"", gintLabelText(true, pr, ev) === "true");
ok("false＝\"false\"", gintLabelText(false, pr, ev) === "false");
ok("未指定＝null", gintLabelText(undefined, pr, ev) === null);
ok("null＝null", gintLabelText(null, pr, ev) === null);
ok("object＝null（型の外）", gintLabelText({}, pr, ev) === null);

ok("指定あり：文字列・式・関数・数・真偽", ["a", ["get", "x"], () => "", 1, 0, true, false].every(hasLabelField));
ok("指定なし：undefined・null・\"\"", ![undefined, null, ""].some(hasLabelField));

console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ gint-label 全 PASS");
process.exit(fail ? 1 : 0);
