// 共有エンジンの「古い版を握ったままの頁」を救う vite プラグイン（エンジン配布の恒久対策 A・2026-10-14）。
// 起こること：エンジンを配り直した瞬間に開いていた頁は旧版の入口（globe.js）を読み込み済み。そのあと遅れて読む部品（cog・geocoder 等の
//   動的チャンク）を旧版の住所へ取りに行くと、名前が変わった部品は本番に無い＝404（tellus の cog-*.js・census の backend-*.js）。
// 手：エンジンの束の動的 import（`import(\`./assets/x.js\`)`）に「失敗したら一度だけ確かめる」を噛ませる。確かめる＝/globe/engine/current.json を
//   取り直し、今の版が自分（import.meta.url の版）と違えば頁を 1 回だけ読み直す（sessionStorage で同じ版へは 2 回目を打たない＝輪にならない）。
//   版が同じ（本当に通信が切れた・オフライン）なら読み直さない＝失敗はそのままアプリへ返る（元の振る舞い）。
// R2 にも手作業にも触れない（本人方針 2026-09-30）。worker の中（document が無い）では何もしない。
const WRAP = /\bimport\((["`])(\.\.?\/[^"`$]+)\1\)/g;
// 入口ごとに置く（??= ＝最初に評価された入口の 1 本だけが効く）。import.meta.url＝/globe/engine/<版>/<入口>.js か /globe/engine/<版>/regions/app.js 等（入口が下の階にもある・2026-10-14）
// ＝current.json は「<版>/ から後ろ」を取り替えて引く（旧＝../current.json＝下の階の入口では <版>/current.json を指してしまう）
const HELPER = `globalThis.__oeR??=()=>{if(typeof document>"u"||globalThis.__oeR.on)return;globalThis.__oeR.on=1;fetch(import.meta.url.replace(/\\/[0-9a-f]{10}\\/[^?#]*$/,"/current.json"),{cache:"no-store"}).then(r=>r.ok?r.json():null).then(j=>{const v=j&&j.version,k="oe-engine-reload";if(!v||import.meta.url.includes("/"+v+"/")||sessionStorage.getItem(k)===v)return;sessionStorage.setItem(k,v);location.reload()}).catch(()=>{})};\n`;

export const wrapDynamicImports = code => code.replace(WRAP, (s) => `${s}.catch(e=>{throw globalThis.__oeR?.(),e})`);

export const engineStale = () => ({
	name: "engine-stale",
	renderChunk(code, chunk) {
		const out = (chunk.isEntry ? HELPER : "") + wrapDynamicImports(code);
		return out === code ? null : { code: out, map: null };
	},
});
