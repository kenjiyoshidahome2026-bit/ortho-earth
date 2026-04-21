d3.highlightKeyword = function (strs, sense = false) {
	// 改良4: D3の独自判定をやめ、標準JSの判定を使用
	const isString = (v) => typeof v === 'string';
	const isArray = Array.isArray;

	if (isString(strs)) {
		// 改良1: eval() を絶対に避け、安全に正規表現文字列をパースする
		const match = strs.match(/^\/(.+)\/(i?)$/);
		if (match) {
			try {
				// match[1] がパターン、match[2] がフラグ('i'など)
				return new RegExp(match[1], match[2]);
			} catch (e) {
				// パターンが不正な場合は無視して下に進む
			}
		}
	}

	// 改良5: 三項演算子のネストを整理して読みやすくし、空文字を弾く
	let arr = [];
	if (strs) {
		arr = isArray(strs) ? strs : isString(strs) ? strs.split(" ") : [strs];
	}
	arr = arr.filter(t => t); // undefinedや空文字をフィルタリング

	if (arr.length === 0) return null;

	return new RegExp("(" + arr.map(escape).join("|") + ")", sense ? "" : "i");

	// 改良2 & 3: 文字列のforEachエラーを直し、標準的で高速なエスケープ処理にする
	function escape(s) {
		// 先に前後の空白を取り除く
		const trimmed = String(s).trim();
		// 正規表現で特別な意味を持つ記号をすべてバックスラッシュでエスケープする定石
		return trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}
}; 
d3.selection.prototype.highlight = function (strs, sense = false) {
	const cls = "highlight";

	// 改良1: モダンなDOM APIで直感的に「中身だけ残して剥がす」
	const remove = function () {
		const parent = this.parentNode;
		if (!parent) return;
		this.replaceWith(...this.childNodes); // 自身のタグを消し、中身のテキストと置き換える
		parent.normalize(); // 分断されたテキストノードを結合
	};

	const isText = q => q.nodeType === 3;
	const isElem = q => (q.nodeType === 1 && q.childNodes.length && !/^(script|style)$/i.test(q.tagName));
	const isIframe = q => (q.nodeType === 1 && /^iframe$/i.test(q.tagName));

	this.selectAll("." + cls).each(remove);
	this.selectAll("iframe").each(function () {
		// 改良2: 外部ドメインのiframeを触ってクラッシュするのを防ぐ
		try {
			if (this.contentDocument) {
				d3.select(this.contentDocument.body).selectAll("." + cls).each(remove);
			}
		} catch (e) { /* クロスドメインエラー時は無視 */ }
	});

	if (!strs) return this;

	// `instanceof` の方が `constructor ===` より少し安全（null時など）
	const rex = (strs instanceof RegExp) ? strs : d3.highlightKeyword(strs, sense);

	return this.each(function () { loop(this); });

	function loop(q) {
		let r;
		// 改良3: match ではなく exec を使い、gフラグ付き正規表現での undefined エラーを防ぐ
		if (isText(q) && (r = rex.exec(q.data))) {
			const span = document.createElement("span");
			span.classList.add(cls);

			const str = q.splitText(r.index);
			str.splitText(r[0].length);

			span.appendChild(str.cloneNode(true));
			str.replaceWith(span); // ここもモダンに

			rex.lastIndex = 0; // exec使用時は、状態をリセットしておく
			return 1;
		} else if (isIframe(q)) {
			// iframe内部への再帰も安全に
			try {
				if (q.contentDocument) loop(q.contentDocument.body);
			} catch (e) { /* クロスドメインエラー時は無視 */ }
		} else if (isElem(q) && !q.classList.contains(cls)) { // 改良4: クラスの完全一致ではなくcontainsを使用
			for (let i = 0; i < q.childNodes.length; i++) {
				i += loop(q.childNodes[i]);
			}
		}
		return 0;
	}
};