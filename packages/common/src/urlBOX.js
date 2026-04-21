async function urlBOX(url) {
	// 改良1 & 2: fetch API を使って「iframeで埋め込めるか」を判定
	const canEmbed = await checkEmbeddable(url);
	if (!canEmbed) {
		return window.open(url, "_blank", "noopener,noreferrer"); // _web_ではなく安全な_blankを推奨
	}

	const plane = d3.select("body").append("div").classed("overlay-urlbox", true);
	const div = plane.append("div").classed("body", true);

	plane.append("div").classed("head", true).html(`閉じる [ <i>${url}</i> ]`)
		.on("click", e => {
			e.stopPropagation();
			// 改良4: jQueryのempty()の代わりに中身をクリアしつつスライドダウン
			div.html("")
				.transition().ease(d3.easeCubic).duration(800)
				.style("transform", "translate(0, 100%)") // style("top")よりtransformの方が描画が滑らか
				.on("end", () => plane.remove());
		});

	const iframe = div.append("iframe")
		.attr("scrolling", "auto")
		.attr("sandbox", "allow-same-origin allow-forms allow-scripts")
		.style("display", "none"); // .hide()のバニラ化

	iframe.attr("src", url);

	div.transition().ease(d3.easeCubic).duration(800)
		.style("transform", "translate(0,0)")
		.on("end", () => iframe.style("display", "block"));

	// 改良3: モダンな判定関数
	async function checkEmbeddable(targetUrl) {
		try {
			// HEADリクエストでヘッダー情報だけを取得（無駄なダウンロードを防ぐ）
			const response = await fetch(targetUrl, { method: 'HEAD', mode: 'cors' });

			// X-Frame-Options が DENY や SAMEORIGIN の場合は埋め込めない
			const xFrame = response.headers.get('X-Frame-Options');
			if (xFrame && (xFrame.toUpperCase() === 'DENY' || xFrame.toUpperCase() === 'SAMEORIGIN')) {
				return false;
			}

			// CSP (Content-Security-Policy) で frame-ancestors を制限している場合も弾く
			const csp = response.headers.get('Content-Security-Policy');
			if (csp && csp.toLowerCase().includes('frame-ancestors')) {
				return false;
			}

			return response.ok;
		} catch (error) {
			// CORS制限で弾かれた場合（相手が自分のサイトへのリクエストを許可していない）は
			// そもそもiframeの中身を読めない・あるいは埋め込み拒否の可能性が高いため false
			return false;
		}
	}
}