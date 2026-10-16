// geopbf 内部の小道具（package exports に無い＝外部公開ではない）。未使用 export は 2026-09-16 に剪定＝残りは import 元がある物だけ。
export const isUndefined = (_: unknown): _ is undefined => _ === undefined;
export const isNull = (_: unknown): _ is null => _ === null;
export const isBoolean = (_: unknown): _ is boolean => _ === true || _ === false;
export const isArray = Array.isArray;
export const isNumber = (_: unknown): _ is number => typeof _ === 'number' && Number.isFinite(_);
export const isFloat = (_: unknown): _ is number => isNumber(_) && (_ % 1 !== 0);
export const isString = (_: unknown): _ is string => typeof _ === 'string';
export const isFunction = (_: unknown): _ is Function => typeof _ == 'function';
export const isImageData = (_: unknown): _ is ImageData => typeof ImageData !== 'undefined' && _ instanceof ImageData;   // Node に ImageData は無い（2026-10-11）
export const isDate = (_: unknown): _ is Date => _ instanceof Date;
export const isObject = (_: unknown): _ is Record<string, unknown> => _ !== null && typeof _ === 'object' && !isArray(_);
export const isSimpleObject = (_: unknown): boolean => Object.prototype.toString.call(_) === '[object Object]' && !!Object.keys(_ as object).length;
export const isBuffer = (_: unknown): _ is ArrayBuffer | ArrayBufferView => (_ instanceof ArrayBuffer || ArrayBuffer.isView(_));
export const isBlob = (_: unknown): _ is Blob => (_ instanceof Blob);
export const isFile = (_: unknown): _ is File => (isBlob(_) && ("name" in _));
export const isURL = (_: unknown): boolean => (isString(_) && !!(_.match(/^https?\:\/\//)));
export const isBbox = (_: unknown): _ is number[] => Array.isArray(_) && _.length == 4 && _.every(isNumber)
	&& (-180 <= _[0] && _[0] <= _[2] && _[2] <= 180) && (-90 <= _[1] && _[1] <= _[3] && _[3] <= 90);
export const comma = (_: unknown): string => { if (typeof _ === 'number') return _.toLocaleString('en-US');
	let s = String(_ ?? "").replace(/,/g, ""); const parts = s.split(".");
	parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	return parts.join(".");
};
export const thenMap = async <T, R>(a: ArrayLike<T>, func: (v: T, i: number) => Promise<R>): Promise<(R | void)[]> => { const n = a.length, result: (R | void)[] = [];
	for (let i = 0; i < n; i++) result.push(await func(a[i], i).catch(console.error));
	return result;
};
export const sum = (a: number[] | null | undefined): number => (a || []).reduce((acc, cur) => acc + cur, 0);
// 旧 download／openDirectory／saveTo（File System Access API の保存）は 2.0 で撤去＝使い手なし・saveDire の宣言を欠いたまま写されていた
