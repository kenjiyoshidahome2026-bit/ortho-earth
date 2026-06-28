export const PREFS = {
    '01':'北海道','02':'青森','03':'岩手','04':'宮城','05':'秋田',
    '06':'山形','07':'福島','08':'茨城','09':'栃木','10':'群馬',
    '11':'埼玉','12':'千葉','13':'東京','14':'神奈川','15':'新潟',
    '16':'富山','17':'石川','18':'福井','19':'山梨','20':'長野',
    '21':'岐阜','22':'静岡','23':'愛知','24':'三重','25':'滋賀',
    '26':'京都','27':'大阪','28':'兵庫','29':'奈良','30':'和歌山',
    '31':'鳥取','32':'島根','33':'岡山','34':'広島','35':'山口',
    '36':'徳島','37':'香川','38':'愛媛','39':'高知','40':'福岡',
    '41':'佐賀','42':'長崎','43':'熊本','44':'大分','45':'宮崎',
    '46':'鹿児島','47':'沖縄',
};

const PREF_TO_AREA = {
    1:12,2:10,3:10,4:10,5:10,6:10,7:9,8:9,9:9,10:9,11:9,12:9,13:9,14:9,
    15:8,16:7,17:7,18:6,19:8,20:8,21:7,22:8,23:7,
    24:6,25:6,26:6,27:6,28:6,29:6,30:5,
    31:5,32:3,33:5,34:3,35:3,
    36:4,37:4,38:4,39:4,
    40:2,41:2,42:1,43:2,44:2,45:2,46:2,47:15,
};

const HOKKAIDO_AREA11 = new Set([
    1202,1203,1233,1236,1331,1332,1333,1334,1337,1343,1345,1346,1347,
    1361,1362,1363,1364,1367,1370,1371,
    1391,1392,1393,1394,1395,1396,1397,1398,1399,
    1400,1401,1402,1403,1404,1405,1406,1407,1408,1409,1571,1575,1584,
]);
const HOKKAIDO_AREA13 = new Set([
    1206,1207,1208,1211,1223,
    1543,1544,1545,1546,1547,1549,1550,1552,1564,
    1631,1632,1633,1634,1635,1636,1637,1638,1639,
    1641,1642,1643,1644,1645,1646,1647,1648,1649,
    1661,1662,1663,1664,1665,1667,1668,1691,1692,1693,1694,
]);
const AMAMI_CODES    = new Set([46207,46222,46523,46524,46525,46527,46529,46530,46531,46532,46533,46534,46535]);
const SAKISHIMA_CODES = new Set([47207,47214,47381,47382]);

export function cityArea(code5) {
    const num  = parseInt(code5, 10);
    const pref = Math.floor(num / 1000);
    if (pref === 1)  { return HOKKAIDO_AREA11.has(num) ? 11 : HOKKAIDO_AREA13.has(num) ? 13 : 12; }
    if (pref === 46) { return AMAMI_CODES.has(num) ? 1 : 2; }
    if (pref === 47) {
        if (num === 47303 || num === 47304) return 17;
        if (SAKISHIMA_CODES.has(num)) return 16;
        return 15;
    }
    if (pref === 13 && num === 13421) return 14;
    return PREF_TO_AREA[pref] ?? 9;
}

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
