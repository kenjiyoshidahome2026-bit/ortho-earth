import { DAY_NUMBER, DAY_AFTER, YEAR_DAY, YMD2DAY, YMD2JDN, initAngle, SunDegreeDay, } from "./共通関数.js";
const holidayTub = {};

export function 年間休日(Y) {
    if (holidayTub[Y]) return holidayTub[Y];

    const holidays = {}; // { 年通日インデックス: "祝日名" }

    // ヘルパー関数: 特定の日付を祝日として追加
    const addHoliday = (m, d, name) => {
        const dayIdx = DAY_NUMBER([Y, m, d]);
        holidays[dayIdx] = name;
    };

    // ヘルパー関数: ハッピーマンデー（第N月曜日）を計算して追加
    const addHappyMonday = (m, nth, name) => {
        const w = (YMD2JDN([Y, m, 1]) + 3) % 7;
        const firstMon = 1 + (8 - w) % 7; 
        const d = firstMon + (nth - 1) * 7;
        addHoliday(m, d, name);
    };

    // --- 1. 固定祝日とハッピーマンデー (現行法ベース) ---
    addHoliday(1, 1, "元日");
    addHappyMonday(1, 2, "成人の日");
    addHoliday(2, 11, "建国記念の日");
    addHoliday(2, 23, "天皇誕生日");
    addHoliday(4, 29, "昭和の日");
    addHoliday(5, 3, "憲法記念日");
    addHoliday(5, 4, "みどりの日");
    addHoliday(5, 5, "こどもの日");
    addHappyMonday(7, 3, "海の日");
    addHoliday(8, 11, "山の日");
    addHappyMonday(9, 3, "敬老の日");
    addHappyMonday(10, 2, "スポーツの日"); // 2020年以降の名称
    addHoliday(11, 3, "文化の日");
    addHoliday(11, 23, "勤労感謝の日");

    // --- 2. 春分の日・秋分の日の天体計算 ---
    const dt = initAngle(Y, 9);
    const shunbunIdx = Math.floor(SunDegreeDay(Y, 0) - dt);
    const shubunIdx = Math.floor(SunDegreeDay(Y, 180) - dt);
    holidays[shunbunIdx] = "春分の日";
    holidays[shubunIdx] = "秋分の日";

    // --- 3. 振替休日の計算 ---
    const sortedDays = Object.keys(holidays).map(Number).sort((a, b) => a - b);
    let finalHolidays = { ...holidays };

    sortedDays.forEach(dayIdx => {
        const w = (YMD2JDN(DAY_AFTER([Y, 1, 1], dayIdx)) + 3) % 7;
        if (w === 0) { // 祝日が日曜日なら
            let nextDay = dayIdx + 1;
            while (holidays[nextDay]) {
                nextDay++;
            }
            finalHolidays[nextDay] = "振替休日";
        }
    });

    // --- 4. 国民の休日の計算 (オセロ休日) ---
    const finalSorted = Object.keys(finalHolidays).map(Number).sort((a, b) => a - b);
    for (let i = 0; i < finalSorted.length - 1; i++) {
        if (finalSorted[i + 1] - finalSorted[i] === 2) {
            const middleDay = finalSorted[i] + 1;
            const w = (YMD2JDN(DAY_AFTER([Y, 1, 1], middleDay)) + 3) % 7;
            if (w !== 0 && !finalHolidays[middleDay]) {
                finalHolidays[middleDay] = "国民の休日";
            }
        }
    }

    // ==========================================
    // --- 5. 特例法によるパッチ（上書き・削除） ---
    // ==========================================
    const removeHoliday = (m, d) => { delete finalHolidays[DAY_NUMBER([Y, m, d])]; };
    const overrideHoliday = (m, d, name) => { finalHolidays[DAY_NUMBER([Y, m, d])] = name; };

    if (Y === 2019) {
        // 令和への改元に伴う特例
        overrideHoliday(5, 1, "天皇の即位の日");
        overrideHoliday(4, 30, "国民の休日");
        overrideHoliday(5, 2, "国民の休日");
        overrideHoliday(10, 22, "即位礼正殿の儀の行われる日");
    } else if (Y === 2020) {
        // 東京オリンピック特例
        removeHoliday(7, 20);  // 本来の海の日
        removeHoliday(10, 12); // 本来のスポーツの日
        removeHoliday(8, 11);  // 本来の山の日
        
        overrideHoliday(7, 23, "海の日");
        overrideHoliday(7, 24, "スポーツの日");
        overrideHoliday(8, 10, "山の日");
    } else if (Y === 2021) {
        // 東京オリンピック延期に伴う特例
        removeHoliday(7, 19);  // 本来の海の日
        removeHoliday(10, 11); // 本来のスポーツの日
        removeHoliday(8, 11);  // 本来の山の日
        
        overrideHoliday(7, 22, "海の日");
        overrideHoliday(7, 23, "スポーツの日");
        overrideHoliday(8, 8, "山の日");
        overrideHoliday(8, 9, "振替休日"); // 8/8が日曜のため
    }

    return (holidayTub[Y] = finalHolidays);
}
export function 月間休日(YM) { 
    const v = 年間休日(YM[0]), u = {};
    Object.keys(v).forEach(k => {
        const ymd = YEAR_DAY(YM[0], +k); 
        if (ymd[1] === YM[1]) u[ymd[2]] = v[k];
    });
    return u;
}
