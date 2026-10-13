// DB ごとの名前表＝DB の隣（<DB>.i18n/<lang>.json）。データに結びつく名前（国・都市・地形…＝DB の ID が鍵）は DB と同じ置き場・同じ push で出す
//（本人裁定 2026-10-13「i18n でも、データに深く結びついているものがある」）。画面の文言（ui・categories・plateBoundaries）はプログラム＝i18n/ui.json から直に読む。
// 中身は i18n/<lang>.json の同じ節＝{ updated, lang, <節>: { ID: { name, wiki, … } } }。節の名前を残す＝読む側は何本かを Object.assign で重ねれば旧来の形になる。
export const NAME_SECTIONS = { NationDB: "nations", CityDB: "cities", TerrainDB: "terrains", LanguageDB: "languages", CurrencyDB: "currencies", Conflicts: "conflicts" };

/** i18n/<lang>.json の 1 言語ぶん → { DB 名: その DB の名前表 } */
export const splitNames = (table, lang = table.lang) => Object.fromEntries(Object.entries(NAME_SECTIONS)
	.map(([db, sec]) => [db, { updated: table.updated, lang, [sec]: table[sec] || {} }]));
