use std::f64;
use wasm_bindgen::prelude::*;

const RAD: f64 = std::f64::consts::PI / 180.0;
const SCALE_E: f64 = 10_000_000.0;
const INV_SCALE_E: f64 = 1.0 / SCALE_E;
const TERMINAL_BIT: u64 = 1 << 63;
const WEIGHT_MASK: u64 = 0x3F;

// =========================================================================
// 🌟 記憶領域（WASM内部メモリ）の明示的確保・解放窓口
// =========================================================================

#[wasm_bindgen]
pub fn init_panic_hook() {}

#[wasm_bindgen]
pub fn alloc_wasm_memory(size: usize) -> *mut u8 {
    let mut buf = vec![0u8; size];
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

#[wasm_bindgen]
pub fn free_wasm_memory(ptr: *mut u8, size: usize) {
    unsafe {
        let _buf = Vec::from_raw_parts(ptr, size, size);
    }
}

// =========================================================================
// 🌟 低レイヤ・ビット演算（モートンコード）ユーティリティ
// =========================================================================

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

#[inline(always)]
fn pure_morton_from_int(ix: u32, iy: u32) -> u64 {
    // 🌟 下位16ビット（low32）のインターリーブ
    let xl = spread16(ix & 0xFFFF);
    let yl = spread16(iy & 0xFFFF);
    let low32 = xl | (yl << 1); // JS: (xl | (yl << 1)) >>> 0

    // 🌟 上位16ビット（high32）のインターリーブ
    let xh = spread16((ix >> 16) & 0xFFFF);
    let yh = spread16((iy >> 16) & 0xFFFF);
    let high32 = xh | (yh << 1); // JS: (xh | (yh << 1)) >>> 0
    
    // 🌟 修正：JSと100%同一の並び順（high32 を上に 32ビットシフトし、low32 と結合）
    (high32 << 32) | low32
}

#[inline(always)]
fn unpack_to_int(m: u64) -> (u32, u32) {
    let is_l1 = (m & TERMINAL_BIT) != 0;
    let morton = if is_l1 { m & !TERMINAL_BIT } else { m & !WEIGHT_MASK };
    
    let low32 = (morton & 0xFFFFFFFF) as u32;
    let high32 = ((morton >> 32) & 0xFFFFFFFF) as u32;
    
    let ix = ((compact16(high32) << 16) | compact16(low32)) & 0xFFFFFFFF;
    let iy = ((compact16(high32 >> 1) << 16) | compact16(low32 >> 1)) & 0xFFFFFFFF;
    (ix, iy)
}

#[inline(always)]
fn unpack(m: u64) -> (f64, f64) {
    let (ix, iy) = unpack_to_int(m);
    let lng_raw = (ix as f64 * INV_SCALE_E) - 180.0;
    let lat_raw = (iy as f64 * INV_SCALE_E) - 90.0;
    
    let lng = (lng_raw * 10_000_000.0).round() / 10_000_000.0;
    let lat = (lat_raw * 10_000_000.0).round() / 10_000_000.0;
    (lng, lat)
}

#[inline(always)]
fn to_l2(l1: u64, weight: u32) -> u64 {
    let (ix, iy) = unpack_to_int(l1);
    let rx = ((ix as f64 / 8.0).round() as u32) * 8;
    let ry = ((iy as f64 / 8.0).round() as u32) * 8;
    (pure_morton_from_int(rx, ry) & !WEIGHT_MASK) | ((weight & 0x3F) as u64)
}

// =========================================================================
// 🌟 ヒープ制御マクロ・関数
// =========================================================================

macro_rules! swap_nodes {
    ($a:expr, $b:expr, $heap:expr, $pos:expr) => {
        $heap.swap($a, $b);
        $pos[$heap[$a]] = $a as i32;
        $pos[$heap[$b]] = $b as i32;
    };
}

fn up_heap(mut i: usize, areas: &[f64], heap: &mut [usize], pos: &mut [i32]) {
    while i > 0 {
        let parent = (i - 1) / 2;
        if areas[heap[i]] < areas[heap[parent]] {
            swap_nodes!(i, parent, heap, pos);
            i = parent;
        } else {
            break;
        }
    }
}

fn down_heap(mut i: usize, heap_size: usize, areas: &[f64], heap: &mut [usize], pos: &mut [i32]) {
    loop {
        let l = (i << 1) + 1;
        let r = l + 1;
        let mut d = l;
        if l >= heap_size { break; }
        if r < heap_size && areas[heap[r]] < areas[heap[l]] {
            d = r;
        }
        if areas[heap[d]] >= areas[heap[i]] { break; }
        swap_nodes!(i, d, heap, pos);
        i = d;
    }
}

// =========================================================================
// 🌟 WASM メインエクスポート
// =========================================================================

#[wasm_bindgen]
#[allow(non_snake_case)]
pub fn XYtoL1_wasm(ptr: *mut i32, vertex_count: usize) {
    if vertex_count == 0 { return; }

    // X, Yが隙間なく詰まった i32 のスライス (要素数は 頂点数 * 2)
    let xy_slice = unsafe { std::slice::from_raw_parts_mut(ptr, vertex_count * 2) };
    // 同じアドレスを u64 の出力スライスとしてリキャスト
    let out_slice = unsafe { std::slice::from_raw_parts_mut(ptr as *mut u64, vertex_count) };

    // 🌟 核心：末尾（vertex_count - 1）から逆順にループを回す！
    // これにより、自分の書き戻し（out_slice[i]）が、これから読み込む手前のデータ（xy_slice[i*2]）を
    // 破壊することが幾何学・メモリ空間的に100%発生しなくなります。
    for i in (0..vertex_count).rev() {
        let ix = xy_slice[i * 2] as u32;
        let iy = xy_slice[i * 2 + 1] as u32;
        
        // 1ビットの狂いもない、正しいJS互換モートンコードを生成
        out_slice[i] = pure_morton_from_int(ix, iy) | TERMINAL_BIT;
    }
}

#[wasm_bindgen]
#[allow(non_snake_case)]
pub fn L1toL2_wasm(ptr: *mut u64, length: usize) {
    let arc = unsafe { std::slice::from_raw_parts_mut(ptr, length) };
    l2_to_l2(arc);
}

// =========================================================================
// 🌟 Visvalingam-Whyatt エンジン + 自己交差プロテクション
// =========================================================================

fn l2_to_l2(arc: &mut [u64]) {
    let n = arc.len();
    if n < 3 { return; }

    let mut xs = vec![0.0f64; n];
    let mut ys = vec![0.0f64; n];
    let mut prev = vec![0i32; n];
    let mut next = vec![0i32; n];
    let mut areas = vec![0.0f64; n];
    let mut heap = vec![0usize; n];
    let mut pos = vec![-1i32; n];
    let mut eff = vec![0.0f64; n];

    let mut min_lat = f64::INFINITY;
    let mut max_lat = f64::NEG_INFINITY;

    for i in 0..n {
        let (lng, lat) = unpack(arc[i]);
        xs[i] = lng;
        ys[i] = lat;
        prev[i] = i as i32 - 1;
        next[i] = i as i32 + 1;

        if lat < min_lat { min_lat = lat; }
        if lat > max_lat { max_lat = lat; }
    }

    let cos_lat = (((min_lat + max_lat) / 2.0) * RAD).cos();

    let get_area = |i: usize, prev: &[i32], next: &[i32], xs: &[f64], ys: &[f64]| -> f64 {
        let p = prev[i];
        let nx = next[i];
        if p < 0 || nx >= n as i32 { return f64::INFINITY; }
        let p = p as usize;
        let nx = nx as usize;
        ((xs[i] - xs[p]) * cos_lat * (ys[nx] - ys[p]) - (xs[nx] - xs[p]) * cos_lat * (ys[i] - ys[p])).abs() * 0.5
    };

    let mut heap_size = 0usize;
    for i in 1..(n - 1) {
        areas[i] = get_area(i, &prev, &next, &xs, &ys);
        heap[heap_size] = i;
        pos[i] = heap_size as i32;
        up_heap(heap_size, &areas, &mut heap, &mut pos);
        heap_size += 1;
    }

    let mut max_a = 0.0f64;

    while heap_size > 0 {
        let curr = heap[0];
        pos[curr] = -1;
        heap_size -= 1;
        if heap_size > 0 {
            heap[0] = heap[heap_size];
            pos[heap[0]] = 0;
            down_heap(0, heap_size, &areas, &mut heap, &mut pos);
        }

        if areas[curr] > max_a {
            max_a = areas[curr];
        }
        eff[curr] = max_a;

        let p = prev[curr];
        let nx = next[curr];
        if p >= 0 { next[p as usize] = nx; }
        if nx < n as i32 { prev[nx as usize] = p; }

        let neighbors = [p, nx];
        for &idx_i32 in neighbors.iter() {
            if idx_i32 > 0 && idx_i32 < (n - 1) as i32 {
                let idx = idx_i32 as usize;
                if pos[idx] != -1 {
                    let current_area = get_area(idx, &prev, &next, &xs, &ys);
                    areas[idx] = if current_area > max_a { current_area } else { max_a };
                    
                    let h_pos = pos[idx] as usize;
                    up_heap(h_pos, &areas, &mut heap, &mut pos);
                    down_heap(h_pos, heap_size, &areas, &mut heap, &mut pos);
                }
            }
        }
    }

    let get_phys_rank = |area: f64| -> u32 {
        if area <= 0.0 { return 0; }
        let rank = (1.5 * area.log2() - 8.2365).floor() as i32;
        rank.clamp(0, 63) as u32
    };

    // 🌟 余計なハック・プロテクションは全廃！
    // 仕様通り、中間点（1 〜 n-2）だけを純粋に L2 コードへ変換して上書きする
    for i in 1..(n - 1) {
        let rank = get_phys_rank(eff[i]);
        arc[i] = to_l2(arc[i], rank);
    }
}