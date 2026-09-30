// 重いデータ（小地域 CSV 2 本・pop-history.json・area-zip.json＝計約 22MB）の置き場＝R2（api.ortho-earth.com/bucket）。
// 2026-09-30（縮小計画 項目6b・本人裁定「R2 に置く」）：それまで gishub-jp と census2020 が同じファイルを各自の配信物に抱えていた。
// 正本は このディレクトリ（census/・zipcode/）＝scripts/build-*.mjs が書く。R2 のキーは中身のハッシュ入り（manifest.json）＝
// 中身が変わればキーが変わる＝バケツの GET が immutable で返せる（workers/bucket.js）。更新の手順＝scripts/shared-data.mjs --upload。
import MANIFEST from "./manifest.json" with { type: "json" };

export const sharedDataUrl = (name, apiBase) => {
	const key = MANIFEST[name];
	if (!key) throw new Error(`shared-data: manifest に無い名前 ${name}`);
	return `${apiBase}/bucket/${key}`;
};

// バケツは put の時に gzip して Content-Encoding を刻む。経路によっては gzip のまま届く（nlftp の読み手と同じ構え）＝頭の 2 バイトで見て解く
export async function fetchSharedData(name, apiBase, as = "text") {
	const res = await fetch(sharedDataUrl(name, apiBase));
	if (!res.ok) throw new Error(`shared-data: HTTP ${res.status} ${name}`);
	let buf = await res.arrayBuffer();
	const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
	if (head[0] === 0x1f && head[1] === 0x8b) buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
	const text = new TextDecoder().decode(buf);
	return as === "json" ? JSON.parse(text) : text;
}
