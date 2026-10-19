// node の版の門（2026-10-19）。検定（packages/*/tests/*.mjs）は src/*.ts を node で直接読む＝.ts をそのまま読めるのは
// type stripping が既定になった Node 22.18（23 系は 23.6）以降。古い node だと ERR_UNKNOWN_FILE_EXTENSION で ephem の検定が落ち、
// deploy:engine が solar の手前で止まった（2026-10-19・Node 22.13.1 の Mac）＝配る前・回す前にここで止めて、何をすればよいかを言う。
export const MIN_NODE = "22.18";
/** version（"22.13.1" など）が .ts を直接読める node か。だめなら理由の文（日本語）、よければ null */
export function nodeVersionProblem(version = process.versions.node) {
	const [major, minor] = version.split(".").map(Number);
	const ok = major >= 24 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
	if (ok) return null;
	return `✗ Node ${version} は .ts を直接読めない（検定が src/*.ts を import する）＝Node ${MIN_NODE} 以降（23 系は 23.6 以降）が要る。` +
		`\n  上げる：nvm install 22 ／ brew upgrade node@22　　上げずに通す：NODE_OPTIONS=--experimental-strip-types を付けて実行`;
}
/** 門＝だめなら文を出して exit 1 */
export function requireNode() {
	const p = nodeVersionProblem();
	if (p) { console.error(p); process.exit(1); }
}
