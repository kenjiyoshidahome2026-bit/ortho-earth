// 今日の日めくりを himekuri/today.svg に焼く（GitHub Actions が毎朝 0 時 JST に走らせる）。
// 「今日」は日本時で数える＝ TZ=Asia/Tokyo で走らせる（himekuri の「今日／n日前」も端末の時計で数えるため）。
import { writeFileSync, mkdirSync } from "node:fs";
import { 日カレンダー } from "himekuri";

const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" })
	.format(new Date()).split("-").map(Number);

const svg = 日カレンダー([y, m, d])
	.trim()
	// <img> で貼るので大きさを持たせる（viewBox だけだと幅 0 に潰れる閲覧環境がある）
	.replace("<svg ", `<svg width="400" height="400" `);

mkdirSync("himekuri", { recursive: true });
writeFileSync("himekuri/today.svg", svg + "\n");
console.log(`himekuri/today.svg ← ${y}-${m}-${d}`);
