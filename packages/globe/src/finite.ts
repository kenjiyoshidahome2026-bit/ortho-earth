// 「数なら数・でなければ既定値」の 1 本（light・postchain・weather・gltf-meta が同じ式を持っていた＝一本化・2026-11-05）。依存ゼロ・DOM 無し

/** v を数に直して有限ならそれ、でなければ d（null・undefined・"abc"・NaN・Infinity は d） */
export const fin = (v: unknown, d: number): number => (Number.isFinite(+(v as number)) ? +(v as number) : d);
