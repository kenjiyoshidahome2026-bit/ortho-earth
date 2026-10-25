// What the translator does not do, said once per kind ("[csshim] unsupported: …") and kept for a report. Never throws.
const seen = new Map<string, number>();

export function unsupported(what: string): void {
	const n = seen.get(what) ?? 0;
	seen.set(what, n + 1);
	if (!n) console.warn(`[csshim] unsupported: ${what}`);
}
/** { what: times } of everything reported so far */
export function unsupportedReport(): Record<string, number> {
	return Object.fromEntries(seen);
}
