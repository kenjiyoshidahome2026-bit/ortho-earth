// 都道府県・市区町村コードの知識（県名・系番号・政令市・振興局・郡）は jp/codes.js が正本。
// ここは既存 import 互換のための再輸出のみ。旧テーブルは兵庫/和歌山の系が入れ替わっていた（正本側で修正済み）
export { PREFS, cityArea } from '../jp/codes.js';

export function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

export function fmtBytes(b) {
    if (!b) return '';
    if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.round(b / 1024)} KB`;
}

export function showToast(msg) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2500);
}
