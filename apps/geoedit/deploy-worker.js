// geoedit 旧URL（www.ortho-earth.com/geoedit*）の転送だけを残した Worker（9/4）：
// エディタ本体は ortho-japan のガジェット（gadgets/geoedit）になり、ページは /japan/geoedit（ortho-japan Worker が配る）。
// 名刺・SNS・ブックマークの旧 URL を壊さない＝301 で新ページへ。検索（?lang= 等）は引き継ぐ。ハッシュ（共有ビュー）は
// サーバーに届かないがブラウザが転送先へ持ち越す（RFC 7231 §7.1.2 の慣行＝Chrome/Safari/Firefox とも維持）。
export default {
	async fetch(req) {
		const url = new URL(req.url);
		return Response.redirect(`${url.origin}/japan/geoedit${url.search}`, 301);
	},
};
