// ortho-earth.com（apex）→ www.ortho-earth.com へ path・query を保って301。
export default {
	fetch(req) {
		const url = new URL(req.url);
		url.protocol = 'https:';
		url.hostname = 'www.ortho-earth.com';
		return Response.redirect(url, 301);
	}
};
