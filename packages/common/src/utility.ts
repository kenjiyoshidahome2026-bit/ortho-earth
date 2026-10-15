export const isUndefined = (_: unknown): _ is undefined => _ === undefined;
export const isNull = (_: unknown): _ is null => _ === null;
export const isBoolean = (_: unknown): _ is boolean => _ === true || _ === false;
export const isArray = Array.isArray;
export const isNumber = (_: unknown): _ is number => typeof _ === 'number' && Number.isFinite(_);
export const isFloat = (_: unknown): _ is number => isNumber(_) && (_ % 1 !== 0);
export const isString = (_: unknown): _ is string => typeof _ === 'string';
export const isFunction = (_: unknown): _ is (...args: never[]) => unknown => typeof _ == 'function';
export const isImageData = (_: unknown): _ is ImageData => _ instanceof ImageData;
export const isDate = (_: unknown): _ is Date => _ instanceof Date;
export const isAsync = (_: unknown): boolean => (_ as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag] === 'AsyncFunction';
export const isDOM = (_: unknown): _ is Element => _ instanceof Element;
export const isObject = (_: unknown): _ is Record<string, unknown> => _ !== null && typeof _ === 'object' && !isArray(_);
export const isSimpleObject = (_: unknown): number | false => Object.prototype.toString.call(_) === '[object Object]' && Object.keys(_ as object).length;
export const isBuffer = (_: unknown): _ is ArrayBuffer | ArrayBufferView => (_ instanceof ArrayBuffer || ArrayBuffer.isView(_));
export const isBlob = (_: unknown): _ is Blob => (_ instanceof Blob);
export const isFile = (_: unknown): _ is File => (isBlob(_) && ("name" in _));
export const isURL = (_: unknown): RegExpMatchArray | null | false => (isString(_) && (_.match(/^https?\:\/\//)));
export type Bbox = [number, number, number, number];
export const isBbox = (_: unknown): _ is Bbox => { const a = _ as number[] | null | undefined;
	return !!a && a.length == 4 && a.every(isNumber)
		&& (-180 <= a[0] && a[0] <= a[2] && a[2] <= 180) && (-90 <= a[1] && a[1] <= a[3] && a[3] <= 90);
};
export const toArray = <T>(_: T | T[] | null | undefined): T[] => (_ != null ? isArray(_) ? _ : [_ as T] : []);
export const trim = (_: unknown): string => ("" + (_ as string)).replace(/\s+/g, " ").replace(/(^\s+|\s+$)/g, "");
export const strfix = (_: unknown): string => trim(_).normalize('NFKC');
export const tostr = async (_: unknown): Promise<unknown> => _ ? isDOM(_) ? _.outerHTML : isFunction(_) ? isAsync(_)? await _(): _() :
	isArray(_) ? _.map(trim).filter(t => t).join("<br/>") : String(_) : "";
export const comma = (_: unknown): string => { if (typeof _ === 'number') return _.toLocaleString();
	let s = String(_ ?? "").replace(/,/g, ""); const parts = s.split(".");
	parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	return parts.join(".");
};
export const jsonSize = (f: unknown): string => (new Blob([JSON.stringify(f)],{type: "text/plain"}).size/1024/1024).toFixed(3)+" MB";
export const clearObject = (q: object): void => { for (const _ of Object.getOwnPropertyNames(q)) delete (q as Record<string, unknown>)[_]; };
const pad = (n: unknown, len: number): string => String(n).padStart(len, '0');
export const L2 = (n: unknown): string => pad(n, 2);
export const L3 = (n: unknown): string => pad(n, 3);
export const L4 = (n: unknown): string => pad(n, 4);
export const L5 = (n: unknown): string => pad(n, 5);
type DateLike = string | number | Date | null | undefined;
export const dateArray = (_?: DateLike): (number | string)[] => { const d = _ == null ? new Date() : new Date(_); return ([d.getFullYear()] as (number | string)[]).concat([d.getMonth() + 1, d.getDate()].map(L2)); };
export const timeArray = (_?: DateLike): string[] => { const d = _ == null ? new Date() : new Date(_); return [d.getHours(), d.getMinutes(), d.getSeconds()].map(L2); };
export const datimArray = (_?: DateLike): (number | string)[] => [dateArray(_), timeArray(_)].flat();
export const thenEach = async <T>(a: readonly T[], func: (v: T, i: number) => Promise<unknown>): Promise<void> => { const n = a.length;
	for (let i = 0; i < n; i++) await func(a[i], i).catch(console.error);
};
export const thenMap = async <T, R>(a: readonly T[], func: (v: T, i: number) => Promise<R>): Promise<(R | void)[]> => { const n = a.length, result: (R | void)[] = [];
	for (let i = 0; i < n; i++) result.push(await func(a[i], i).catch(console.error));
	return result;
};
export const thread = async <T, R>(a: T[], func: (v: T, th: number) => Promise<R>, n = 4): Promise<R[]> => { const results: R[] = [];
	return new Promise(resolve => { let count = n;
		for (let th = 0; th < n; th++) go(th);
		function go(th: number): void { let v = a.shift();
			v == null ? count-- : func(v, th).then(res => (results.push(res), go(th))).catch(() => go(th));
			count || resolve(results);
		}
	});
};
export const max = (a?: readonly number[] | null): number => Math.max(...(a || []));
export const min = (a?: readonly number[] | null): number => Math.min(...(a || []));
export const sum = (a?: readonly number[] | null): number => (a || []).reduce((acc, cur) => acc + cur, 0);
export const unique = <T>(a: Iterable<T>): T[] => [...new Set(a)];
export const concat = <T>(a: readonly T[][]): T[] => a.flat() as T[];
export const slice = <T>(a: readonly T[], n: number): T[][] => { const q: T[][] = [];
	for (let i = 0; i < a.length; i += n) q.push(a.slice(i, i + n));
	return q;
};
export const random = <T>(a: T[]): T[] => {
	for (let i = a.length - 1; i > 0; i--) {
		let r = Math.floor(Math.random() * (i + 1));
		[a[r], a[i]] = [a[i], a[r]];
	}
	return a;
};
export const xy2yx = <T>(a: readonly (readonly T[])[]): T[][] => { if (!a.length) return [];
	return a[0].map((_, m) => a.map(n => n[m]));
};
let _prevEscapeHandler: ((e: KeyboardEvent) => void) | null = null;
export const escape = (func?: ((e: KeyboardEvent) => void) | null): void => { if (typeof document === 'undefined') return;
	if (_prevEscapeHandler) document.removeEventListener("keyup", _prevEscapeHandler);
	 const handler = (e: KeyboardEvent): void => {
		if (e.key === "Escape" || e.keyCode === 27) {
			e.stopPropagation(); e.preventDefault();
			isFunction(func) && func(e);
		}
	};
   document.addEventListener("keyup", handler);
	_prevEscapeHandler = handler;
};
let saveDire: FileSystemDirectoryHandle | null = null;

export async function inputFile(accept = ""): Promise<File | null> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.style.display = "none";
		if (accept) input.accept = accept;
		input.addEventListener("change", (e) => {
			resolve((e.target as HTMLInputElement).files![0] || null);
			setTimeout(() => input.remove(), 50);
		});
		document.body.appendChild(input);
		input.click();
	});
}
export const download = (blob: Blob, name?: string): void => {
	name = name || (blob as Partial<File>).name || "download";
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url; a.download = name; a.click();
	setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
};
export const openDirectory = async(): Promise<FileSystemDirectoryHandle | null | undefined> => {
	try { saveDire = saveDire || await window.showDirectoryPicker({ mode: 'readwrite' });
		const status = await saveDire.queryPermission({ mode: 'readwrite' });
		if (status === 'granted') return saveDire;
		if (status === 'prompt') {
			const newStatus = await saveDire.requestPermission({ mode: 'readwrite' });
			if (newStatus === 'granted') return saveDire;
			saveDire = null; throw new Error('Permission to access the directory was denied.');
		}
	} catch (err) { console.error("Failed to open directory:", err); return null;}
};
export const saveTo = async(blob: Blob, name?: string): Promise<boolean> => {
	try {
		const dir = await openDirectory();   // 開けた手＝saveDire と同じ物（openDirectory は saveDire を返す）
		if (!dir) return false;
		const fileName = name || (blob as Partial<File>).name || "download";
		const fileHandle = await dir.getFileHandle(fileName, { create: true });
		const writable = await fileHandle.createWritable();
		await writable.write(blob);
		await writable.close();
		console.info(`Saved: ${fileName}`);
		return true;
	} catch (err) {
		if ((err as { name?: string }).name === 'AbortError') return false;
		saveDire = null;
		console.error("Save failed:", err);
		throw err;
	}
};
export const dynamicWebWorker = (worker_url: string | URL, val: unknown): Promise<unknown> => new Promise((resolve,reject)=>{
	let worker: Worker | null = new Worker(worker_url);
	worker.onmessage = e=>{ worker?.terminate(); worker = null; resolve(e.data);}
	worker.onerror = e=>{ worker?.terminate(); reject(e); }
	worker.postMessage(val);
});
