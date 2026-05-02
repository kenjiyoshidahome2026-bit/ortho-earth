import { YMD2JDN, DATE2YMD, YEAR_LENGTH, MONTH_LENGTH, YMD_COMP, DAY_NUMBER, YMD2DAY, r360, initAngle, SunDegree, SunDegreeDay } from "./共通関数.js"
import { 節説明, 六曜説明, 九星説明, 直説明, 宿説明, 暦注説明 } from "./説明.js"; 
import { 年間休日, 月間休日 } from "./休日.js";
import { 旧暦計算, 九星計算 } from "./旧暦.js";

const 七曜名 = "日月火水木金土".split("");
const Weeks = "SUN|MON|TUE|WED|THU|FRI|SAT".split("|");
const 六曜名 = "大安|赤口|先勝|友引|先負|仏滅".split("|");
const Months = "January|February|March|April|May|June|July|August|September|October|November|December".split("|");
const 和風月名 = "睦月|如月|弥生|卯月|皐月|水無月|文月|葉月|長月|神無月|霜月|師走".split("|");
const 漢数字 = "一|二|三|四|五|六|七|八|九|十|十一|十二|十三|十四|十五|十六|十七|十八|十九|廿|廿一|廿二|廿三|廿四|廿五|廿六|廿七|廿八|廿九|卅|卅一|卅二|卅三".split("|");
const 九星名 = "一白水星|二黒土星|三碧木星|四緑木星|五黄土星|六白金星|七赤金星|八白土星|九紫火星".split("|");
const 十干名 = "甲乙丙丁戊己庚辛壬癸".split("");
const 十二支名 = "子丑寅卯辰巳午未申酉戌亥".split("");
const 十干読 = "きのえ|きのと|ひのえ|ひのと|つちのえ|つちのと|かのえ|かのと|みずのえ|みずのと".split("|");
const 十二支読 = "ね|うし|とら|う|たつ|み|うま|ひつじ|さる|とり|いぬ|い".split("|");
const 十二直名 = "建除満平定執破危成納開閉".split("");
const 二十四山 = "子癸丑艮寅甲卯乙辰巽巳丙午丁未坤申庚酉辛戌乾亥壬".split("");
const 二十七宿名 = "角亢氐房心尾箕斗女虚危室壁奎婁胃昴畢觜参井鬼柳星張翼軫".split("");
const 二十八宿名 = "角亢氐房心尾箕斗牛女虚危室壁奎婁胃昴畢觜参井鬼柳星張翼軫".split("");
const 二十四節気 = {
    "285": "小寒", "300": "大寒", "315": "立春", "330": "雨水", "345": "啓蟄", "0": "春分",
    "15": "清明", "30": "穀雨", "45": "立夏", "60": "小満", "75": "芒種", "90": "夏至",
    "105": "小暑", "120": "大暑", "135": "立秋", "150": "処暑", "165": "白露", "180": "秋分",
    "195": "寒露", "210": "霜降", "225": "立冬", "240": "小雪", "255": "大雪", "270": "冬至",
    "80": "入梅", "100": "半夏生", "297": "土用入", "27": "土用入", "117": "土用入", "207": "土用入"
};
function 元号計算(YMD) {
   const v = YMD_COMP(YMD, [2019, 5, 1]) >= 0 ? ["R", YMD[0] - 2018] :
        YMD_COMP(YMD, [1989, 1, 8]) >= 0 ? ["H", YMD[0] - 1988] :
        YMD_COMP(YMD, [1926, 12, 25]) >= 0 ? ["S", YMD[0] - 1925] :
        YMD_COMP(YMD, [1912, 7, 30]) >= 0 ? ["T", YMD[0] - 1911] :
        YMD_COMP(YMD, [1968, 9, 8]) >= 0 ? ["M", YMD[0] - 1967] : ["", YMD[0]];
    return [({ R: "令和", H: "平成", S: "昭和", T: "大正", M: "明治" })[v[0]], v[1]] || ["", v[1]];
}
function 節気計算(YMD, tdiff = 9) {
    const Y = YMD[0];
    const angle = Object.keys(二十四節気);
    const dt = initAngle(Y, tdiff);
    const p = {};
    angle.forEach(r => p[Math.floor(SunDegreeDay(Y, r) - dt)] = 二十四節気[r]);
    let n = Math.floor(SunDegreeDay(Y, 315) - dt);
    p[n - 1] = "節分"; p[n + 88] = "八十八夜"; p[n + 210] = "二百十日"; p[n + 220] = "二百二十日";
    n = Math.floor(SunDegreeDay(Y, 0) - dt); 
    p[n - 3] = "彼岸入"; p[n + 3] = "彼岸明";
    n = Math.floor(SunDegreeDay(Y, 180) - dt); 
    p[n - 3] = "彼岸入"; p[n + 3] = "彼岸明";
    return p;
}
function 節月計算(Y, tdiff = 9) {
    let angle = []; 
    for (let i = 0; i < 12; i++) angle.push(r360(285 + i * 30));
    const dt = initAngle(Y, tdiff);
    angle = angle.map(r => Math.floor(SunDegreeDay(Y, r) - dt) - 1);
    angle.unshift(Math.floor(SunDegreeDay(Y - 1, 255) - dt) - 1 - YEAR_LENGTH(Y - 1));
    return angle;
}
function 節日計算(YMD) {
    const 年通日 = DAY_NUMBER(YMD) + 1;
    const 節月 = 節月計算(YMD[0]);
    let sY = YMD[0] - 1, sM = 0, sD = 0;
    節月.forEach((t, i) => {
        if (t < 年通日) {
            sM = (i + 10) % 12 + 1; if (sM == 1) sY = YMD[0];
            sD = 年通日 - t;
        }
    });
    return { 年: sY, 月: sM, 日: sD };
}
function 十二直計算(YMD) {
    const 通日 = YMD2JDN(YMD);
    const 年通日 = DAY_NUMBER(YMD) + 1;
    const 節月 = 節月計算(YMD[0]);
	let m0 = 0, d0 = 0, m1 = 0, d1 = 0;
    節月.forEach((t, i) => {
        if (t < 年通日) {
            m0 = (i + 10) % 12 + 1; d0 = 年通日 - t;
            m1 = (i + 9) % 12 + 1; d1 = i ? 年通日 - 節月[i - 1] - 1 : 0;
        }
    });
    const n0 = (12 - (((通日 - d0) + 3) - (m0 + 1)) % 12) % 12;
    const n1 = (12 - (((通日 - d1) + 2) - (m1 + 1)) % 12) % 12;
    return 十二直名[((m1 > n0) ? (12 + d0 - n0 - 1) : (12 + d1 - n1 - 1)) % 12];
}
function 黄経計算(YMD, tdiff = 9) {
    return r360(SunDegree(YMD2JDN(YMD) - YMD2JDN([2000, 1, 1.5])) - initAngle(YMD[0], tdiff));
}
function 日暦情報(YMD) {
    const [年, 月, 日] = YMD;
	const 元号 = 元号計算(YMD);
    const 通日 = YMD2JDN(YMD);
    const 年通日 = DAY_NUMBER(YMD) + 1;
    const 年休日 = 年間休日(YMD[0]);
    const 節気 = 節気計算(YMD);
    const 節日 = 節日計算(YMD);
	const 旧暦 = 旧暦計算(YMD);
    const 九星 = 九星計算(YMD, 節日);
    const 干支 = {
        年: 十干名[(YMD[0] + 6) % 10] + 十二支名[(YMD[0] + 8) % 12],
        月: 十干名[(((旧暦.年 + 2) % 5) * 2 + 旧暦.月 - 1) % 10] + 十二支名[(旧暦.月 + 1) % 12],
        日: 十干名[通日 % 10] + 十二支名[(通日 + 2) % 12]
    };
    const 暦注 = [];
    const 干支Num = (通日 + 50) % 60, 干 = 干支Num % 10, 支 = 干支Num % 12, 月Num = 節日.月 - 1;
    (旧暦.月 == 8 && 旧暦.日 === 1) && 暦注.push("八朔");
    (旧暦.月 == 1 && 旧暦.日 === 1) && 暦注.push("旧正月");
    (旧暦.月 == 1 && 旧暦.日 === 7) && 暦注.push("人日節句(旧暦)");
    (旧暦.月 == 3 && 旧暦.日 === 3) && 暦注.push("上巳節句(旧暦)");
    (旧暦.月 == 5 && 旧暦.日 === 5) && 暦注.push("端午節句(旧暦)");
    (旧暦.月 == 7 && 旧暦.日 === 7) && 暦注.push("七夕節句(旧暦)");
    (旧暦.月 == 9 && 旧暦.日 === 9) && 暦注.push("重陽節句(旧暦)");
    // 暦注下段（土用・受死日・十死日）
    const 黄経 = 黄経計算(YMD);
    (27 <= 黄経 && 黄経 < 45) && 暦注.push("土用");
    (117 <= 黄経 && 黄経 < 135) && 暦注.push((支 === 1) ? "土用の丑" : "土用");
    (207 <= 黄経 && 黄経 < 225) && 暦注.push("土用");
    (297 <= 黄経 && 黄経 < 315) && 暦注.push("土用");
    支 === [10, 4, 11, 5, 0, 6, 1, 7, 2, 8, 3, 9][月Num] && 暦注.push("受死日");
    支 === [9, 5, 1, 9, 5, 1, 9, 5, 1, 9, 5, 1][月Num] && 暦注.push("十死日");
     if (干 === 4) { // 社日
        if (月Num === 1) {
            let 春分通日 = 年通日 - Math.floor(SunDegreeDay(YMD[0], 0));
            (-5 <= 春分通日 && 春分通日 < 5) && 暦注.push("社日");
        } else if (月Num === 7) {
            let 秋分通日 = 年通日 - Math.floor(SunDegreeDay(YMD[0], 180));
            (-5 <= 秋分通日 && 秋分通日 < 5) && 暦注.push("社日");
        }
    }
    // 選日
    [48, 50, 51, 53, 55, 56, 57, 59].includes(干支Num) && 暦注.push("八専");
    [49, 52, 54, 58].includes(干支Num) && 暦注.push("八専間日");
    [20, 21, 23, 24, 26, 27, 28, 29].includes(干支Num) && 暦注.push("十方暮");
    [[3, 11, 19, 27], [2, 10, 18, 26], [1, 9, 17, 25], [4, 12, 20, 28], [5, 13, 21, 29], [6, 14, 22, 30]][(旧暦.月 - 1) % 6]?.includes(旧暦.日) && 暦注.push("不成就日");
    (29 <= 干支Num && 干支Num <= 44) && 暦注.push("天一天上"); 
    支 === [11, 2, 6, 11, 2, 6, 11, 2, 6, 11, 2, 6][月Num] && 暦注.push("三隣亡");
    if (干 === 6) {
        if (月Num === 4 || 月Num === 5) {
            let 夏至通日 = 年通日 - Math.floor(SunDegreeDay(YMD[0], 90));
            (20 <= 夏至通日 && 夏至通日 <= 29) && 暦注.push("初伏");
            (30 <= 夏至通日 && 夏至通日 <= 39) && 暦注.push("中伏");
        } else if (月Num === 6) {
            let 立秋通日 = 年通日 - Math.floor(SunDegreeDay(YMD[0], 135));
            (0 <= 立秋通日 && 立秋通日 <= 9) && 暦注.push("末伏");
        }
    }
    [[1, 6], [9, 2], [0, 3], [3, 4], [5, 6], [9, 6], [0, 7], [3, 8], [9, 6], [9, 10], [11, 0], [3, 0]][月Num].includes(支) && 暦注.push("一粒万倍日");
    (6 <= 干支Num && 干支Num <= 12) && 暦注.push("大犯土");
    (14 <= 干支Num && 干支Num <= 20) && 暦注.push("小犯土");
    if (支 === 4 && 月Num === 11) {
        let 小寒通日 = 年通日 - Math.floor(SunDegreeDay(YMD[0], 285));
        (12 <= 小寒通日 && 小寒通日 <= 23) && 暦注.push("臘日");
    }
    (干支Num === 0) && 暦注.push("甲子");
    (干支Num === 16) && 暦注.push("庚辰");
    if (暦注.length == 0) {
        [1, 4, 7, 22, 28].includes(干支Num) && 暦注.push("五墓日");
        支 === [1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0][月Num] && 暦注.push("帰忌日");
        支 === [1, 7, 2, 8, 3, 9, 4, 10, 5, 11, 6, 0][月Num] && 暦注.push("血忌日");
        支 === [0, 3, 6, 9, 0, 3, 6, 9, 0, 3, 6, 9][月Num] && 暦注.push("天火日");
        支 === [5, 6, 7, 8, 9, 10, 11, 0, 1, 2, 3, 4][月Num] && 暦注.push("地火日");
        [[27, 50], [15, 51, 57], [0, 1, 2, 3, 4, 8, 44, 16, 20, 40, 32, 56], [4, 7, 19, 31, 35, 42, 43, 54, 55, 59],
        [42, 54], [5, 42, 43, 53, 55], [21, 40, 56], [45, 51, 57], [10, 27, 28, 29, 30, 31, 32, 33, 34, 46, 50],
        [1, 5, 13, 24, 25, 34, 35, 37, 48, 49, 53, 59], [24, 42, 48], [24, 43, 48, 59]][旧暦.月 - 1]?.includes(干支Num) && 暦注.push("凶会日");
        節日.日 === [7, 14, 21, 8, 16, 24, 9, 18, 27, 10, 20, 30][月Num] && 暦注.push("往亡日");
        支 === [11, 6, 1, 8, 3, 10, 4, 0, 7, 2, 9, 4][月Num] && 暦注.push("大禍日(" + (十二支名[(月Num + 2) % 12]) + "年生)");
        支 === [0, 3, 6, 9, 0, 3, 6, 9, 0, 3, 6, 9][月Num] && 暦注.push("狼藉日(" + (十二支名[(月Num + 2) % 12]) + "年生)");
        支 === [5, 0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10][月Num] && 暦注.push("滅門日(" + (十二支名[(月Num + 2) % 12]) + "年生)");
        支 === [7, 10, 4, 2, 6, 0, 8, 9, 5, 11, 1, 3][月Num] && 暦注.push("時下食(" + 十二支名[[11, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10][月Num]] + "刻)");
        干支Num === [13, 26, 3, 28, 53, 42, 43, 56, 33, 22, 47, 4][(節日.年 + 8) % 12] && 暦注.push("歳下食");
        (月Num < 3 ? (干支Num === 14) : 月Num < 6 ? (干支Num === 30) : 月Num < 9 ? (干支Num === 44) : 干支Num === 0) && 暦注.push("天赦日");
        [1, 3, 4, 6, 8, 9, 13, 15, 18, 20, 21, 24, 27, 30, 32, 33, 35, 36, 37, 39, 41, 42, 43, 44, 45, 47, 48, 51, 54, 55, 56, 57, 59].includes(干支Num) && 暦注.push("神吉日");
        [7, 8, 9, 13, 15, 18, 20, 23, 28, 31, 38, 40, 41, 42, 45, 46, 47, 52, 55, 56, 57].includes(干支Num) && 暦注.push("大明日");
        ((通日 + 20) % 28 === 22) && 暦注.push("鬼宿日");
        [0, 1, 2, 3, 4, 15, 16, 17, 18, 19, 45, 46, 47, 48, 49].includes(干支Num) && 暦注.push("天恩日");
        [[0, 11], [0, 11], [5, 6], [2, 3], [2, 3], [5, 6], [1, 4, 7, 10], [1, 4, 7, 10], [5, 6], [8, 9], [8, 9], [5, 6]][月Num].includes(支) && 暦注.push("母倉日");
        干 === [2, 0, 8, 6, 2, 0, 8, 6, 2, 0, 8, 6][月Num] && 暦注.push("月徳日");
        (支 === 5 || 支 === 11) && 暦注.push("重日");
        [[0, 6], [1, 7], [4, 5], [2, 8], [3, 9], [4, 5], [0, 6], [1, 7], [4, 5], [2, 8], [3, 9], [4, 5]][月Num].includes(干) && 暦注.push("復日");
    }
    // 黄経関連計算
    const r2day = (y, r) => Math.floor(SunDegreeDay(y, r) - initAngle(y));
    const r = Math.floor(黄経 / 15) * 15;
    let 候 = (黄経 - r < 5) ? "初候" : (黄経 - r < 10) ? "次候" : "末候";
    let r0 = r2day(YMD[0] + ((r == 270 && YMD[1] == 1) ? -1 : 0), r360(r));
    let r1 = r2day(YMD[0] + ((r == 270 && YMD[1] == 12) ? 1 : 0), r360(r + 15));
    if (r1 === 年通日) { r0 = r1; r1 = r2day(YMD[0], r360(r + 30)); 候 = "初候"; }
    const n0 = 年通日 - r0 + (r0 > 年通日 ? YEAR_LENGTH(YMD[0] - 1) : 0) + 1;
    const n1 = r1 - 年通日 + (r1 < 年通日 ? YEAR_LENGTH(YMD[0] - 1) : 0);
    return { 年, 月, 日, 元号, 暦注,
        休日: 年休日[年通日 - 1] || "",
        曜日: 七曜名[(通日 + 3) % 7], Day: Weeks[(通日 + 3) % 7],
        六曜: 六曜名[(旧暦.月 + 旧暦.日) % 6],
		日差: YMD_COMP(YMD),
        十二直: 十二直計算(YMD),
        二十八宿: 二十八宿名[(通日 + 20) % 28],
        二十七宿: 二十七宿名[([11, 13, 15, 17, 19, 21, 24, 0, 2, 4, 7, 9][旧暦.月 - 1] + (旧暦.日 - 1)) % 27],
        年家九星: 九星名[九星.年], 月家九星: 九星名[九星.月], 日家九星: 九星名[九星.日],
        日干支: 干支.日, 日干支読: 十干読[通日 % 10] + "・" + 十二支読[(通日 + 2) % 12],
        節気: 節気[年通日] || "",
        旧暦, 旧暦名: `${旧暦.閏 ? '閏' : ""}${漢数字[旧暦.月 - 1]}月${漢数字[旧暦.日 - 1]}日`,
        旧月: 和風月名[YMD[1] - 1], Month: Months[月 - 1],
        黄経: [黄経, 候, 節気[r0], n0, 節気[r1], n1],
    };
}

export function 日めくり(年月日) { 
 	const {年, 月, 日, 曜日, 日差, Day, 節気, 旧暦, 旧暦名, 暦注, 休日, 元号, 十二直, 二十八宿, 二十七宿, 旧月, Month, 六曜, 日干支, 日干支読, 日家九星, 黄経} = 日暦情報(年月日);
    const 曜日色 = 曜日=="日" ? "red": (曜日 == "土" ? "blue" : "black");
    const 日数 = 日差 ==0? "今日": `${Math.abs(日差).toLocaleString()}日${日差 > 0?"後":"前"}`;
    const 旧暦名dy = ({ 4: "1 6 8 6", 5: "1 5 5 5 5", 6: "0 4.4 4.4 4.4 4.4 4.4", 7: "0 4 4 4 4 4 4" })[旧暦名.length];
	const 月相SVG = 月相(旧暦.日 - 1);
    return `
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" xlinkns="http://www.w3.org/1999/xlink" version="1.1" style="user-select: none;">
        <rect width="100" height="100" fill="#fff"/>
        <circle r="25" fill="#a22" transform="translate(50,38)" style="display:${休日 ? "block" : "none"};"/>
        <g fill="#444" dominant-baseline="middle" text-anchor="middle" font-family="Arial">
            <text font-size="6" transform="translate(50,8)">
                <tspan>${Month}</tspan><tspan> </tspan><tspan>${年}</tspan>
            </text>
            <text font-size="3" transform="translate(50,95)">
				${暦注.map(t => `<tspan>${t}<title><b>${t}</b>: ${暦注説明[t]}</title></tspan>`).join("　")}
			</text>
            <g transform="translate(50,43)">
                <text font-size="55" stroke="#fff" fill="${曜日色}" transform="${日 > 9 ? "scale(0.8 1)" : "scale(1.1 1)"}" stroke-width="0.2" font-weight="700" dominant-baseline="middle">${年月日[2]}</text>
            </g>
            <text font-size="4.5" font-weight="700" transform="translate(50,68)">
                <tspan fill="#a22">${休日}<tspan> <tspan>${節気}<title>${節説明[節気]}</title><tspan>
            </text>
            <text font-size="8" font-weight="700"><tspan fill="${曜日色}" x="10 10 10" y="10 18 26">${曜日}曜日</tspan></text>
            <text font-size="4" fill="${曜日色}" transform="translate(10,33)">${Day}</text>
            <text font-size="8" font-weight="700"><tspan x="90 90" y="10 18">${元号[0]}</tspan></text>
            <text transform="translate(90,28)" font-size="9" font-weight="700">${元号[1] == 1 ? "元" : 元号[1]}</text>
            <text transform="translate(90,36)" font-size="8" font-weight="700">年</text>
            <text transform="translate(90,46)" font-size="9" font-weight="700">${月}</text>
            <text transform="translate(90,54)" font-size="8" font-weight="700">月</text>
            <text transform="translate(90,61)" font-size="4">${旧月}</text>
            <text transform="translate(77,70)" font-size="3">${日数}</text>
            <g transform="translate(85,65) scale(0.1)">${月相SVG}</g>
            <g transform="translate(35,65) scale(0.3)">${月カレンダー(年月日)}</g>
            <text font-size="4" transform="translate(7,40)"><tspan x="0 0" y="0 4">旧暦</tspan></text>
            <text font-size="4" transform="translate(7,50)"><tspan x="0 0 0 0 0 0 0" dy="${旧暦名dy}">${旧暦名}</tspan></text>
            <text font-size="4" transform="translate(13,40)"><tspan x="0 0" dy="0 4">${六曜}</tspan><title>${六曜説明[六曜]}</title></text>
            <text font-size="4" transform="translate(13,50)"><tspan x="0 0" dy="0 4">${日干支}</tspan></text>
            <text font-size="4" transform="translate(13,60)"><tspan x="0 0 0 0" dy="0 4 4 4">${日家九星}<title>${九星説明[日家九星]}</title></tspan></text>
            <text font-size="2.4" transform="translate(18,45)"><tspan x="0 0 0 0 0 0 0 0" dy="0 2.5 2.5 2.5 2.5 2.5 2.5 2.5">${日干支読}</tspan></text>
            <text font-size="2.4" transform="translate(8,78)">十二直</text>
            <text font-size="2.4" transform="translate(18,78)">二十八宿</text>
            <text font-size="2.4" transform="translate(28,78)">二十七宿</text>
            <text font-size="5" font-weight="700" transform="translate(8,86)">${十二直}<title>${直説明[十二直][1]}</title></text>
            <text font-size="5" font-weight="700" transform="translate(18,86)">${二十八宿}<title>${宿説明[二十八宿][1]}</title></text>
            <text font-size="5" font-weight="700" transform="translate(28,86)">${二十七宿}<title>${宿説明[二十七宿][1]}</title></text>
            <text font-size="2.4" transform="translate(8,90)">${直説明[十二直][0]}</text>
            <text font-size="2.4" transform="translate(18,90)">${宿説明[二十八宿][0]}</text>
            <text font-size="2.4" transform="translate(28,90)">${宿説明[二十七宿][0]}</text>
            <text font-size="3" transform="translate(82,78)"><tspan>${黄経[2]}<title>${節説明[黄経[2]]}</title></tspan>${(黄経[3] === 1 ? "初日" : "から" + 黄経[3] + "日目")}(${黄経[1]})</text>
            <text font-size="3" transform="translate(82,83)"><tspan>${黄経[4]}<title>${節説明[黄経[4]]}</title></tspan>まで${黄経[5]}日目</text>
            <text font-size="3" transform="translate(82,88)">(太陽黄経: ${黄経[0].toFixed(2)}度)</text>
        </g>
    </svg>`;
}

function 月カレンダー(YMD) {
    const todayYMD = DATE2YMD();
    const today = (todayYMD[0] == YMD[0] && todayYMD[1] === YMD[1]) ? todayYMD[2] : 0;
    const w = 100 / 8, h = 10;
    const holidays = 月間休日(YMD);
    let y = 22, n = YMD2DAY([YMD[0], YMD[1], 1]);
    const body = 七曜名.map((t, n) => `<text font-size="8" fill="${n ? (n == 6 ? "blue" : "black") : "red"}" x="${w * (n + 1)}" y="12">${t}</text>`);
    for (let i = 1; i <= MONTH_LENGTH(YMD); i++) { 
        const x = w * (n + 1);
        if (today == i) body.push(`<circle cx="${x}" cy="${y-0.5}" r="${h/2}" fill="#fee" stroke="#f40" stroke-width="0.5"/>`);
        if (YMD[2] == i) body.push(`<rect x="${x - h / 2}" y="${y - h / 2-0.5}" width="${h}" height="${h}" fill="#ccc" stroke="#444" stroke-width="0.5"/>`);
        body.push(`<text font-size="8" x="${x}" y="${y}" fill="${holidays[i] || !n ? "red" : (n == 6 ? "blue" : "black")}" tip="${holidays[i] || ""}">${i}</text>`);
        n++; if (n == 7) { n = 0; y += h; }
    }
    return `<svg viewBox="0 0 100 70"><g dominant-baseline="middle">${body.join("")}</g></svg>`;
}

function 月相(n) { 
    const T = 29.530589, r = Math.min(1, Math.max(0, (n / T))), p = Math.floor(r * 4), R = Math.cos(r * 2 * Math.PI);
    const D = `M 0 -50 A 50 50 0 0 ${p < 2 ? 1 : 0} 0 50 A ${Math.abs(50 * R)} 50 0 0 ${p % 2 ? 1 : 0} 0 -50 Z`;
    return `<svg viewBox="-51 -51 102 102">
        <circle r="50" fill="#400"/>
        <path d="${D}" fill="#ff8"/>
        <circle r="50" fill="none" stroke="#000" stroke-width="1"/>
    </svg>`;
}