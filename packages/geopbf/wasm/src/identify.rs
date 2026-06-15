use wasm_bindgen::prelude::*;

const TERMINAL_BIT: u64 = 1u64 << 63;
const WEIGHT_MASK: u64 = 0x3F;

// ── Morton コードユーティリティ（lib.rs と同一実装） ──────────────────────────

#[inline(always)]
fn spread16(mut x: u32) -> u64 {
    x = (x | (x << 8)) & 0x00FF00FF;
    x = (x | (x << 4)) & 0x0F0F0F0F;
    x = (x | (x << 2)) & 0x33333333;
    x = (x | (x << 1)) & 0x55555555;
    x as u64
}

#[inline(always)]
fn compact16(mut m: u32) -> u32 {
    m &= 0x55555555;
    m = (m | (m >> 1)) & 0x33333333;
    m = (m | (m >> 2)) & 0x0F0F0F0F;
    m = (m | (m >> 4)) & 0x00FF00FF;
    m = (m | (m >> 8)) & 0x0000FFFF;
    m & 0xFFFF
}

/// gint.packFromInt と同一: Morton コードを生成し TERMINAL_BIT を付与する
#[inline(always)]
fn pack_from_int(ix: u32, iy: u32) -> u64 {
    let xl = spread16(ix & 0xFFFF);
    let xh = spread16((ix >> 16) & 0xFFFF);
    let yl = spread16(iy & 0xFFFF);
    let yh = spread16((iy >> 16) & 0xFFFF);
    ((xh | (yh << 1)) << 32) | (xl | (yl << 1)) | TERMINAL_BIT
}

/// gint.unpackToInt と同一: L1(TERMINAL_BIT) または L2(WEIGHT_MASK) から (ix, iy) を復元する
#[inline(always)]
fn unpack_to_int(m: u64) -> (u32, u32) {
    let morton = if (m & TERMINAL_BIT) != 0 { m & !TERMINAL_BIT } else { m & !WEIGHT_MASK };
    let low32  = (morton & 0xFFFFFFFF) as u32;
    let high32 = ((morton >> 32) & 0xFFFFFFFF) as u32;
    let ix = (compact16(high32) << 16) | compact16(low32);
    let iy = (compact16(high32 >> 1) << 16) | compact16(low32 >> 1);
    (ix, iy)
}

// ── サブクワッド分割（identify.js compute_sub_quads 相当） ───────────────────
//
// Morton 順探索の効率化のため、クエリ境界ボックスを Morton ビット境界で
// 最大 4 つのサブクワッドに分割する。
// 座標は u32 で扱う（JS の int32 ビット演算相当）。

fn compute_sub_quads(mix: u32, miy: u32, error: u32) -> [Option<(u32, u32, u32, u32)>; 4] {
    let x_min = mix.saturating_sub(error);
    let x_max = mix.saturating_add(error);
    let y_min = miy.saturating_sub(error);
    let y_max = miy.saturating_add(error);

    // XOR の最上位ビット位置でサブクワッド境界を求める（bit 31 のみ考慮）
    let x_mid = if (x_min ^ x_max) & (1u32 << 31) != 0 {
        let shift = 31 - (x_min ^ x_max).leading_zeros();
        Some(x_max & !((1u32 << shift) - 1))
    } else {
        None
    };
    let y_mid = if (y_min ^ y_max) & (1u32 << 31) != 0 {
        let shift = 31 - (y_min ^ y_max).leading_zeros();
        Some(y_max & !((1u32 << shift) - 1))
    } else {
        None
    };

    [
        Some((x_min, x_mid.map_or(x_max, |m| m - 1), y_min, y_mid.map_or(y_max, |m| m - 1))),
        x_mid.map(|m| (m, x_max, y_min, y_mid.map_or(y_max, |m| m - 1))),
        y_mid.map(|m| (x_min, x_mid.map_or(x_max, |m| m - 1), m, y_max)),
        if x_mid.is_some() && y_mid.is_some() {
            Some((x_mid.unwrap(), x_max, y_mid.unwrap(), y_max))
        } else {
            None
        },
    ]
}

// ── findPoint 相当 ───────────────────────────────────────────────────────────
//
// point_buffer は buildPoints でモートン順にソート済み → 二分探索が有効。

fn find_point(point_buffer: &[u64], point_meta: &[u32], mix: u32, miy: u32, error: u32) -> i32 {
    let err_sq = (error as i64) * (error as i64);
    let x_min = mix.saturating_sub(error);
    let x_max = mix.saturating_add(error);
    let y_min = miy.saturating_sub(error);
    let y_max = miy.saturating_add(error);

    for quad in compute_sub_quads(mix, miy, error).iter().flatten() {
        let q_min = pack_from_int(quad.0, quad.2);
        let q_max = pack_from_int(quad.1, quad.3);

        // partition_point で「>= q_min の最左インデックス」を確実に取得
        let start = point_buffer.partition_point(|&m| m < q_min);

        for i in start..point_buffer.len() {
            let m = point_buffer[i];
            if m > q_max { break; }
            let (ix, iy) = unpack_to_int(m);
            if ix >= x_min && ix <= x_max && iy >= y_min && iy <= y_max {
                let dx = ix as i64 - mix as i64;
                let dy = iy as i64 - miy as i64;
                if dx * dx + dy * dy <= err_sq {
                    return point_meta[i] as i32;
                }
            }
        }
    }
    -1
}

// ── findMortonNear 相当 ──────────────────────────────────────────────────────
//
// arc_buffer はアーク重み順に並んでいてモートン順ではない。
// JS 版の二分探索は unsorted データへの誤用のため、ここでは
// arc_meta のバウンディングボックスを使ったアーク単位の線形スキャンを行う。
// これにより JS 版より正確かつ、全頂点スキャンより効率的になる。

fn find_morton_near(arc_buffer: &[u64], arc_meta: &[u32], mix: u32, miy: u32, error: u32) -> Vec<u32> {
    let err_sq = (error as i64) * (error as i64);
    let x_min = mix.saturating_sub(error);
    let x_max = mix.saturating_add(error);
    let y_min = miy.saturating_sub(error);
    let y_max = miy.saturating_add(error);
    let arc_count = arc_meta.len() / 8;
    let mut hit_arcs: Vec<u32> = Vec::new();

    'arc: for aid in 0..arc_count {
        let m = aid * 8;
        // arc_meta レイアウト: [off, len, weight, _, xmin, ymin, xmax, ymax]
        if x_max < arc_meta[m + 4] || x_min > arc_meta[m + 6]
            || y_max < arc_meta[m + 5] || y_min > arc_meta[m + 7]
        {
            continue;
        }
        let off = arc_meta[m] as usize;
        let len = arc_meta[m + 1] as usize;
        for k in off..(off + len).min(arc_buffer.len()) {
            let (ix, iy) = unpack_to_int(arc_buffer[k]);
            if ix >= x_min && ix <= x_max && iy >= y_min && iy <= y_max {
                let dx = ix as i64 - mix as i64;
                let dy = iy as i64 - miy as i64;
                if dx * dx + dy * dy <= err_sq {
                    hit_arcs.push(aid as u32);
                    continue 'arc; // このアークはヒット済み、次のアークへ
                }
            }
        }
    }
    hit_arcs
}

// ── ポリライン特定 ───────────────────────────────────────────────────────────
//
// polyline_index フラット形式（JS側でシリアライズ）:
//   [feat_id, num_lines, [num_arcs, arc_idx...] * num_lines] * num_features

fn find_polyline_id(polyline_index: &[i32], hit_arcs: &[u32]) -> i32 {
    let mut pos = 0;
    while pos + 1 < polyline_index.len() {
        let feat_id    = polyline_index[pos];
        let num_lines  = polyline_index[pos + 1] as usize;
        pos += 2;
        for _ in 0..num_lines {
            if pos >= polyline_index.len() { break; }
            let num_arcs = polyline_index[pos] as usize;
            pos += 1;
            for _ in 0..num_arcs {
                if pos >= polyline_index.len() { break; }
                let arc_idx = polyline_index[pos];
                let aid = (if arc_idx < 0 { !arc_idx } else { arc_idx }) as u32;
                if hit_arcs.contains(&aid) { return feat_id; }
                pos += 1;
            }
        }
    }
    -1
}

// ── findPolygon 相当（レイキャスティング） ───────────────────────────────────
//
// polygon_index フラット形式（JS側でシリアライズ）:
//   [feat_id, num_parts, [num_rings, [num_arcs, arc_idx...] * num_rings] * num_parts] * num_features
//
// identify.js の findPolygon と同一の偶奇規則（even-odd rule）を実装する。
// ポリゴン部品ごとに inside を独立してリセットすることで MultiPolygon を正しく処理する。

fn find_polygon(arc_buffer: &[u64], arc_meta: &[u32], polygon_index: &[i32], mix: u32, miy: u32) -> i32 {
    let mut pos = 0;
    while pos + 1 < polygon_index.len() {
        let feat_id   = polygon_index[pos];
        let num_parts = polygon_index[pos + 1] as usize;
        pos += 2;

        for _ in 0..num_parts {
            let mut inside = false;
            if pos >= polygon_index.len() { break; }
            let num_rings = polygon_index[pos] as usize;
            pos += 1;

            for _ in 0..num_rings {
                if pos >= polygon_index.len() { break; }
                let num_arcs = polygon_index[pos] as usize;
                pos += 1;

                for _ in 0..num_arcs {
                    if pos >= polygon_index.len() { break; }
                    let arc_idx = polygon_index[pos];
                    pos += 1;
                    let aid = (if arc_idx < 0 { !arc_idx } else { arc_idx }) as usize;
                    let m = aid * 8;
                    if m + 7 >= arc_meta.len() { continue; }

                    // バウンディングボックス: アークが点の左・上・下にあれば交差なし → スキップ
                    // arc_meta レイアウト: [off, len, weight, _, xmin, ymin, xmax, ymax]
                    if mix > arc_meta[m + 6] || miy < arc_meta[m + 5] || miy > arc_meta[m + 7] {
                        continue;
                    }

                    let off = arc_meta[m] as usize;
                    let len = arc_meta[m + 1] as usize;

                    // レイキャスティング: y = miy の水平線との交差を数える
                    for k in 0..len.saturating_sub(1) {
                        if off + k + 1 >= arc_buffer.len() { break; }
                        let (ix1, iy1) = unpack_to_int(arc_buffer[off + k]);
                        let (ix2, iy2) = unpack_to_int(arc_buffer[off + k + 1]);

                        if (iy1 > miy) != (iy2 > miy) {
                            // 交差 x 座標を整数演算で求める（符号付き）
                            let cross_x = (ix2 as i64 - ix1 as i64)
                                * (miy as i64 - iy1 as i64)
                                / (iy2 as i64 - iy1 as i64)
                                + ix1 as i64;
                            if (mix as i64) < cross_x {
                                inside = !inside;
                            }
                        }
                    }
                }
            }

            if inside { return feat_id; }
        }
    }
    -1
}

// ── WASM エクスポート ─────────────────────────────────────────────────────────

/// 点フィーチャーの最近傍探索。
/// point_buf_ptr: BigUint64Array (モートン順ソート済み) へのポインタ
/// point_meta_ptr: Uint32Array (オーナー ID) へのポインタ
/// mix, miy, error: gint.SCALE_E 単位の整数座標・誤差半径
#[wasm_bindgen]
pub fn identify_point_wasm(
    point_buf_ptr: *const u64,
    point_buf_len: usize,
    point_meta_ptr: *const u32,
    mix: u32,
    miy: u32,
    error: u32,
) -> i32 {
    unsafe {
        let point_buffer = std::slice::from_raw_parts(point_buf_ptr, point_buf_len);
        let point_meta   = std::slice::from_raw_parts(point_meta_ptr, point_buf_len);
        find_point(point_buffer, point_meta, mix, miy, error)
    }
}

/// ポリライン最近傍探索。
/// arc_buf_ptr: BigUint64Array (polygon + polyline アーク連結) へのポインタ
/// arc_meta_ptr: Uint32Array (アーク数 × 8) へのポインタ
/// polyline_idx_ptr: Int32Array (フラットシリアライズ済みポリライン構造) へのポインタ
///   形式: [feat_id, num_lines, [num_arcs, arc_idx...] * num_lines] * num_features
#[wasm_bindgen]
pub fn identify_polyline_wasm(
    arc_buf_ptr: *const u64,
    arc_buf_len: usize,
    arc_meta_ptr: *const u32,
    arc_meta_len: usize,
    polyline_idx_ptr: *const i32,
    polyline_idx_len: usize,
    mix: u32,
    miy: u32,
    error: u32,
) -> i32 {
    unsafe {
        let arc_buffer     = std::slice::from_raw_parts(arc_buf_ptr, arc_buf_len);
        let arc_meta       = std::slice::from_raw_parts(arc_meta_ptr, arc_meta_len);
        let polyline_index = std::slice::from_raw_parts(polyline_idx_ptr, polyline_idx_len);
        let hit_arcs = find_morton_near(arc_buffer, arc_meta, mix, miy, error);
        if hit_arcs.is_empty() { return -1; }
        find_polyline_id(polyline_index, &hit_arcs)
    }
}

/// ポリゴン内外判定（レイキャスティング）。
/// polygon_idx_ptr: Int32Array (フラットシリアライズ済みポリゴン構造) へのポインタ
///   形式: [feat_id, num_parts, [num_rings, [num_arcs, arc_idx...] * num_rings] * num_parts] * num_features
#[wasm_bindgen]
pub fn identify_polygon_wasm(
    arc_buf_ptr: *const u64,
    arc_buf_len: usize,
    arc_meta_ptr: *const u32,
    arc_meta_len: usize,
    polygon_idx_ptr: *const i32,
    polygon_idx_len: usize,
    mix: u32,
    miy: u32,
) -> i32 {
    unsafe {
        let arc_buffer    = std::slice::from_raw_parts(arc_buf_ptr, arc_buf_len);
        let arc_meta      = std::slice::from_raw_parts(arc_meta_ptr, arc_meta_len);
        let polygon_index = std::slice::from_raw_parts(polygon_idx_ptr, polygon_idx_len);
        find_polygon(arc_buffer, arc_meta, polygon_index, mix, miy)
    }
}
