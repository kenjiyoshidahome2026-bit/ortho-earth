export const context2D = (w = 300, h = 150, opts = {}) => {
	const canvas = document.createElement("canvas");
	const ctx = canvas.getContext("2d");

	canvas.width = w;
	canvas.height = h;

	// DOMプロパティへの直接代入（setAttributeより高速で安全）
	if (opts.id) canvas.id = opts.id;
	if (opts.name) canvas.setAttribute("name", opts.name);
	if (opts.class) canvas.className = opts.class;

	// 改良1: style文字列の安全な適用
	if (opts.style) canvas.style.cssText = opts.style;

	// 改良4: targetに文字列(セレクタ)、D3選択、DOMノードをすべて許容
	if (opts.target) {
		const parent = typeof opts.target === "string" ? document.querySelector(opts.target) :
			opts.target.node ? opts.target.node() : opts.target;
		if (parent) parent.appendChild(canvas);
	}

	if (opts.fill) {
		ctx.fillStyle = opts.fill;
		ctx.fillRect(0, 0, w, h);
	}

	// 改良2: toBlob で WebP や JPEG などの形式・画質を指定可能に
	ctx.toBlob = (type = "image/png", quality = 1.0) =>
		new Promise(resolve => canvas.toBlob(resolve, type, quality));

	// 改良3: set時に ctx を返すことでメソッドチェーンを可能に
	ctx.size = v => {
		if (v) {
			canvas.width = v[0];
			canvas.height = v[1];
			return ctx;
		}
		return [canvas.width, canvas.height];
	};

	ctx.clear = () => {
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		return ctx;
	};

	// 改良5: バニラJS化して依存を減らし、高速化
	ctx.show = () => { canvas.style.display = ""; return ctx; };
	ctx.hide = () => { canvas.style.display = "none"; return ctx; };

	return ctx;
};