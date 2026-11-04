// URL の調律ノブ（?paz=N 等）の読み取り。globe と mesh/manager が同じ物を持っていた＝一本化（2026-11-05）。location を読む＝main でだけ呼ぶ

/** location.search を re で見て、1 番目の捕捉を数に（無ければ def） */
export const qNum = (re: RegExp, def: number): number => { const m = location.search.match(re); return m ? +m[1] : def; };
