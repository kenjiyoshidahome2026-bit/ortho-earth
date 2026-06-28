// node test-antimeridian.js
import { antimeridianFeature } from "./src/modules/antimeridianFeature.js";

let pass = 0, fail = 0;
function assert(label, condition) {
    if (condition) { console.log(`  ✓ ${label}`); pass++; }
    else           { console.error(`  ✗ ${label}`); fail++; }
}
// closed ring helper
const close = r => {
    const last = r[r.length - 1];
    return (r[0][0] === last[0] && r[0][1] === last[1]) ? r : [...r, r[0]];
};
// MultiPolygon: coords=[poly,...], poly=[ring,...], ring=[[x,y],...]
// Polygon:      coords=[ring,...], ring=[[x,y],...]
const allInRange = f => {
    const c = f.geometry.coordinates;
    const rings = f.geometry.type === "MultiPolygon"
        ? c.flatMap(p => p)   // MultiPolygon → flatten to rings
        : c;                  // Polygon → already rings
    return rings.every(ring => ring.every(([x]) => x >= -180 && x <= 180));
};
const numPolys  = f => f.geometry.type === "MultiPolygon" ? f.geometry.coordinates.length : 1;
const numRings  = (f, polyIdx) => f.geometry.type === "MultiPolygon"
    ? f.geometry.coordinates[polyIdx].length
    : f.geometry.coordinates.length;

// ─── Test 1: 日付変更線を跨ぐポリゴン（穴なし）────────────────────────────
// 170E〜190E(=-170E) を跨ぐ矩形。190 という値で xmax>180 → 早期リターンしない
console.log("\nTest 1: antimeridian polygon, no holes");
{
    const f = antimeridianFeature({
        type: "Feature",
        geometry: {
            type: "Polygon",
            coordinates: [close([[170,-10],[170,10],[190,10],[190,-10]])]
        },
        properties: {}
    });
    assert("MultiPolygon に分割される", f.geometry.type === "MultiPolygon");
    assert("2ポリゴンに分割される", numPolys(f) === 2);
    assert("各ポリゴンが1リング", numRings(f, 0) === 1 && numRings(f, 1) === 1);
    assert("全座標が -180〜180", allInRange(f));
}

// ─── Test 2: 日付変更線を跨ぐポリゴン + 穴が西側のみ ──────────────────────
// 外周: 160E〜200E(=-160E)。穴: 165〜175E (西片に収まる)
console.log("\nTest 2: antimeridian polygon, hole on west side only");
{
    const outer = close([[160,-20],[160,20],[200,20],[200,-20]]);
    const hole  = close([[165,-5],[165,5],[175,5],[175,-5]]);  // 西片 (160〜180) 内
    const f = antimeridianFeature({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [outer, hole] },
        properties: {}
    });
    assert("MultiPolygon に分割される", f.geometry.type === "MultiPolygon");
    assert("2ポリゴンに分割される", numPolys(f) === 2);
    // 穴が西片に入る → 西片が2リング、東片が1リング
    const ringCounts = f.geometry.coordinates.map(p => p.length).sort((a,b)=>a-b);
    assert("穴が西片にのみ割り当てられる (リング数: 1,2)", ringCounts[0] === 1 && ringCounts[1] === 2);
    assert("全座標が -180〜180", allInRange(f));
}

// ─── Test 3: 日付変更線を跨ぐポリゴン + 穴も跨ぐ ─────────────────────────
// 外周: 150E〜210E(=-150E)。穴: 170E〜190E(=-170E)
console.log("\nTest 3: antimeridian polygon, hole also crosses antimeridian");
{
    const outer = close([[150,-30],[150,30],[210,30],[210,-30]]);
    const hole  = close([[170,-10],[170,10],[190,10],[190,-10]]);
    const f = antimeridianFeature({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [outer, hole] },
        properties: {}
    });
    assert("MultiPolygon に分割される", f.geometry.type === "MultiPolygon");
    assert("2ポリゴンに分割される", numPolys(f) === 2);
    // 穴も2片に分割 → 両ポリゴンが各1穴
    const ringCounts = f.geometry.coordinates.map(p => p.length);
    assert("両ポリゴンが穴を持つ (各2リング)", ringCounts[0] === 2 && ringCounts[1] === 2);
    assert("全座標が -180〜180", allInRange(f));
}

// ─── Test 4: 日付変更線を跨がないポリゴン（スルー確認）──────────────────
console.log("\nTest 4: normal polygon, no antimeridian crossing");
{
    const f = antimeridianFeature({
        type: "Feature",
        geometry: {
            type: "Polygon",
            coordinates: [close([[100,-10],[100,10],[120,10],[120,-10]])]
        },
        properties: {}
    });
    assert("Polygon のまま", f.geometry.type === "Polygon");
    assert("1リングのまま", f.geometry.coordinates.length === 1);
}

// ─── Test 5: 穴が外周外に出る片は除外される ─────────────────────────────
// 外周: 175E〜185E(=-175E) の細い帯。穴: 160〜165E（外周の外）
console.log("\nTest 5: hole outside exterior is discarded");
{
    const outer = close([[175,-10],[175,10],[185,10],[185,-10]]);
    const hole  = close([[160,-5],[160,5],[165,5],[165,-5]]);  // 外周の外
    const f = antimeridianFeature({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [outer, hole] },
        properties: {}
    });
    assert("MultiPolygon に分割される", f.geometry.type === "MultiPolygon");
    // 穴はどちらの片にも属さないので除外 → 両片とも1リング
    const ringCounts = f.geometry.coordinates.map(p => p.length);
    assert("穴が除外される（各1リング）", ringCounts.every(n => n === 1));
}

// ─── Test 6: 穴なし + 既に [-180,180] 内 → スルー ──────────────────────
console.log("\nTest 6: polygon fully within [-180,180], no holes");
{
    const f = antimeridianFeature({
        type: "Feature",
        geometry: {
            type: "Polygon",
            coordinates: [close([[-170,-10],[-170,10],[-160,10],[-160,-10]])]
        },
        properties: {}
    });
    assert("Polygon のまま（早期リターン）", f.geometry.type === "Polygon");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
