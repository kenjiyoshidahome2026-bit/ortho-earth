// geopbf 内部の小道具（package exports に無い＝外部公開ではない）。未使用 export は 2026-09-16 に剪定＝残りは import 元がある物だけ。
export const isUndefined = _ => _ === undefined;
export const isNull = _ => _ === null;
export const isBoolean = _ => _ === true || _ === false;
export const isArray = Array.isArray;
export const isNumber = _ => typeof _ === 'number' && Number.isFinite(_);
export const isFloat = _ => isNumber(_) && (_ % 1 !== 0);
export const isString = _ => typeof _ === 'string';
export const isFunction = _ => typeof _ == 'function';
export const isImageData = _ => typeof ImageData !== 'undefined' && _ instanceof ImageData;   // Node に ImageData は無い（2026-10-11）
export const isDate = _ => _ instanceof Date;
export const isObject = _ => _ !== null && typeof _ === 'object' && !isArray(_);
export const isSimpleObject = _ => Object.prototype.toString.call(_) === '[object Object]' && Object.keys(_).length;
export const isBuffer = _ => (_ instanceof ArrayBuffer || ArrayBuffer.isView(_));
export const isBlob = _ => (_ instanceof Blob);
export const isFile = _ => (isBlob(_) && ("name" in _));
export const isURL = _ => (isString(_) && (_.match(/^https?\:\/\//)));
export const isBbox = _ => _ && _.length == 4 && _.every(isNumber)
	&& (-180 <= _[0] && _[0] <= _[2] && _[2] <= 180) && (-90 <= _[1] && _[1] <= _[3] && _[3] <= 90);
export const comma = _ => { if (typeof _ === 'number') return _.toLocaleString('en-US');
	let s = String(_ ?? "").replace(/,/g, ""); const parts = s.split(".");
	parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	return parts.join(".");
};
export const thenMap = async(a, func) => { const n = a.length, result = [];
	for (let i = 0; i < n; i++) result.push(await func(a[i], i).catch(console.error));
	return result;
};
export const sum = a => (a || []).reduce((acc, cur) => acc + cur, 0);
// 旧 download／openDirectory／saveTo（File System Access API の保存）は 2.0 で撤去＝使い手なし・saveDire の宣言を欠いたまま写されていた
