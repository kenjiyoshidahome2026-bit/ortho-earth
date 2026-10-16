// meshdecode.js（JS のまま＝group M）の型。sunshadow.ts が読む分だけ（TS 化 段 4・batch 3）＝meshdecode.js が TS になれば消える。

/** tileset.json を辿って葉のタイル（uri・中心の経緯度）を集める。clip＝[w,s,e,n]（度）の外の枝は落とす */
export function collectLeafTiles(tilesetUrl: string, depth?: number, onScan?: (() => void) | null, stop?: (() => boolean) | null, clip?: readonly number[] | null): Promise<Array<{ uri: string; center: number[] | null }>>;
