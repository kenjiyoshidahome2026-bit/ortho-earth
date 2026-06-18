const BASE_URL = "https://nlftp.mlit.go.jp/ksj/gml/";
const MAIN_LIST_URL = `${BASE_URL}gml_datalist.html`;

async function main() {
	try {
		console.log(`🔗 解析中: ${MAIN_LIST_URL}`);

		// 1. メインページのHTMLをプレーンテキストとして取得
		const res = await fetch(MAIN_LIST_URL);
		if (!res.ok) throw new Error(`HTTPエラー: ${res.status}`);
		const html = await res.text();

		// 2. 正規表現で「KsjTmplt-*.html」を含むaタグを全抽出
		// マッチング対象の例: <a href="./datalist/KsjTmplt-N03-2026.html">行政区域</a>
		const linkRegex = /<a\s+[^>]*href=["']([^"']*(?:datalist\/KsjTmplt-)[^"']+\.html)["'][^>]*>([\s\S]*?)<\/a>/g;

		const targetPages = [];
		const seenUrls = new Set();
		let match;

		while ((match = linkRegex.exec(html)) !== null) {
			const rawHref = match[1]; // マッチしたURLの相対パス
			const rawText = match[2]; // aタグに挟まれたテキスト

			// 絶対URLの組み立て（ new URL を使えばバニラで安全に結合可能 ）
			const absoluteUrl = new URL(rawHref, BASE_URL).href;

			// HTMLタグの除去（テキスト内に<span>等が入っている場合のクレンジング）
			const cleanText = rawText.replace(/<[^>]*>/g, '').trim();

			if (!seenUrls.has(absoluteUrl) && cleanText) {
				seenUrls.add(absoluteUrl);
				targetPages.push({
					title: cleanText,
					url: absoluteUrl
				});
			}
		}

		console.log(`\n✅ ターゲットページを ${targetPages.length} 件検出しました。`);

		// 解析結果を確認するために、一旦ファイルに保存
		console.log('target_pages.json', JSON.stringify(targetPages, null, 4), 'utf-8');
		console.log(`📊 一時保存先: target_pages.json`);

	} catch (error) {
		console.error("❌ タイムラインの構築に失敗しました:", error.message);
	}
}

main();