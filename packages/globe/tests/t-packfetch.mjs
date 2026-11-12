// worker の取りの束への落とし（src/packfetch.ts・完全オフライン 2026-11-12）をネット無しで確かめる。caches・fetch・navigator.onLine は差し替え
import { fetchOrPack, fromPack } from "../src/packfetch.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const store = { "oj-pack-yokohama-bld": new Map([["https://x/t.json", "packed"]]), "oj-assets-v9": new Map([["https://x/a.json", "asset"]]) };
globalThis.caches = { keys: async () => Object.keys(store), open: async n => ({ match: async u => store[n].has(u) ? new Response(store[n].get(u)) : undefined }) };
let online = true, netCalls = 0;
Object.defineProperty(globalThis, "navigator", { value: { get onLine() { return online; } }, configurable: true });
globalThis.fetch = async u => { netCalls++; if (!online) throw new TypeError("Failed to fetch"); return new Response("net:" + u); };

ok("通信あり＝網（束は見ない）", await (await fetchOrPack("https://x/t.json")).text() === "net:https://x/t.json" && netCalls === 1);
online = false; netCalls = 0;
ok("通信なし＝束から（網へ行かない）", await (await fetchOrPack("https://x/t.json")).text() === "packed" && netCalls === 0);
ok("束は oj-pack* だけ（普段の置き場は見ない）", (await fromPack("https://x/a.json")) === null);
let threw = false; try { await fetchOrPack("https://x/none.json"); } catch { threw = true; }
ok("束にも無い＝網の失敗をそのまま投げる", threw && netCalls === 1);
online = true; globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
ok("通信ありでも網で落ちた＝束へ", await (await fetchOrPack("https://x/t.json")).text() === "packed");
const ac = new AbortController(); ac.abort(); threw = false;
try { await fetchOrPack("https://x/t.json", { signal: ac.signal }); } catch { threw = true; }
ok("止めた取りは束へ逃げない", threw);
console.log(fail ? `✗ t-packfetch ${fail} 件失敗` : "✓ t-packfetch 全 PASS");
process.exit(fail ? 1 : 0);
