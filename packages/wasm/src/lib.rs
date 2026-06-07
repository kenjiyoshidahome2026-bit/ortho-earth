use wasm_bindgen::prelude::*;
use std::collections::BinaryHeap;
use std::cmp::Ordering;

const TERMINAL_BIT: u64 = 1 << 63;
const WEIGHT_MASK: u64 = 0x3F;
const SCALE_E: f64 = 10000000.0;
const INV_SCALE_E: f64 = 1.0 / SCALE_E;
const RAD: f64 = std::f64::consts::PI / 180.0;

#[derive(Copy, Clone, Debug)]
struct HeapNode {
    area: f64,
    index: usize,
}

impl PartialEq for HeapNode {
    fn eq(&self, other: &Self) -> bool {
        self.area == other.area
    }
}
impl Eq for HeapNode {}

impl Ord for HeapNode {
    fn cmp(&self, other: &Self) -> Ordering {
        other.area.partial_cmp(&self.area).unwrap_or(Ordering::Equal)
    }
}

impl PartialOrd for HeapNode {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
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

#[inline(always)]
fn unpack(m: u64) -> (f64, f64) {
    // 🌟 修正：JavaScript (V8) 側のメモリ配置に100%適応させるため、
    // 明確にリトルエンディアンのバイト配列として分解・再解釈します
    let bytes = m.to_le_bytes();
    let morton = u64::from_le_bytes(bytes);

    let is_l1 = (morton & TERMINAL_BIT) != 0;
    let pure_morton = if is_l1 { morton & !TERMINAL_BIT } else { morton & !WEIGHT_MASK };
    
    // 低位・高位の切り出しを安全に実行
    let low32 = (pure_morton & 0xFFFFFFFF) as u32;
    let high32 = ((pure_morton >> 32) & 0x7FFFFFFF) as u32;
    
    let ix = (compact16(high32) << 16) | compact16(low32);
    let iy = (compact16(high32 >> 1) << 16) | compact16(low32 >> 1);
    
    let lng = (ix as f64 * INV_SCALE_E) - 180.0;
    let lat = (iy as f64 * INV_SCALE_E) - 90.0;
    (lng, lat)
}
#[inline(always)]
fn spread16(mut x: u32) -> u64 {
    x = (x | (x << 8)) & 0x00FF00FF;
    x = (x | (x << 4)) & 0x0F0F0F0F;
    x = (x | (x << 2)) & 0x33333333;
    x = (x | (x << 1)) & 0x55555555;
    x as u64
}

#[inline(always)]
fn pack_from_int(ix: u32, iy: u32) -> u64 {
    // 🌟 修正：JS版と同様に、融合する「前」にすべてのビットを正しくスプレッドする
    let xl = spread16(ix & 0xFFFF);
    let xh = spread16((ix >> 16) & 0xFFFF);
    let yl = spread16(iy & 0xFFFF);
    let yh = spread16((iy >> 16) & 0xFFFF);
    
    // 🌟 修正：スプレッド済みの u64 同士を安全に融合させる
    let pure_morton = ((xh | (yh << 1)) << 32) | (xl | (yl << 1));
    pure_morton | TERMINAL_BIT
}

#[inline(always)]
fn convert_to_l2_bits(m: u64, weight: u32) -> u64 {
    let is_l1 = (m & TERMINAL_BIT) != 0;
    let morton = if is_l1 { m & !TERMINAL_BIT } else { m & !WEIGHT_MASK };
    
    let low32 = (morton & 0xFFFFFFFF) as u32;
    let high32 = ((morton >> 32) & 0x7FFFFFFF) as u32;
    
    let ix = (compact16(high32) << 16) | compact16(low32);
    let iy = (compact16(high32 >> 1) << 16) | compact16(low32 >> 1);
    
    // 座標を8の倍数に丸める（u32のまま）
    let rx = ((ix as f64 / 8.0).round() as u32) * 8;
    let ry = ((iy as f64 / 8.0).round() as u32) * 8;
    
    // 🌟 致命的バグの修正：丸めた座標をスプレッドしてから融合する
    let xl = spread16(rx & 0xFFFF);
    let xh = spread16((rx >> 16) & 0xFFFF);
    let yl = spread16(ry & 0xFFFF);
    let yh = spread16((ry >> 16) & 0xFFFF);
    
    let pure_morton = ((xh | (yh << 1)) << 32) | (xl | (yl << 1));
    (pure_morton & !WEIGHT_MASK) | ((weight & 0x3F) as u64)
}

#[inline(always)]
fn calculate_area(p_idx: usize, c_idx: usize, n_idx: usize, xs: &[f64], ys: &[f64], cos_lat: f64) -> f64 {
    let x_p = xs[p_idx]; let y_p = ys[p_idx];
    let x_c = xs[c_idx]; let y_c = ys[c_idx];
    let x_n = xs[n_idx]; let y_n = ys[n_idx];
    
    ((x_c - x_p) * cos_lat * (y_n - y_p) - (x_n - x_p) * cos_lat * (y_c - y_p)).abs() * 0.5
}

fn l2_to_l2(arc: &mut [u64]) {
    let n = arc.len();
    if n < 3 { return; }
    
    let mut xs = Vec::with_capacity(n);
    let mut ys = Vec::with_capacity(n);
    let mut prev = Vec::with_capacity(n);
    let mut next = Vec::with_capacity(n);
    let mut areas = Vec::with_capacity(n);
    let mut eff = Vec::with_capacity(n);
    let mut heap = BinaryHeap::with_capacity(n);
    
    // 🌟 修正①：頂点が「まだ間引かれていないか」を厳密に管理するフラグ
    let mut valid = vec![true; n];

    xs.resize(n, 0.0f64);
    ys.resize(n, 0.0f64);
    prev.resize(n, 0usize);
    next.resize(n, 0usize);
    areas.resize(n, 0.0f64);
    eff.resize(n, 0.0f64);

    let mut min_lat = std::f64::INFINITY;
    let mut max_lat = std::f64::NEG_INFINITY;

    for i in 0..n {
        let (lng, lat) = unpack(arc[i]);
        xs[i] = lng;
        ys[i] = lat;
        prev[i] = if i == 0 { 0 } else { i - 1 };
        next[i] = if i == n - 1 { n - 1 } else { i + 1 };
        
        if lat < min_lat { min_lat = lat; }
        if lat > max_lat { max_lat = lat; }
    }

    let cos_lat = (((min_lat + max_lat) / 2.0) * RAD).cos();

    let get_area_pure = |i: usize, p_idx: usize, n_idx: usize, xs: &[f64], ys: &[f64]| -> f64 {
        let x_i = xs[i];     let y_i = ys[i];
        let x_p = xs[p_idx]; let y_p = ys[p_idx];
        let x_n = xs[n_idx]; let y_n = ys[n_idx];
        ((x_i - x_p) * cos_lat * (y_n - y_p) - (x_n - x_p) * cos_lat * (y_i - y_p)).abs() * 0.5
    };

    for i in 1..(n - 1) {
        areas[i] = get_area_pure(i, prev[i], next[i], &xs, &ys);
        heap.push(HeapNode { area: areas[i], index: i });
    }

    let mut max_area = 0.0f64;

    while let Some(HeapNode { area, index }) = heap.pop() {
        // 🌟 修正②：すでに間引かれた頂点なら即スキップ
        if !valid[index] { continue; }

        // 🌟 修正③：最大の原因だった「古いデータの亡霊」を完全にシャットアウト
        // ヒープから出てきた面積が、最新の面積（areas[index]）と一致しない場合は、
        // 古い不要なデータなので問答無用で無視します。
        if (area - areas[index]).abs() > 1e-9 { continue; }

        if area > max_area { max_area = area; }
        eff[index] = max_area;
        
        // この頂点を間引いたことを確定する
        valid[index] = false;

        let p = prev[index];
        let nxt = next[index];

        // 前後の鎖を繋ぎ直す
        next[p] = nxt;
        prev[nxt] = p;

        // 🌟 修正④：無駄なヒープ追加を防ぎ、無限ループを完全に断ち切る
        if p > 0 && valid[p] {
            let current_area = get_area_pure(p, prev[p], next[p], &xs, &ys);
            let new_area = if current_area < max_area { max_area } else { current_area };
            
            // 面積が「変わった時だけ」ヒープに追加する
            if (new_area - areas[p]).abs() > 1e-9 {
                areas[p] = new_area;
                heap.push(HeapNode { area: new_area, index: p });
            }
        }
        
        if nxt < n - 1 && valid[nxt] {
            let current_area = get_area_pure(nxt, prev[nxt], next[nxt], &xs, &ys);
            let new_area = if current_area < max_area { max_area } else { current_area };
            
            // 面積が「変わった時だけ」ヒープに追加する
            if (new_area - areas[nxt]).abs() > 1e-9 {
                areas[nxt] = new_area;
                heap.push(HeapNode { area: new_area, index: nxt });
            }
        }
    }

    let get_phys_rank_fast = |area: f64| -> u32 {
        if area <= 1e-12 { return 0; }
        let bits = area.to_bits();
        let exponent = ((bits >> 52) & 0x7FF) as i32 - 1023;
        let fraction = (bits & 0xF_FFFF_FFFF_FFFF) as f64 / 4503599627370496.0;
        let log2_approx = exponent as f64 + fraction;
        
        let rank = (1.5 * log2_approx - 8.2365).floor() as i32;
        rank.clamp(0, 63) as u32
    };

    for i in 1..(n - 1) {
        let rank = get_phys_rank_fast(eff[i]);
        arc[i] = convert_to_l2_bits(arc[i], rank);
    }
}

#[allow(non_snake_case)]
#[wasm_bindgen]
pub unsafe extern "C" fn L1toL2_wasm(ptr: *mut u64, length: usize) {
    if length < 3 { return; }
    let arc_slice = std::slice::from_raw_parts_mut(ptr, length);
    l2_to_l2(arc_slice);
}

#[allow(non_snake_case)]
#[wasm_bindgen]
pub unsafe extern "C" fn XYtoL1_wasm(ptr: *mut i32, length: usize) {
    if length == 0 { return; }

    let xy_slice = std::slice::from_raw_parts(ptr, length * 2);
    let l1_slice = std::slice::from_raw_parts_mut(ptr as *mut u64, length);

    for i in 0..length {
        let ix = xy_slice[i * 2] as u32;
        let iy = xy_slice[i * 2 + 1] as u32;
        l1_slice[i] = pack_from_int(ix, iy);
    }
}

#[wasm_bindgen]
pub fn init_panic_hook() {}

#[wasm_bindgen]
pub fn alloc_wasm_memory(size: usize) -> *mut u8 {
    // 内部に空のベクタ（配列）を作り、指定サイズ分のメモリを確保してポインタを返す
    let mut buf = vec![0u8; size];
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf); // ⚠️ 重要: Rustの自動メモリ解放（ガベージコレクション）を一時的に引き止める
    ptr
}

/// 🌟 JS側から「さっき確保したメモリ空間を使い切ったから解放して」と頼まれる窓口
#[wasm_bindgen]
pub fn free_wasm_memory(ptr: *mut u8, size: usize) {
    unsafe {
        // ポインタからベクタを復元し、関数の終了とともに安全にメモリを消去する
        let _buf = Vec::from_raw_parts(ptr, size, size);
    }
}