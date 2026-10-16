// src/cli/args.ts ── CLI の引数の表と読み手（改良点 16・2026-10-12）。src/cli/geopbf.ts が使い、tests/t-cli.mjs が直接も検定する。
//   ・SPEC: コマンドごとの使い方の 1 行・値を取るオプション・真偽のオプション。ここに無い --flag は拒む（旧＝黙って無視＝打ち間違いが通った）
//   ・別名: --min-zoom/--max-zoom（＝--minzoom/--maxzoom・他のオプションと同じハイフン区切り）。旧名はそのまま使える
//   ・--name=value の形も読む。"--" 以降は位置引数
//   ・数値のオプションは numOpt で範囲つきに検査（旧＝`+opts.x` で NaN が黙って通った）。--precision は precisionOpt（1〜9 の整数）に一元化
//   ・使い方の誤りは UsageError（終了コード 2・t() の文）。実行時の失敗は Error（終了コード 1）
import { t } from "./messages.ts";

const ATTR = ["include", "exclude"] as const, ATTR_F = ["exclude-all"] as const, GZ = ["no-gzip"] as const, DATUM = ["tky2jgd", "patchjgd"] as const, GPU = ["gpu", "no-gpu"] as const;
export interface CmdSpec { usage: string; valued: readonly string[]; flags: readonly string[]; min: number }
export const SPEC = {
	enc:            { usage: "enc <in.geojson|in.ndjson> <out.geopbf>", valued: ["precision", "name"], flags: GZ, min: 2 },
	dec:            { usage: "dec <in.geopbf> <out.geojson>", valued: [], flags: [], min: 2 },
	info:           { usage: "info <in.geopbf>", valued: [], flags: [], min: 1 },
	lod:            { usage: "lod <in.geopbf>", valued: [], flags: [], min: 1 },
	cog:            { usage: "cog info <url|file.tif> [--bench] | cog png <url|file.tif> <out.png> [--level N] [--width N]", valued: ["level", "width"], flags: ["bench"], min: 2 },
	pmtiles:        { usage: "pmtiles <in.geopbf> <out.pmtiles>", valued: ["minzoom", "maxzoom", "extent", "buffer", "layer", "gint", "lod-bias", "workers", "drop-rate", "tiny-polygon", "tiny-line", "simplification", ...ATTR], flags: [...GPU, ...ATTR_F], min: 2 },
	parquet:        { usage: "parquet <in.geopbf> <out.parquet>", valued: ["compression", "row-group", "order", ...ATTR], flags: [...GPU, "no-bbox", ...ATTR_F], min: 2 },
	parquet2pbf:    { usage: "parquet2pbf <in.parquet> <out.geopbf>", valued: ["precision", "name", "geometry", ...ATTR], flags: ["ignore-crs", ...GZ, ...ATTR_F], min: 2 },
	gpkg2pbf:       { usage: "gpkg2pbf <in.gpkg> [out.geopbf] [--layer name]", valued: ["precision", "name", "layer", ...ATTR, ...DATUM], flags: ["ignore-crs", ...GZ, ...ATTR_F], min: 1 },
	spatialite2pbf: { usage: "spatialite2pbf <in.sqlite> [out.geopbf] [--layer name]", valued: ["precision", "name", "layer", ...ATTR, ...DATUM], flags: ["ignore-crs", ...GZ, ...ATTR_F], min: 1 },
	dxf2pbf:        { usage: "dxf2pbf <in.dxf> [out.geopbf] [--crs 6677]", valued: ["precision", "name", "crs", "unit", "encoding", ...DATUM], flags: ["ignore-crs", "closed-lines", ...GZ], min: 1 },
	csv2pbf:        { usage: "csv2pbf <in.csv|tsv|xlsx> <out.geopbf>", valued: ["precision", "name", "lon", "lat", "wkt", "sheet", "encoding", "fallback-encoding", "delimiter", ...ATTR], flags: [...GZ, ...ATTR_F], min: 2 },
	gdb2pbf:        { usage: "gdb2pbf <in.gdb|in.zip> [out.geopbf] [--layer name]", valued: ["precision", "name", "layer", ...ATTR, ...DATUM], flags: ["ignore-crs", ...GZ, ...ATTR_F], min: 1 },
} as const satisfies Record<string, CmdSpec>;
// parseArgs の返す opts の型：値を取るオプションは文字列・真偽のオプションは true（SPEC から引く＝表と型がずれない）
type AnySpec = (typeof SPEC)[keyof typeof SPEC];
export type ValuedOpt = AnySpec["valued"][number];
export type FlagOpt = AnySpec["flags"][number];
export type Opts = { [K in ValuedOpt]?: string } & { [K in FlagOpt]?: true };
export const ALIASES: Record<string, string> = { "min-zoom": "minzoom", "max-zoom": "maxzoom" };

export class UsageError extends Error { declare exitCode: number; constructor(msg: string) { super(msg); this.name = "UsageError"; this.exitCode = 2; } }

// 引数を「位置引数」と「オプション」に一度で分ける。cmd の SPEC に無いオプションは UsageError。
export function parseArgs(cmd: string, argv: string[]): { pos: string[]; opts: Opts } {
	const spec = (SPEC as Record<string, CmdSpec>)[cmd]; if (!spec) throw new UsageError(t("unknownCommand", { cmd }).trim());
	const pos: string[] = [], opts: Record<string, string | true> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--") { pos.push(...argv.slice(i + 1)); break; }
		if (!a.startsWith("--") || a.length === 2) { pos.push(a); continue; }
		const eq = a.indexOf("="); let name = eq > 0 ? a.slice(2, eq) : a.slice(2);
		name = ALIASES[name] ?? name;
		if (spec.valued.includes(name)) {
			const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
			if (v === undefined) throw new UsageError(t("optionNeedsValue", { cmd, opt: "--" + name }));
			opts[name] = v;
		} else if (spec.flags.includes(name)) {
			if (eq > 0) throw new UsageError(t("optionNoValue", { cmd, opt: "--" + name }));
			opts[name] = true;
		} else throw new UsageError(t("unknownOption", { cmd, opt: a, list: [...spec.valued, ...spec.flags].map(o => "--" + o).join(" ") }));
	}
	if (pos.length < spec.min) throw new UsageError(t("missingArgs", { usage: spec.usage }));
	precisionOpt(opts as Opts);   // --precision は読み込みの前に検査（ファイルを読んでから落ちない）
	return { pos, opts: opts as Opts };
}

// 数値のオプション: 無ければ undefined。整数・範囲を検査して UsageError
export function numOpt(opts: Opts, name: ValuedOpt, { int = false, min = -Infinity, max = Infinity }: { int?: boolean; min?: number; max?: number } = {}): number | undefined {
	const raw = opts[name]; if (raw === undefined) return undefined;
	const v = Number(raw);
	if (!Number.isFinite(v) || (int && !Number.isInteger(v)) || v < min || v > max)
		throw new UsageError(t("numberOption", { opt: "--" + name, kind: int ? t("integer") : t("number"), range: min === -Infinity && max === Infinity ? "" : ` ${min === -Infinity ? "" : min}..${max === Infinity ? "" : max}`, got: String(raw) }));
	return v;
}
// --precision: 1〜9 の整数（0 は pbf-base の `precision || 6` が黙って 6 に落とすので範囲外）。旧＝enc だけ検査・他は +opts.precision
export function precisionOpt(opts: Opts): number | undefined {
	if (opts.precision === undefined) return undefined;
	const v = Number(opts.precision);
	if (!(Number.isInteger(v) && v >= 1 && v <= 9)) throw new UsageError(t("precisionRange"));
	return v;
}
