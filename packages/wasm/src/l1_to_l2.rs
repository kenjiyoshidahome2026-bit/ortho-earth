// packages/wasm/src/l1_to_l2.rs

use std::collections::BinaryHeap;
use std::cmp::Ordering;

/// バイナリヒープ（優先度付きキュー）で頂点の「有効面積（ウェイト）」を管理するための構造体
/// Rustの標準BinaryHeapは「最大ヒープ」のため、面積が「最小」のものを優先して取り出すために逆順で比較を定義します。
#[derive(Copy, Clone, Debug)]
struct HeapNode {
    area: f64,
    index: usize,
}

impl PartialEq for HeapNode {
    fn eq(&self, other: &Self) -> bool { // 🌟 小文字の &self から 大文字の &Self へ修正
        self.area == other.area
    }
}

impl Eq for HeapNode {}

impl Ord for HeapNode {
    fn cmp(&self, other: &Self) -> Ordering {
        // f64の大小比較（NaNは考慮しない前提。実データでは面積として正常値が入るため）
        other.area.partial_cmp(&self.area).unwrap_or(Ordering::Equal)
    }
}

impl PartialOrd for HeapNode {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// 🌟 外側（lib.rs）から一括で呼び出されるメインのエントリーポイント
pub fn execute(buffer_ptr: *mut u64, meta_ptr: *const u32, arc_count: usize, mlen: usize) {
    let metas = unsafe { std::slice::from_raw_parts(meta_ptr, arc_count * mlen) };

    for i in 0..arc_count {
        let offset = metas[i * mlen] as usize;
        let length = metas[i * mlen + 1] as usize;

        // 頂点数が3未満のアークは簡素化の計算ができないためスキップ
        if length < 3 { continue; }

        // メモリポインタから、このアークに相当する領域を安全にミュータブル（書き換え可能）スライスとして切り出し
        let arc_slice = unsafe { std::slice::from_raw_parts_mut(buffer_ptr.add(offset), length) };
        process_single_arc(arc_slice);
    }
}

/// ⚡️ 単一のアーク（線分・境界）に対して Visvalingam-Whyatt アルゴリズムを実行し、
/// ⚡️ gintbuf（u64）の上位ビット（L2ウェイト等）をインプレースで直接書き換えるコアロジック
fn process_single_arc(arc: &mut [u64]) {
    let n = arc.len();
    
    // JS側の隣接インデックス（prev/next）のシミュレート用
    let mut prev = vec![0usize; n];
    let mut next = vec![0usize; n];
    let mut areas = vec![0.0f64; n];
    let mut heap = BinaryHeap::with_capacity(n);

    // 1. 各頂点からX, Yの地理座標（あるいは解凍後の整数座標）をデコードして、初期有効面積を計算
    for i in 0..n {
        prev[i] = if i == 0 { 0 } else { i - 1 };
        next[i] = if i == n - 1 { n - 1 } else { i + 1 };
    }

    for i in 1..(n - 1) {
        areas[i] = calculate_area(arc[prev[i]], arc[i], arc[next[i]]);
        heap.push(HeapNode { area: areas[i], index: i });
    }

    let mut max_area = 0.0f64;

    // 2. 面積が最小の頂点から順に間引き（リンクの繋ぎ替え）、ウェイトを確定させていくループ
    while let Some(HeapNode { area, index }) = heap.pop() {
        // すでにヒープ内で古くなった（隣接頂点が消えたことで面積が更新された）ノードは無視
        if area < areas[index] { continue; }

        // 面積（ウェイト）は、これまでの最大面積を下回らないように蓄積（単調増加の保証）
        if area > max_area {
            max_area = area;
        }

        let p = prev[index];
        let nxt = next[index];

        // 🌟 核心：不要なカッコを削除し、警告が出ない綺麗な代入文へ修正
        let weight_bits = max_area.to_bits() & 0xFFFF_0000_0000_0000u64;
        arc[index] = (arc[index] & 0x0000_FFFF_FFFF_FFFFu64) | weight_bits;

        // 隣接関係を繋ぎ替えて、インデックスからこの頂点を除外
        next[p] = nxt;
        prev[nxt] = p;

        // 隣接頂点の面積（影響度）が変わったため、再計算してヒープへ再投入
        if p > 0 {
            areas[p] = calculate_area(arc[prev[p]], arc[p], arc[next[p]]);
            heap.push(HeapNode { area: areas[p], index: p });
        }
        if nxt < n - 1 {
            areas[nxt] = calculate_area(arc[prev[nxt]], arc[nxt], arc[next[nxt]]);
            heap.push(HeapNode { area: areas[nxt], index: nxt });
        }
    }

    // 始点と終点は絶対に間引かれないため、無限大（または最大値のビットマスク）を付与
    if n > 0 {
        arc[0] = arc[0] | 0xFFFF_0000_0000_0000u64;
        arc[n - 1] = arc[n - 1] | 0xFFFF_0000_0000_0000u64;
    }
}

/// 📐 3つのgintのビット（u64）からX,Y座標をデコードし、三角形の面積（外積）を算出するヘルパー
#[inline(always)]
fn calculate_area(p1: u64, p2: u64, p3: u64) -> f64 {
    let x1 = (p1 & 0x0000_0000_FFFF_FFFFu64) as f64;
    let y1 = ((p1 >> 32) & 0x0000_0000_FFFF_FFFFu64) as f64;

    let x2 = (p2 & 0x0000_0000_FFFF_FFFFu64) as f64;
    let y2 = ((p2 >> 32) & 0x0000_0000_FFFF_FFFFu64) as f64;

    let x3 = (p3 & 0x0000_0000_FFFF_FFFFu64) as f64;
    let y3 = ((p3 >> 32) & 0x0000_0000_FFFF_FFFFu64) as f64;

    // 外積を用いた三角形の面積計算
    ((x1 - x3) * (y2 - y1) - (x1 - x2) * (y3 - y1)).abs() * 0.5
}