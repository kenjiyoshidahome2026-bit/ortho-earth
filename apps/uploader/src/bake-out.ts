// 焼きスクリプトの出力（repo 直下の bake-out/・gitignore）→ bucket（2026-10-15）。
// R2 へ出す物は uploader のボタンから（本人 2026-09-30）＝焼くのは各アプリのスクリプト、上げるのはここ。鍵を読むのは uploader だけ。
// 中身は dev server の /@fs で monorepo から直に読む＝dev でだけ動く（共有データ shared-data.ts と同じ型）。
//   標高タイル：apps/ortho-japan/scripts/bake-dem10b.mjs（R01）・bake-r10-jp.mjs（R10）→ bake-out/alt/*.gz（目録 index.json）→ GIS/alt
//   国土数値情報カタログ：apps/gishub-jp/scripts/nlftp-bump.mjs --write → bake-out/catalog/（plan.json の順）→ catalog/
import type { screenLogger } from "common/screenLogger";
import type { NativeBucket } from "native-bucket";
const at = (rel: string) => `/@fs${__BAKE_OUT_DIR__}/${rel}`;
const devOnly = () => { if (!import.meta.env.DEV) throw new Error("dev server（npm run dev -w uploader）でだけ動く"); };
const readLocal = async (rel: string) => {
	const res = await fetch(at(rel), { cache: "no-store" });
	if (!res.ok) throw new Error(`bake-out/${rel} を読めない（${res.status}）＝先に焼きスクリプトを回す`);
	return res;
};
const gunzip = async (blob: Blob) => new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).blob();
// dev server（sirv）は .gz に Content-Encoding: gzip を付けて返す＝ブラウザが解いて届く。頭が gzip の時だけ解く（二度解くと Failed to fetch）
const ungz = async (blob: Blob) => { const h = new Uint8Array(await blob.slice(0, 2).arrayBuffer()); return h[0] === 0x1f && h[1] === 0x8b ? gunzip(blob) : blob; };

// 標高タイル＝焼いた .gz を解いて生の altpbf として置く（GEBCO の作成と同じ形＝Bucket が gzip して Content-Encoding を付ける）
export async function altTiles(q: screenLogger, { Bucket }: NativeBucket) {
	q.clear(); q.title("標高タイル（bake-out/alt）→ GIS/alt");
	devOnly();
	const names: string[] = await (await readLocal("alt/index.json")).json();
	if (!names.length) throw new Error("bake-out/alt に焼いたタイルが無い");
	const bucket = await Bucket("GIS/alt", { silent: true });
	if (!bucket) throw new Error("Bucket(GIS/alt) に到達できない");
	for (const f of names) {
		const name = f.replace(/\.gz$/, "");
		const raw = await ungz(await (await readLocal(`alt/${f}`)).blob());
		await bucket.put(new File([raw], name, { type: "application/x-altpbf" }));
		q.success(`↑ GIS/alt/${name}（${(raw.size / 1e6).toFixed(1)}MB）`);
	}
	q.log(`${names.length} 枚を置いた＝各頁の IDB は ETag の差で次の訪問から入れ替わる`);
}

// 国土数値情報カタログ＝plan.json の順（先に本体・後で index.json）。土台にした index が bucket で変わっていたら止める（古い差し替えで上書きしない）
export async function nlftpCatalog(q: screenLogger, { Bucket, apiUrl }: NativeBucket & { apiUrl: string }) {
	q.clear(); q.title("国土数値情報カタログ（bake-out/catalog）→ catalog/");
	devOnly();
	const plan: { base: string; from: string; to: string; files: string[] } = await (await readLocal("catalog/plan.json")).json();
	const res = await fetch(`${apiUrl}/bucket/catalog/index.json`, { cache: "no-store" });
	if (!res.ok) throw new Error(`bucket の catalog/index.json を読めない（${res.status}）`);
	let blob = await res.blob();
	const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
	if (head[0] === 0x1f && head[1] === 0x8b) blob = await gunzip(blob);
	const now = JSON.stringify(JSON.parse(await blob.text()));
	const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(now)))].map(b => b.toString(16).padStart(2, "0")).join("");
	if (sha !== plan.base) throw new Error(`bucket の index.json が下書きの土台と違う（もう上げた・誰かが更新した）＝nlftp-bump.mjs ${plan.from} ${plan.to} --write をやり直す`);
	const bucket = await Bucket("catalog", { silent: true });
	if (!bucket) throw new Error("Bucket(catalog) に到達できない");
	for (const f of plan.files) {
		const body = await (await readLocal(`catalog/${f}`)).blob();
		await bucket.put(new File([body], f, { type: "application/json" }));
		q.success(`↑ catalog/${f}（${(body.size / 1e3).toFixed(1)}KB）`);
	}
	q.log(`${plan.from} → ${plan.to} を差し替えた（${plan.from}.json は残す＝旧リンク用）`);
}

// PLATEAU の焼き（apps/japan-map/scripts/bake-plateau.mjs → apps/japan-map/plateau-bake-out・目録 index.json）→ GIS/plateau/（2026-11-12）。
// 横浜の LOD1 13 区を R2 に置く（通信なしの保存が 1.13 GB → 約 73 MB・本人「縮退した plateau を R2 に置くのはアリ」）。全国の焼きにも使える。
// 置き方は焼きスクリプトの --upload と同じ＝本体（b*.plq）を先に、manifest.json を最後に（manifest が見えた時には本体が揃っている＝エンジンの 404 → 生経路の判定に矛盾を作らない）。
// R2 に manifest が既にある焼きは飛ばす（焼きスクリプトの --upload と同じ＝置いた物は差し替えない・途中で止まってもやり直しが効く）。取れなかったタイル（unbaked）を持つ焼きは上げない（エンジンは焼きを正として欠けたまま描く）＝--redo-unbaked で焼き直してから。
export async function plateauBake(q: screenLogger, { Bucket, apiUrl }: NativeBucket & { apiUrl: string }) {
	q.clear(); q.title("PLATEAU の焼き（apps/japan-map/plateau-bake-out）→ GIS/plateau/");
	devOnly();
	const read = async (rel: string) => {
		const res = await fetch(`/@fs${__PLATEAU_BAKE_DIR__}/${rel}`, { cache: "no-store" });
		if (!res.ok) throw new Error(`plateau-bake-out/${rel} を読めない（${res.status}）＝先に node apps/japan-map/scripts/bake-plateau.mjs --only=… を回す`);
		return res;
	};
	const rels: string[] = await (await read("index.json")).json();
	if (!rels.length) throw new Error("plateau-bake-out に焼きが無い");
	const bucket = await Bucket("GIS/plateau", { silent: true, lazy: true });
	if (!bucket) throw new Error("Bucket(GIS/plateau) に到達できない");
	let up = 0, same = 0, holes = 0, bytes = 0;
	for (const rel of rels) {
		const man: { ward: string; ts: number; batches: { f: string }[]; unbaked?: number[] } = await (await read(rel + "manifest.json")).json();
		if (man.unbaked?.length) { holes++; q.warn(`${man.ward}（${rel}）：取れなかったタイル ${man.unbaked.length} 枚＝上げない（--redo-unbaked で焼き直す）`); continue; }
		const remote = await fetch(`${apiUrl}/bucket/GIS/plateau/${rel}manifest.json`, { cache: "no-store" }).then(r => r.ok).catch(() => false);
		if (remote) { same++; continue; }
		let b = 0;
		for (const { f } of man.batches) {
			const body = await (await read(rel + f)).blob();
			await bucket.put(new File([body], rel + f, { type: "application/octet-stream" })); b += body.size;
		}
		await bucket.put(new File([JSON.stringify(man)], rel + "manifest.json", { type: "application/json" }));
		up++; bytes += b;
		q.success(`↑ GIS/plateau/${rel}（${man.ward}・${man.batches.length} 束・${(b / 1e6).toFixed(1)}MB）`);
	}
	q.log(`上げた ${up} 件（${(bytes / 1e6).toFixed(1)}MB）・R2 に既にある ${same} 件・欠けありで止めた ${holes} 件`);
}
