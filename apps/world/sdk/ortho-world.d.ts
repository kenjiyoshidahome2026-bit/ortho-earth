// ortho-world 型定義（公開面のみ・手書きの正典）。実装＝apps/world/src/world.js。
// AIエージェント/エディタ補完のための共有語彙＝散文（README）とセットで配布する。

/** 国を指す識別子。ISO 3166-1 alpha-2 / alpha-3 / 数字コード・台帳キー・Wikidata QID・IOC コードのどれでも良い。
 *  大小文字は問わない。例: "JP" | "JPN" | 392 | "Q17" */
export type NationId = string | number;

/** 合図に載る国。**ISO 3166-1 が共通語**（相手が地図である以上、Natural Earth でも GeoJSON でも ISO が共通鍵）。
 *  ISO を持たない主体（南極・アブハジア等 12 件）は iso2/iso3 が空文字＝その場合は key を使う。 */
export interface NationSign {
	/** ISO 3166-1 alpha-2（例 "JP"）。ISO 非収録なら "" */
	iso2: string;
	/** ISO 3166-1 alpha-3（例 "JPN"）。ISO 非収録なら "" */
	iso3: string;
	/** ISO 3166-1 数字コード（例 392）。ISO 非収録なら null */
	isoNum: number | null;
	/** 台帳キー。ISO 収録なら alpha-2 と同じ、非収録は独自キー（"B35" 等）＝**常に在る** */
	key: string;
	/** Wikidata の QID（例 "Q17"） */
	qid: string;
	/** IOC コード（例 "JPN"）。無ければ "" */
	ioc: string;
	/** 英語名（不変の照合用） */
	name: string;
	/** 表示名＝今の言語での名前（UI に出す用） */
	label: string;
	/** 台帳の実体（面積・人口・首都・通貨・言語など。形は予告なく増える） */
	nation: Record<string, unknown>;
}

export interface WorldOptions {
	/** 取り付け先（セレクタ or 要素）。**渡すと「埋め込み」扱い**＝URL を書かず・window に手を生やさず・
	 *  ?lang / ?open を読まない。省略すると #world を探し（無ければ作り）「ページの持ち物」として振る舞う */
	target?: string | HTMLElement;
	/** 初期言語（26言語）。省略時は保存値→ブラウザ言語→"en" */
	lang?: string;
	/** 起動時に開いておく国 */
	open?: NationId;
	/** ページ URL の ?lang= を読み書きする（既定: target を渡したら false） */
	urlHash?: boolean;
	/** window.nations 等の作業用の手を生やす（既定: target を渡したら false） */
	debugGlobals?: boolean;
}

/** on() で受けられる合図。
 *  「準備完了」の合図は無い＝**world() が返す Promise の解決がそれ**（on() を張れるのは解決後なので、
 *  ready イベントは構造的に受け取れない）。 */
export interface WorldEvents {
	/** 国が選ばれた（カードの旗・一覧の旗をクリック） */
	select: NationSign;
	/** 一覧の上でホバー。離れたら null */
	hover: NationSign | null;
	/** 地図アイコン（カードの小さな地図）が押された＝**地図を出したい**。url = その国の地図 PNG */
	map: NationSign & { url: string };
	/** 言語が変わった */
	lang: { lang: string; rtl: boolean };
}

export interface WorldSelector {
	/** 取り付いている div（意匠は .ortho-world の配下に閉じている） */
	readonly el: HTMLElement;
	on<K extends keyof WorldEvents>(ev: K, cb: (e: WorldEvents[K]) => void): WorldSelector;
	off<K extends keyof WorldEvents>(ev: K, cb: (e: WorldEvents[K]) => void): WorldSelector;
	/** 地図の上でホバーされた国を一覧に映す（橙枠＋自動スクロール）。null で解除 */
	hover(id: NationId | null): WorldSelector;
	/** 地図の上でクリックされた国を開く（カードのクリックと同じ＝国旗モーダル） */
	select(id: NationId): WorldSelector;
	/** hover() の解除 */
	clear(): WorldSelector;
	/** 引数なし＝今の言語／あり＝切り替え */
	lang(): string;
	lang(code: string): Promise<void>;
	/** id から国を引く。見つからなければ null */
	nation(id: NationId): NationSign | null;
	/** 今の絞り込み・並べ替えで見えている国 */
	list(): NationSign[];
	/** 箱ごと片付ける（中身を消し、外に張った手も全部外す） */
	destroy(): void;
}

/**
 * 国別 DB のビューア／セレクタを div に取り付ける。
 *
 * ⚠ **1 ページ 1 インスタンス**。言語状態と参照表をモジュール変数で持つため、2 つ載せると
 *    後から作った方の言語で両方が描かれる。
 *
 * @example
 * import world from "ortho-world";
 * import "ortho-world/ortho-world.css";
 *
 * const w = await world({ target: "#selector", lang: "ja" });
 * w.on("map", e => showMap(e.url));      // 地図を出したい
 * w.on("select", e => pick(e.iso2));     // 国が選ばれた
 * mapLayer.onHover = iso => w.hover(iso);   // 地図 → 一覧
 */
export default function world(opts?: WorldOptions): Promise<WorldSelector>;
