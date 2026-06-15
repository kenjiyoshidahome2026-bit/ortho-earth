use wasm_bindgen::prelude::*;
use super::{pure_morton_from_int, unpack_to_int, TERMINAL_BIT, WEIGHT_MASK};

/// JS の unPackGint が返す 6 バッファをそのまま保持する。
/// coordinate_stream : L2 アークバッファ（Morton 昇順ソート済み、TERMINAL_BIT なし）
/// arc_meta_stream   : アークメタ [offset, len, _, _, xmin, ymin, xmax, ymax] × arc 数
/// point_buffer      : L1 ポイントバッファ（Morton 昇順ソート済み、TERMINAL_BIT 付き）
/// point_meta_stream : point_meta_stream[i] = point_buffer[i] の feature ID
/// polygon_stream    : [featId, nRings, nArcs, arcIdx, ...] フラット表現
/// polyline_stream   : [featId, nLines, nArcs, arcIdx, ...] フラット表現
#[wasm_bindgen]
pub struct GintConverter {
    coordinate_stream: Vec<u64>,
    arc_meta_stream: Vec<u32>,
    point_buffer: Vec<u64>,
    point_meta_stream: Vec<u32>,
    polygon_stream: Vec<i32>,
    polyline_stream: Vec<i32>,
}

#[wasm_bindgen]
impl GintConverter {
    /// ポイント地物の近傍探索（JS: findPoint と等価）
    /// mix/miy/error はモートン整数空間（SCALE_E 適用済み）
    pub fn identify_point(&self, mix: u32, miy: u32, error: u32) -> i32 {
        let err_sq = (error as i64) * (error as i64);
        let x_min = mix.saturating_sub(error);
        let x_max = mix.saturating_add(error);
        let y_min = miy.saturating_sub(error);
        let y_max = miy.saturating_add(error);

        for quad in compute_sub_quads(x_min, x_max, y_min, y_max).iter().flatten() {
            // L1 バッファは TERMINAL_BIT 付き → qMin/qMax にも付ける
            let q_min = pure_morton_from_int(quad.0, quad.2) | TERMINAL_BIT;
            let q_max = pure_morton_from_int(quad.1, quad.3) | TERMINAL_BIT;

            let start = self.point_buffer.partition_point(|&m| m < q_min);
            for i in start..self.point_buffer.len() {
                let m = self.point_buffer[i];
                if m > q_max { break; }
                let (ix, iy) = unpack_to_int(m);
                if ix >= x_min && ix <= x_max && iy >= y_min && iy <= y_max {
                    let dx = ix as i64 - mix as i64;
                    let dy = iy as i64 - miy as i64;
                    if dx * dx + dy * dy <= err_sq {
                        return self.point_meta_stream[i] as i32;
                    }
                }
            }
        }
        -1
    }

    /// ポリライン地物の近傍探索（JS: findMortonNear と等価）
    pub fn identify_polyline(&self, mix: u32, miy: u32, error: u32) -> i32 {
        let err_sq = (error as i64) * (error as i64);
        let x_min = mix.saturating_sub(error);
        let x_max = mix.saturating_add(error);
        let y_min = miy.saturating_sub(error);
        let y_max = miy.saturating_add(error);

        let mut hit_arcs = std::collections::HashSet::<u32>::new();

        for quad in compute_sub_quads(x_min, x_max, y_min, y_max).iter().flatten() {
            // L2 バッファは TERMINAL_BIT なし → pure_morton_from_int（TERMINAL_BIT なし）を使う
            let q_min = pure_morton_from_int(quad.0, quad.2) & !WEIGHT_MASK;
            let q_max = pure_morton_from_int(quad.1, quad.3) | WEIGHT_MASK;

            let start = self.coordinate_stream.partition_point(|&m| (m & !WEIGHT_MASK) < q_min);
            for i in start..self.coordinate_stream.len() {
                let m = self.coordinate_stream[i];
                if (m & !WEIGHT_MASK) > q_max { break; }
                let (ix, iy) = unpack_to_int(m);
                if ix >= x_min && ix <= x_max && iy >= y_min && iy <= y_max {
                    let dx = ix as i64 - mix as i64;
                    let dy = iy as i64 - miy as i64;
                    if dx * dx + dy * dy <= err_sq {
                        if let Some(aid) = find_arc_id(&self.arc_meta_stream, i as u32) {
                            hit_arcs.insert(aid);
                        }
                    }
                }
            }
        }

        if hit_arcs.is_empty() { return -1; }
        find_feature_by_arcs(&self.polyline_stream, &hit_arcs)
    }

    /// ポリゴン地物の内側判定（JS: findPolygon と等価）
    /// レイキャスティング法（偶奇規則）。error パラメータ不要。
    pub fn identify_polygon(&self, mix: u32, miy: u32) -> i32 {
        let mut pos = 0;
        while pos + 1 < self.polygon_stream.len() {
            let feat_id = self.polygon_stream[pos];
            let num_rings = self.polygon_stream[pos + 1] as usize;
            pos += 2;

            let mut inside = false;

            'rings: for _ in 0..num_rings {
                if pos >= self.polygon_stream.len() { break 'rings; }
                let num_arcs = self.polygon_stream[pos] as usize;
                pos += 1;

                for _ in 0..num_arcs {
                    if pos >= self.polygon_stream.len() { break 'rings; }
                    let arc_raw = self.polygon_stream[pos];
                    let aid = (if arc_raw < 0 { !arc_raw } else { arc_raw }) as usize;
                    pos += 1;

                    let m = aid * 8;
                    if m + 7 >= self.arc_meta_stream.len() { continue; }

                    // アーク BBOX による早期スキップ（JS: meta[mIdx+4..7]）
                    let bx_min = self.arc_meta_stream[m + 4];
                    let by_min = self.arc_meta_stream[m + 5];
                    let bx_max = self.arc_meta_stream[m + 6];
                    let by_max = self.arc_meta_stream[m + 7];
                    if mix < bx_min || mix > bx_max || miy < by_min || miy > by_max { continue; }

                    let off = self.arc_meta_stream[m] as usize;
                    let len = self.arc_meta_stream[m + 1] as usize;

                    // レイキャスティング（偶奇規則）
                    for k in 0..len.saturating_sub(1) {
                        let (ix1, iy1) = unpack_to_int(self.coordinate_stream[off + k]);
                        let (ix2, iy2) = unpack_to_int(self.coordinate_stream[off + k + 1]);
                        let (ix1, iy1, ix2, iy2) = (ix1 as i64, iy1 as i64, ix2 as i64, iy2 as i64);
                        let (qx, qy) = (mix as i64, miy as i64);
                        // JS: ((iy1 > miy) !== (iy2 > miy)) && (mix < (ix2-ix1)*(miy-iy1)/(iy2-iy1) + ix1)
                        if ((iy1 > qy) != (iy2 > qy)) &&
                           ((qx as f64) < (ix2 - ix1) as f64 * (qy - iy1) as f64 / (iy2 - iy1) as f64 + ix1 as f64) {
                            inside = !inside;
                        }
                    }
                }
            }

            if inside { return feat_id; }
        }
        -1
    }
}

/// サブクワッド分割（JS の subQuads 計算と同一ロジック）
/// x_min ^ x_max のビット 31 が立っている場合のみ分割する（単一レベル分解）
fn compute_sub_quads(x_min: u32, x_max: u32, y_min: u32, y_max: u32) -> [Option<(u32, u32, u32, u32)>; 4] {
    let x_mid = if ((x_min ^ x_max) & (1u32 << 31)) != 0 {
        let shift = 31 - (x_min ^ x_max).leading_zeros();
        Some(x_max & !((1u32 << shift) - 1))
    } else { None };

    let y_mid = if ((y_min ^ y_max) & (1u32 << 31)) != 0 {
        let shift = 31 - (y_min ^ y_max).leading_zeros();
        Some(y_max & !((1u32 << shift) - 1))
    } else { None };

    [
        Some((x_min, x_mid.map_or(x_max, |m| m.saturating_sub(1)), y_min, y_mid.map_or(y_max, |m| m.saturating_sub(1)))),
        x_mid.map(|m| (m, x_max, y_min, y_mid.map_or(y_max, |m2| m2.saturating_sub(1)))),
        y_mid.map(|m| (x_min, x_mid.map_or(x_max, |m2| m2.saturating_sub(1)), m, y_max)),
        if x_mid.is_some() && y_mid.is_some() { Some((x_mid.unwrap(), x_max, y_mid.unwrap(), y_max)) } else { None },
    ]
}

/// バッファインデックス idx を含むアーク ID を二分探索で特定する
/// arc_meta_stream は offset 昇順でソートされていることを前提とする
fn find_arc_id(meta: &[u32], idx: u32) -> Option<u32> {
    let n = meta.len() / 8;
    if n == 0 { return None; }
    let mut low = 0usize;
    let mut high = n - 1;
    loop {
        let mid = (low + high) / 2;
        let off = meta[mid * 8];
        let len = meta[mid * 8 + 1];
        if idx >= off && idx < off + len { return Some(mid as u32); }
        if off > idx {
            if mid == 0 { break; }
            high = mid - 1;
        } else {
            low = mid + 1;
            if low > high { break; }
        }
    }
    None
}

/// フラットなフィーチャーストリームからヒットしたアーク ID を含む feature ID を返す
fn find_feature_by_arcs(stream: &[i32], hit_arcs: &std::collections::HashSet<u32>) -> i32 {
    let mut pos = 0;
    while pos + 1 < stream.len() {
        let feat_id = stream[pos];
        let num_groups = stream[pos + 1] as usize;
        pos += 2;
        for _ in 0..num_groups {
            if pos >= stream.len() { break; }
            let num_arcs = stream[pos] as usize;
            pos += 1;
            for _ in 0..num_arcs {
                if pos >= stream.len() { break; }
                let arc_raw = stream[pos];
                let aid = (if arc_raw < 0 { !arc_raw } else { arc_raw }) as u32;
                if hit_arcs.contains(&aid) { return feat_id; }
                pos += 1;
            }
        }
    }
    -1
}
