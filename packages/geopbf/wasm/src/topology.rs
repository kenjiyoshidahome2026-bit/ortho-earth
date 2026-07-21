// topology.js のポリゴン経路（cutPolygon→metaArc→metaPolygon→buildArcs→stream組立）の Rust 一括版。
// JS 側は parse+densify 済みの XY 連結バッファを 1 回だけ渡し、GintBUF の部品
// （arc_buffer / arc_meta / poly_stream / neighbor_stream）を 1 回で受け取る＝
// 「境界を跨ぐのはコピーでなく参照」の原則。V8 の Map 16M 上限が無いので
// JS 版のチャンク分割（チャンク跨ぎ共有辺の取りこぼし）もここでは存在しない。
//
// 移植の掟：アルゴリズム・数値経路（f64 の演算順・ToUint32 截断・bbox の else-if）は
// topology.js と同一に保つ。唯一の意図的相違＝同 weight 要素のソート順
// （V8 の「比較器が 0 を返さない sort」は同値を反転させる／Rust は stable で原順維持。
//   weight 同値の並びは意味を持たないため許容）。
use wasm_bindgen::prelude::*;
use rustc_hash::{FxHashMap, FxHashSet};
use super::{pure_morton_from_int, TERMINAL_BIT};
use crate::l2_to_l2;

const RAD: f64 = std::f64::consts::PI / 180.0;
const RADIUS: f64 = 6371008.8;
const INV_SCALE_E: f64 = 1.0 / 10_000_000.0;

#[inline(always)]
fn vkey(x: u32, y: u32) -> u64 {
    ((x as u64) << 32) | (y as u64)
}

// ── 出力コンテナ：JS は ptr/len 越しに wasm メモリを直接読む（slice→GintBUF へ 1 copy）──
#[wasm_bindgen]
pub struct PolyTopology {
    arc_buffer: Vec<u64>,
    arc_meta: Vec<u32>,
    poly_stream: Vec<i32>,
    neighbor_stream: Vec<i32>,
    count: u32,
}

#[wasm_bindgen]
impl PolyTopology {
    pub fn count(&self) -> u32 { self.count }
    pub fn arc_buffer_ptr(&self) -> u32 { self.arc_buffer.as_ptr() as u32 }
    pub fn arc_buffer_len(&self) -> u32 { self.arc_buffer.len() as u32 }
    pub fn arc_meta_ptr(&self) -> u32 { self.arc_meta.as_ptr() as u32 }
    pub fn arc_meta_len(&self) -> u32 { self.arc_meta.len() as u32 }
    pub fn poly_stream_ptr(&self) -> u32 { self.poly_stream.as_ptr() as u32 }
    pub fn poly_stream_len(&self) -> u32 { self.poly_stream.len() as u32 }
    pub fn neighbor_stream_ptr(&self) -> u32 { self.neighbor_stream.as_ptr() as u32 }
    pub fn neighbor_stream_len(&self) -> u32 { self.neighbor_stream.len() as u32 }
}

// リング実長：末尾の閉合重複（複数個あり得る）を除いた頂点数（JS visit/splitRing と同じ）
#[inline]
fn trimmed_len(ring: &[u32]) -> usize {
    let mut n = ring.len() >> 1;
    while n > 2 && ring[0] == ring[(n - 1) * 2] && ring[1] == ring[(n - 1) * 2 + 1] { n -= 1; }
    n
}

// ── 接合点判定（computeJunctions 相当・チャンク無し全量）──
// 各頂点の「非順序の隣接ペア」を初出時に記録し、異なるペアで再訪された頂点＝接合点。
fn compute_junctions(xy: &[u32], ring_ranges: &[(usize, usize)]) -> FxHashSet<u64> {
    let mut pair: FxHashMap<u64, (u64, u64)> = FxHashMap::default();
    let mut marks: FxHashSet<u64> = FxHashSet::default();
    for &(off, len) in ring_ranges {
        let ring = &xy[off * 2..(off + len) * 2];
        let n = trimmed_len(ring);
        if n < 3 { continue; }
        let key_at = |i: usize| vkey(ring[i * 2], ring[i * 2 + 1]);
        let mut k_prev = key_at(n - 1);
        let mut k_cur = key_at(0);
        for i in 0..n {
            let k_next = key_at((i + 1) % n);
            let (lo, hi) = if k_prev < k_next { (k_prev, k_next) } else { (k_next, k_prev) };
            match pair.get(&k_cur) {
                None => { pair.insert(k_cur, (lo, hi)); }
                Some(&p) => { if p != (lo, hi) { marks.insert(k_cur); } }
            }
            k_prev = k_cur;
            k_cur = k_next;
        }
    }
    marks
}

// ── arc 登録（registerArc 相当）：端点キー＋頂点数で候補を引き、内容照合（前方/逆方向）で確定 ──
struct ArcRegistry {
    arcs: Vec<Vec<u32>>,
    index: FxHashMap<(u64, u64, u32), Vec<u32>>,
}

impl ArcRegistry {
    fn new() -> Self { ArcRegistry { arcs: Vec::new(), index: FxHashMap::default() } }

    fn register(&mut self, seg: &[u32]) -> i32 {
        let n2 = seg.len();
        let k1 = vkey(seg[0], seg[1]);
        let k2 = vkey(seg[n2 - 2], seg[n2 - 1]);
        let key = if k1 <= k2 { (k1, k2, n2 as u32) } else { (k2, k1, n2 as u32) };
        let list = self.index.entry(key).or_default();
        for &idx in list.iter() {
            let b = &self.arcs[idx as usize];
            let mut fwd = true;
            let mut rev = true;
            let mut t = 0;
            while t < n2 {
                if fwd && (b[t] != seg[t] || b[t + 1] != seg[t + 1]) { fwd = false; }
                if rev && (b[n2 - 2 - t] != seg[t] || b[n2 - 1 - t] != seg[t + 1]) { rev = false; }
                if !fwd && !rev { break; }
                t += 2;
            }
            if fwd { return idx as i32; }
            if rev { return !(idx as i32); }
        }
        let new_idx = self.arcs.len() as u32;
        list.push(new_idx);
        self.arcs.push(seg.to_vec());
        new_idx as i32
    }
}

// ── リング分割（splitRing/splitArc/cutRing 相当）──
fn split_ring(ring: &[u32], junctions: &FxHashSet<u64>, reg: &mut ArcRegistry) -> Vec<i32> {
    let n = trimmed_len(ring);
    if n < 3 { return Vec::new(); }
    let is_term = |i: usize| junctions.contains(&vkey(ring[i * 2], ring[i * 2 + 1]));

    let mut start = 0usize;
    let mut looped = 0i32;
    for k in 0..n { if is_term(k) { start = k; break; } }
    if !is_term(start) {
        // 孤立リング：正準開始点（y,x 辞書順最大）と向き（度単位 f64 の shoelace）を決める
        let mut sum = 0.0f64;
        let mut max_y = f64::NEG_INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        let mut lng0 = ring[0] as f64 * INV_SCALE_E - 180.0;
        let mut lat0 = ring[1] as f64 * INV_SCALE_E - 90.0;
        for i in 0..n {
            let j2 = ((i + 1) % n) * 2;
            let lng1 = ring[j2] as f64 * INV_SCALE_E - 180.0;
            let lat1 = ring[j2 + 1] as f64 * INV_SCALE_E - 90.0;
            sum += (lng1 - lng0) * (lat1 + lat0);
            let xx = ring[i * 2] as f64;
            let yy = ring[i * 2 + 1] as f64;
            if yy > max_y || (yy == max_y && xx > max_x) { max_y = yy; max_x = xx; start = i; }
            lng0 = lng1;
            lat0 = lat1;
        }
        looped = if sum > 0.0 { 1 } else { -1 }; // 1: clockwise, -1: counter-clockwise
    }

    // 回転：start を先頭にし、start 点で閉じる（n+1 頂点）
    let mut rotated: Vec<u32> = Vec::with_capacity((n + 1) * 2);
    rotated.extend_from_slice(&ring[start * 2..n * 2]);
    rotated.extend_from_slice(&ring[0..start * 2]);
    rotated.push(ring[start * 2]);
    rotated.push(ring[start * 2 + 1]);

    // splitArc
    let rn = rotated.len() >> 1;
    if looped != 0 {
        let r = reg.register(&rotated);
        return vec![if looped > 0 { r } else { !r }]; // 出力は時計回り正準
    }
    let is_term_rot = |i: usize| junctions.contains(&vkey(rotated[i * 2], rotated[i * 2 + 1]));
    let mut indices = Vec::new();
    let mut i = 0usize;
    while i < rn - 1 {
        let mut j = i + 1;
        while j < rn - 1 && !is_term_rot(j) { j += 1; }
        indices.push(reg.register(&rotated[i * 2..(j + 1) * 2]));
        i = j;
    }
    indices
}

// ── arc メタ（metaArc calcMetaXY 相当）──
struct ArcMeta {
    aid: usize,
    length: f64,
    area: f64,
    closed: bool,
    bbox: [u32; 4],
    weight: f64,
    owner_count: u32,
}

fn calc_meta_xy(buff: &[u32], aid: usize) -> ArcMeta {
    let n = buff.len() >> 1;
    let closed = buff[0] == buff[(n - 1) * 2] && buff[1] == buff[(n - 1) * 2 + 1];
    let mut l = 0.0f64;
    let mut a = 0.0f64;
    let x0 = buff[0];
    let y0 = buff[1];
    let mut lng0 = x0 as f64 * INV_SCALE_E - 180.0;
    let mut lat0 = y0 as f64 * INV_SCALE_E - 90.0;
    let mut bbox = [x0, y0, x0, y0];
    for i in 1..n {
        let x1 = buff[i * 2];
        let y1 = buff[i * 2 + 1];
        let lng1 = x1 as f64 * INV_SCALE_E - 180.0;
        let lat1 = y1 as f64 * INV_SCALE_E - 90.0;
        let cos_lat = (((lat0 + lat1) / 2.0) * RAD).cos();
        let dx = (lng1 - lng0) * RAD * cos_lat;
        let dy = (lat1 - lat0) * RAD;
        l += (dx * dx + dy * dy).sqrt();
        a += (lng1 - lng0) * RAD * (2.0 + (lat0 * RAD).sin() + (lat1 * RAD).sin());
        if x1 < bbox[0] { bbox[0] = x1; } else if x1 > bbox[2] { bbox[2] = x1; }
        if y1 < bbox[1] { bbox[1] = y1; } else if y1 > bbox[3] { bbox[3] = y1; }
        lng0 = lng1;
        lat0 = lat1;
    }
    ArcMeta {
        aid,
        length: l * RADIUS,
        area: a * RADIUS * RADIUS / 2.0,
        closed,
        bbox,
        weight: 0.0,
        owner_count: 0,
    }
}

struct Comp {
    fid: i32,
    arcs: Vec<Vec<i32>>,
    weight: f64,
}

// ── ライン経路（buildPolylines 相当）────────────────────────────────────────
// 入力は L1 Morton(u64) 連結バッファ（purifier は JS 側で適用済み＝80kセグ以下の小データ専用）。
// cutPolyline の掟：arc 照合は「端点キー＋頂点数」のみ（ポリゴンと違い内容照合なし＝JS と同じ）。

#[wasm_bindgen]
pub struct LineTopology {
    arc_buffer: Vec<u64>,
    arc_meta: Vec<u32>,
    line_stream: Vec<i32>,
    count: u32,
}

#[wasm_bindgen]
impl LineTopology {
    pub fn count(&self) -> u32 { self.count }
    pub fn arc_buffer_ptr(&self) -> u32 { self.arc_buffer.as_ptr() as u32 }
    pub fn arc_buffer_len(&self) -> u32 { self.arc_buffer.len() as u32 }
    pub fn arc_meta_ptr(&self) -> u32 { self.arc_meta.as_ptr() as u32 }
    pub fn arc_meta_len(&self) -> u32 { self.arc_meta.len() as u32 }
    pub fn line_stream_ptr(&self) -> u32 { self.line_stream.as_ptr() as u32 }
    pub fn line_stream_len(&self) -> u32 { self.line_stream.len() as u32 }
}

// metaArc calcMeta の u64(L1 Morton) 経路：unpack しつつ長さ/面積/bbox（JS と同一の f64 経路）
fn calc_meta_u64(buff: &[u64], aid: usize) -> ArcMeta {
    let n = buff.len();
    let closed = buff[0] == buff[n - 1];
    let mut l = 0.0f64;
    let mut a = 0.0f64;
    let (x0, y0) = crate::unpack_to_int(buff[0]);
    let mut lng0 = x0 as f64 * INV_SCALE_E - 180.0;
    let mut lat0 = y0 as f64 * INV_SCALE_E - 90.0;
    let mut bbox = [x0, y0, x0, y0];
    for i in 1..n {
        let (x1, y1) = crate::unpack_to_int(buff[i]);
        let lng1 = x1 as f64 * INV_SCALE_E - 180.0;
        let lat1 = y1 as f64 * INV_SCALE_E - 90.0;
        let cos_lat = (((lat0 + lat1) / 2.0) * RAD).cos();
        let dx = (lng1 - lng0) * RAD * cos_lat;
        let dy = (lat1 - lat0) * RAD;
        l += (dx * dx + dy * dy).sqrt();
        a += (lng1 - lng0) * RAD * (2.0 + (lat0 * RAD).sin() + (lat1 * RAD).sin());
        if x1 < bbox[0] { bbox[0] = x1; } else if x1 > bbox[2] { bbox[2] = x1; }
        if y1 < bbox[1] { bbox[1] = y1; } else if y1 > bbox[3] { bbox[3] = y1; }
        lng0 = lng1;
        lat0 = lat1;
    }
    ArcMeta {
        aid,
        length: l * RADIUS,
        area: a * RADIUS * RADIUS / 2.0,
        closed,
        bbox,
        weight: 0.0,
        owner_count: 0,
    }
}

// coords : 全ライン連結の L1 Morton(u64・TERMINAL_BIT 付き・purifier 適用済み)
// lines  : ラインごとの [offset(要素), len(要素)]
// fids   : ラインごとの feature id
// n_poly / vertex_offset : ポリゴン arc 数・頂点数（グローバル index / offset への繰上げ）
#[wasm_bindgen]
pub fn build_polylines_wasm(coords: &[u64], lines: &[u32], fids: &[u32], n_poly: u32, vertex_offset: u32) -> LineTopology {
    let line_ranges: Vec<(usize, usize)> = lines
        .chunks_exact(2)
        .map(|c| (c[0] as usize, c[1] as usize))
        .collect();
    let fids_i32: Vec<i32> = fids.iter().map(|&f| f as i32).collect();
    polylines_core(coords, &line_ranges, &fids_i32, n_poly, vertex_offset)
}

fn polylines_core(coords: &[u64], line_ranges: &[(usize, usize)], fids: &[i32], n_poly: u32, vertex_offset: u32) -> LineTopology {
    // 1. 頂点出現回数（cutPolyline setHash 相当。キーは raw u64＝JS の BigInt 値と同一）
    let mut hash: FxHashMap<u64, u32> = FxHashMap::default();
    for &(off, len) in line_ranges {
        for &t in &coords[off..off + len] { *hash.entry(t).or_insert(0) += 1; }
    }

    // 2. 分割＋共有 arc 照合（端点キー＋頂点数のみ・内容照合なし＝JS cutPolyline と同じ）
    let mut buffs: Vec<Vec<u64>> = Vec::new();
    let mut a_hash: FxHashMap<(u64, u64, u32), u32> = FxHashMap::default();
    let mut line_arcs: Vec<Vec<i32>> = Vec::with_capacity(line_ranges.len());
    for &(off, len) in line_ranges {
        let arc = &coords[off..off + len];
        let n = arc.len();
        let is_term = |i: usize| i == 0 || i == n - 1 || hash[&arc[i]] > 2;
        let mut indices: Vec<i32> = Vec::new();
        let mut i = 0usize;
        while n > 0 && i < n - 1 {
            let mut j = i + 1;
            while j < n - 1 && !is_term(j) { j += 1; }
            let seg = &arc[i..=j];
            let p = seg[0];
            let q = seg[seg.len() - 1];
            let (min, max) = if p > q { (q, p) } else { (p, q) };
            let key = (min, max, seg.len() as u32);
            let idx = *a_hash.entry(key).or_insert_with(|| {
                buffs.push(seg.to_vec());
                (buffs.len() - 1) as u32
            });
            let forward = p == buffs[idx as usize][0];
            indices.push(if forward { idx as i32 } else { !(idx as i32) });
            i = j;
        }
        line_arcs.push(indices);
    }
    drop(hash);

    // 3. arc メタ → 長さ降順（stable・同値原順＝ポリゴンと同じ意図的相違）→ remap → n_poly 繰上げ
    let mut metas: Vec<ArcMeta> = buffs.iter().enumerate().map(|(i, b)| calc_meta_u64(b, i)).collect();
    metas.sort_by(|p, q| q.length.partial_cmp(&p.length).unwrap_or(std::cmp::Ordering::Equal));
    let mut aid_to_new = vec![0i32; metas.len()];
    for (new_id, m) in metas.iter().enumerate() { aid_to_new[m.aid] = new_id as i32; }
    for arcs in line_arcs.iter_mut() {
        for aid in arcs.iter_mut() {
            let is_rev = *aid < 0;
            let new_id = aid_to_new[(if is_rev { !*aid } else { *aid }) as usize];
            let shifted = new_id + n_poly as i32;
            *aid = if is_rev { !shifted } else { shifted };
        }
    }

    // 4. buildArcs（u64 経路）：長さ順に連結 → arc ごと VW（L1→L2）→ meta 行（weight＝arc 長）
    let count = buffs.len();
    let total: usize = buffs.iter().map(|b| b.len()).sum();
    let mut arc_buffer: Vec<u64> = Vec::with_capacity(total);
    let mut arc_meta: Vec<u32> = Vec::with_capacity(count * 8);
    let mut offset = 0usize;
    for m in metas.iter() {
        let arc = &buffs[m.aid];
        let len = arc.len();
        arc_buffer.extend_from_slice(arc);
        arc_meta.extend_from_slice(&[
            offset as u32 + vertex_offset, len as u32, m.length as u32, 0,
            m.bbox[0], m.bbox[1], m.bbox[2], m.bbox[3],
        ]);
        if len >= 3 {
            l2_to_l2(&mut arc_buffer[offset..offset + len]);
        }
        offset += len;
    }

    // 5. polyline stream：fid 初出順（原順）にグループ化 [fid][numSets][arcCount][arcIdx...]...
    let mut fid_slot: FxHashMap<i32, usize> = FxHashMap::default();
    let mut grouped: Vec<(i32, Vec<usize>)> = Vec::new();
    for (li, &fid) in fids.iter().enumerate() {
        let slot = *fid_slot.entry(fid).or_insert_with(|| { grouped.push((fid, Vec::new())); grouped.len() - 1 });
        grouped[slot].1.push(li);
    }
    let mut line_stream: Vec<i32> = Vec::new();
    for (fid, sets) in grouped.iter() {
        line_stream.push(*fid);
        line_stream.push(sets.len() as i32);
        for &li in sets {
            let arcs = &line_arcs[li];
            line_stream.push(arcs.len() as i32);
            line_stream.extend_from_slice(arcs);
        }
    }

    LineTopology { arc_buffer, arc_meta, line_stream, count: count as u32 }
}

// ── 本体：JS buildPolygons + topology() の polygon stream / neighbor stream 組立の一括版 ──
// xy    : 全リング連結 XY（u32 ペア・densify/fit/offset 適用済みの gint 整数座標）
// rings : リングごとの [offset(頂点), len(頂点)]
// comps : コンポーネント（MultiPolygon の島）ごとの [fid, ringCount]。リングは出現順に消費。
#[wasm_bindgen]
pub fn build_polygons_wasm(xy: &[u32], rings: &[u32], comps: &[u32]) -> PolyTopology {
    let ring_ranges: Vec<(usize, usize)> = rings
        .chunks_exact(2)
        .map(|c| (c[0] as usize, c[1] as usize))
        .collect();
    let comp_pairs: Vec<(i32, usize)> = comps
        .chunks_exact(2)
        .map(|c| (c[0] as i32, c[1] as usize))
        .collect();
    polygons_core(xy, &ring_ranges, &comp_pairs)
}

fn polygons_core(xy: &[u32], ring_ranges: &[(usize, usize)], comps: &[(i32, usize)]) -> PolyTopology {
    // 1. 接合点判定
    let junctions = compute_junctions(xy, ring_ranges);

    // 2. リング分割＋共有 arc 照合
    let mut reg = ArcRegistry::new();
    let mut comp_list: Vec<Comp> = Vec::with_capacity(comps.len());
    let mut ring_cursor = 0usize;
    for &(fid, ring_count) in comps {
        let mut arcs = Vec::with_capacity(ring_count);
        for _ in 0..ring_count {
            let (off, len) = ring_ranges[ring_cursor];
            ring_cursor += 1;
            arcs.push(split_ring(&xy[off * 2..(off + len) * 2], &junctions, &mut reg));
        }
        comp_list.push(Comp { fid, arcs, weight: 0.0 });
    }
    drop(junctions);

    // 3. arc メタ（登録順＝aid 順）
    let mut metas: Vec<ArcMeta> = reg.arcs.iter().enumerate().map(|(i, a)| calc_meta_xy(a, i)).collect();

    // 4. metaPolygon：comp weight → arc weight 伝播 → 並べ替え → remap
    for q in comp_list.iter_mut() {
        let mut a_sum = 0.0f64;
        let mut l_sum = 0.0f64;
        if let Some(ring0) = q.arcs.first() {
            for &aid in ring0 {
                let m = &metas[if aid < 0 { !aid } else { aid } as usize];
                l_sum += m.length;
                a_sum += if aid < 0 { -m.area } else { m.area };
            }
        }
        for ring in q.arcs.iter().skip(1) {
            for &aid in ring {
                let m = &metas[if aid < 0 { !aid } else { aid } as usize];
                a_sum += if aid < 0 { -m.area } else { m.area };
            }
        }
        q.weight = (a_sum.abs() / 2.0).sqrt() + l_sum / 4.0;
        for ring in q.arcs.iter() {
            for &aid in ring {
                let p = &mut metas[if aid < 0 { !aid } else { aid } as usize];
                p.owner_count += 1;
                if q.weight > p.weight { p.weight = q.weight; }
            }
        }
    }
    // weight 降順（stable：同値は原順維持＝意図的相違、冒頭コメント参照）
    comp_list.sort_by(|p, q| q.weight.partial_cmp(&p.weight).unwrap_or(std::cmp::Ordering::Equal));
    let max_weight = comp_list.first().map_or(0.0, |t| t.weight);
    for p in metas.iter_mut() {
        if p.owner_count == 1 && !p.closed { p.weight = max_weight; }
    }
    metas.sort_by(|p, q| q.weight.partial_cmp(&p.weight).unwrap_or(std::cmp::Ordering::Equal));
    let mut aid_to_new = vec![0i32; metas.len()];
    for (new_id, m) in metas.iter().enumerate() { aid_to_new[m.aid] = new_id as i32; }
    for q in comp_list.iter_mut() {
        for ring in q.arcs.iter_mut() {
            for aid in ring.iter_mut() {
                let is_rev = *aid < 0;
                let new_id = aid_to_new[(if is_rev { !*aid } else { *aid }) as usize];
                *aid = if is_rev { !new_id } else { new_id };
            }
        }
    }

    // 5. buildArcs：weight 順に連結 → Morton L1 化 → arc ごと VW（L1→L2）→ meta 行
    let count = reg.arcs.len();
    let total: usize = reg.arcs.iter().map(|a| a.len() >> 1).sum();
    let mut arc_buffer: Vec<u64> = Vec::with_capacity(total);
    let mut arc_meta: Vec<u32> = Vec::with_capacity(count * 8);
    let mut offset = 0usize;
    for m in metas.iter() {
        let arc = &reg.arcs[m.aid];
        let len = arc.len() >> 1;
        for i in 0..len {
            arc_buffer.push(pure_morton_from_int(arc[i * 2], arc[i * 2 + 1]) | TERMINAL_BIT);
        }
        // JS: Uint32Array への代入＝ToUint32。weight は正の有限値（範囲内なら as u32 と同値）
        arc_meta.extend_from_slice(&[
            offset as u32, len as u32, m.weight as u32, 0,
            m.bbox[0], m.bbox[1], m.bbox[2], m.bbox[3],
        ]);
        if len >= 3 {
            l2_to_l2(&mut arc_buffer[offset..offset + len]);
        }
        offset += len;
    }

    // 6. polygon stream：fid 初出順にグループ化（JS は weight ソート後の structures[0] から Map で組む）
    let mut fid_order: Vec<i32> = Vec::new();
    let mut fid_slot: FxHashMap<i32, usize> = FxHashMap::default();
    let mut grouped: Vec<Vec<usize>> = Vec::new();
    for (ci, q) in comp_list.iter().enumerate() {
        let slot = *fid_slot.entry(q.fid).or_insert_with(|| {
            fid_order.push(q.fid);
            grouped.push(Vec::new());
            grouped.len() - 1
        });
        grouped[slot].push(ci);
    }
    let mut poly_stream: Vec<i32> = Vec::new();
    for slot in 0..grouped.len() {
        for &ci in &grouped[slot] {
            let q = &comp_list[ci];
            poly_stream.push(q.fid);
            poly_stream.push(q.arcs.len() as i32);
            for ring in q.arcs.iter() {
                poly_stream.push(ring.len() as i32);
                poly_stream.extend_from_slice(ring);
            }
        }
    }

    // 7. neighbor stream：arc 共有からの隣接（fid は nbMap 初出順・隣接リストは昇順）
    let mut owner_arr: Vec<Vec<i32>> = vec![Vec::new(); count];
    for q in comp_list.iter() {
        for ring in q.arcs.iter() {
            for &aid in ring {
                owner_arr[(if aid < 0 { !aid } else { aid }) as usize].push(q.fid);
            }
        }
    }
    let mut nb_order: Vec<i32> = Vec::new();
    let mut nb_map: FxHashMap<i32, std::collections::BTreeSet<i32>> = FxHashMap::default();
    for ids in owner_arr.iter() {
        if ids.len() < 2 { continue; }
        for &id in ids {
            if !nb_map.contains_key(&id) { nb_order.push(id); }
            let nb = nb_map.entry(id).or_default();
            for &t in ids { if t != id { nb.insert(t); } }
        }
    }
    let mut neighbor_stream: Vec<i32> = Vec::new();
    for fid in nb_order {
        let nb = &nb_map[&fid];
        neighbor_stream.push(fid);
        neighbor_stream.push(nb.len() as i32);
        neighbor_stream.extend(nb.iter());
    }

    PolyTopology { arc_buffer, arc_meta, poly_stream, neighbor_stream, count: count as u32 }
}

// ── 全量経路：PBF 生バイト → GintBUF 完成品 ─────────────────────────────────
// JS は feature 台帳（[fid, type, geomPos]×n）を組むだけ。デルタ復号（readSVarint）→
// fit（精度変換）→ densify（1度刻み中間点＝米加国境の弦浮き対策）→ 位相 → GintBUF
// レイアウト組立まで全部ここ。JS topology() の parse ループと同一の数値経路
//（f64 の演算順・ゼロデルタ棄却・ToUint32 截断・elemCount の数え方）を保つ。

struct Pbf<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Pbf<'a> {
    #[inline]
    fn varint(&mut self) -> u64 {
        let mut v: u64 = 0;
        let mut shift = 0u32;
        loop {
            let b = self.buf[self.pos];
            self.pos += 1;
            v |= ((b & 0x7F) as u64) << shift;
            if b < 0x80 { return v; }
            shift += 7;
            if shift >= 64 { return v; }
        }
    }
    #[inline]
    fn svarint(&mut self) -> i64 {
        let n = self.varint();
        ((n >> 1) as i64) ^ (-((n & 1) as i64))
    }
    #[inline]
    fn skip(&mut self, wt: u32) {
        match wt {
            0 => { self.varint(); }
            1 => { self.pos += 8; }
            2 => { let l = self.varint() as usize; self.pos += l; }
            5 => { self.pos += 4; }
            _ => { self.pos = self.buf.len(); }   // 未知 wiretype＝以降を読まない（JS pbf は throw）
        }
    }
}

// JS の ToUint32（Uint32Array 代入時の截断）：非有限は 0、有限は 0 方向へ切って mod 2^32
#[inline]
fn to_js_u32(v: f64) -> u32 {
    if !v.is_finite() { return 0; }
    (v.trunc() as i64) as u32
}

// デコード共有状態（頂点カウンタ elem[3] と 生座標 bbox）
struct ReadCtx {
    elem3: u32,
    bx0: f64, by0: f64, bx1: f64, by1: f64,
    factor: f64,
    fit_round: bool,
}

// 1本ぶんのデコード（n=Some(頂点数) or None=ブロック終端 cend まで）。
// out_xy=Some なら XY(u32) を、out_m=Some なら L1 Morton(u64) を積む。
// JS read() と同一：呼び出し1回＝elem3++、採用 grab ごとに elem3++・ゼロデルタ棄却・densify 1度刻み。
fn read_line(p: &mut Pbf, cend: usize, n: Option<usize>, ctx: &mut ReadCtx,
             mut out_xy: Option<&mut Vec<u32>>, mut out_m: Option<&mut Vec<u64>>) {
    const SCALE_E_F: f64 = 10_000_000.0;
    const OFFSET_X: f64 = 180.0 * SCALE_E_F;
    const OFFSET_Y: f64 = 90.0 * SCALE_E_F;
    ctx.elem3 += 1;
    let mut x: i64 = 0;
    let mut y: i64 = 0;
    let mut prev: Option<(f64, f64)> = None;
    macro_rules! push {
        ($gx:expr, $gy:expr) => {
            if let Some(v) = out_xy.as_deref_mut() { v.push(to_js_u32($gx)); v.push(to_js_u32($gy)); }
            if let Some(v) = out_m.as_deref_mut() { v.push(pure_morton_from_int(to_js_u32($gx), to_js_u32($gy)) | TERMINAL_BIT); }
        };
    }
    macro_rules! grab {
        () => {{
            let dx = p.svarint();
            let dy = p.svarint();
            if dx != 0 || dy != 0 {
                x += dx;
                y += dy;
                let (xf, yf) = (x as f64, y as f64);
                if xf < ctx.bx0 { ctx.bx0 = xf; }
                if xf > ctx.bx1 { ctx.bx1 = xf; }
                if yf < ctx.by0 { ctx.by0 = yf; }
                if yf > ctx.by1 { ctx.by1 = yf; }
                let vx = if ctx.fit_round { (xf * ctx.factor).round() } else { xf * ctx.factor };
                let vy = if ctx.fit_round { (yf * ctx.factor).round() } else { yf * ctx.factor };
                let gx = vx + OFFSET_X;
                let gy = vy + OFFSET_Y;
                if let Some((pgx, pgy)) = prev {
                    let dgx = gx - pgx;
                    let dgy = gy - pgy;
                    let steps = (dgx.abs().max(dgy.abs()) / SCALE_E_F).ceil();
                    let stepsi = steps as i64;
                    for s in 1..stepsi {
                        push!((pgx + dgx * s as f64 / steps).round(), (pgy + dgy * s as f64 / steps).round());
                    }
                }
                push!(gx, gy);
                prev = Some((gx, gy));
                ctx.elem3 += 1;
            }
        }};
    }
    match n {
        None => { while p.pos < cend { grab!(); } }
        Some(mut k) => { while k > 0 { grab!(); k -= 1; } }
    }
}

#[wasm_bindgen]
pub struct GintBufOut {
    data: Vec<u8>,
}

#[wasm_bindgen]
impl GintBufOut {
    pub fn ptr(&self) -> u32 { self.data.as_ptr() as u32 }
    pub fn len(&self) -> u32 { self.data.len() as u32 }
}

// buf : GeoPBF の生バイト列（geomPos は絶対オフセット）
// dir : feature 台帳 [fid, type(0..5), geomPos]×n（GeometryCollection は JS 側で展開済み）
// e   : ソース精度（10^precision）
// format_version : topology.FORMAT_VERSION（GintBUF ヘッダへ）
#[wasm_bindgen]
pub fn topology_full_wasm(buf: &[u8], dir: &[u32], e: f64, format_version: u32) -> GintBufOut {
    const SCALE_E_F: f64 = 10_000_000.0;
    const OFFSET_X: f64 = 180.0 * SCALE_E_F;
    const OFFSET_Y: f64 = 90.0 * SCALE_E_F;

    // fit：JS と同じ分岐（factor<1 のときだけ round）
    let factor = if SCALE_E_F < e { SCALE_E_F / e } else { (SCALE_E_F / e).round() };
    let fit_round = factor < 1.0;

    // 構造体展開先（JS structures 相当・push 順序も同一）
    let mut poly_xy: Vec<u32> = Vec::new();                 // 全リング連結 XY
    let mut poly_rings: Vec<(usize, usize)> = Vec::new();   // リング [offset, len]（頂点単位）
    let mut poly_comps: Vec<(i32, usize)> = Vec::new();     // コンポーネント [fid, ringCount]
    let mut line_coords: Vec<u64> = Vec::new();             // 全ライン連結 L1 Morton
    let mut line_ranges: Vec<(usize, usize)> = Vec::new();
    let mut line_fids: Vec<i32> = Vec::new();
    let mut points: Vec<(u64, u32)> = Vec::new();           // (L1 Morton, fid)

    let mut elem = [0u32; 4];
    let mut ctx = ReadCtx {
        elem3: 0,
        bx0: f64::INFINITY, by0: f64::INFINITY,
        bx1: f64::NEG_INFINITY, by1: f64::NEG_INFINITY,
        factor, fit_round,
    };

    for d in dir.chunks_exact(3) {
        let fid = d[0] as i32;
        let typ = d[1];
        let mut p = Pbf { buf, pos: d[2] as usize };
        let msg_len = p.varint() as usize;
        let end = p.pos + msg_len;
        let mut lens: Vec<usize> = Vec::new();
        while p.pos < end {
            let key = p.varint() as u32;
            let field = key >> 3;
            let wt = key & 7;
            if field == 9 {
                // LENGTH（packed varint／単発 varint 両対応＝pbf.readPackedVarint 準拠）
                if wt == 2 {
                    let l = p.varint() as usize;
                    let e2 = p.pos + l;
                    while p.pos < e2 { lens.push(p.varint() as usize); }
                } else { lens.push(p.varint() as usize); }
            } else if field == 10 && wt == 2 {
                // COORDS：デルタ復号＋densify（read_line）。read 1回＝elem3++、採用 grab ごとに elem3++（JS 同一）
                let l = p.varint() as usize;
                let cend = p.pos + l;
                match typ {
                    0 | 1 => {   // Point / MultiPoint
                        let mut m: Vec<u64> = Vec::new();
                        if typ == 0 { read_line(&mut p, cend, Some(1), &mut ctx, None, Some(&mut m)); }
                        else { read_line(&mut p, cend, None, &mut ctx, None, Some(&mut m)); }
                        elem[2] += m.len() as u32;
                        for v in m { points.push((v, fid as u32)); }
                    }
                    2 => {       // LineString
                        let off = line_coords.len();
                        read_line(&mut p, cend, None, &mut ctx, None, Some(&mut line_coords));
                        line_ranges.push((off, line_coords.len() - off));
                        line_fids.push(fid);
                        elem[1] += 1;
                    }
                    3 => {       // MultiLineString
                        for &t in lens.iter() {
                            let off = line_coords.len();
                            read_line(&mut p, cend, Some(t), &mut ctx, None, Some(&mut line_coords));
                            line_ranges.push((off, line_coords.len() - off));
                            line_fids.push(fid);
                            elem[1] += 1;
                        }
                    }
                    4 => {       // Polygon＝1コンポーネント
                        for &t in lens.iter() {
                            let off = poly_xy.len() >> 1;
                            read_line(&mut p, cend, Some(t), &mut ctx, Some(&mut poly_xy), None);
                            poly_rings.push((off, (poly_xy.len() >> 1) - off));
                        }
                        poly_comps.push((fid, lens.len()));
                        elem[0] += 1;
                    }
                    5 => {       // MultiPolygon：lens=[numComps, rings1, v11, v12, …, rings2, …]
                        let mut li = 0usize;
                        let num = *lens.first().unwrap_or(&0);
                        for _ in 0..num {
                            li += 1;
                            let rings = *lens.get(li).unwrap_or(&0);
                            for _ in 0..rings {
                                li += 1;
                                let t = *lens.get(li).unwrap_or(&0);
                                let off = poly_xy.len() >> 1;
                                read_line(&mut p, cend, Some(t), &mut ctx, Some(&mut poly_xy), None);
                                poly_rings.push((off, (poly_xy.len() >> 1) - off));
                            }
                            poly_comps.push((fid, rings));
                            elem[0] += 1;
                        }
                    }
                    _ => {}
                }
                p.pos = cend;
            } else {
                p.skip(wt);
            }
        }
    }

    // bbox：raw min/max → gint 整数座標（JS と同じ f64 経路・空データは ToUint32(Inf)=0）
    elem[3] = ctx.elem3;
    let bbox = [
        to_js_u32((((ctx.bx0 / e) + 180.0) * SCALE_E_F).round()),
        to_js_u32((((ctx.by0 / e) + 90.0) * SCALE_E_F).round()),
        to_js_u32((((ctx.bx1 / e) + 180.0) * SCALE_E_F).round()),
        to_js_u32((((ctx.by1 / e) + 90.0) * SCALE_E_F).round()),
    ];

    // 位相構築（ポリゴン→ライン→ポイント）
    let pt = polygons_core(&poly_xy, &poly_rings, &poly_comps);
    let lt = polylines_core(&line_coords, &line_ranges, &line_fids, pt.count, pt.arc_buffer.len() as u32);
    // JS buildPoints の sort は比較器が 0 を返さない（equal→-1）＝V8 TimSort では同値が逆順になる
    //（挿入は「同値なら前へ」・マージは「同値なら右ランを先に」）。座標昇順・同値は元 index 降順で再現。
    {
        let mut idx: Vec<(u64, u32, usize)> = points.iter().enumerate().map(|(i, &(m, f))| (m, f, i)).collect();
        idx.sort_by(|a, b| a.0.cmp(&b.0).then(b.2.cmp(&a.2)));
        points = idx.into_iter().map(|(m, f, _)| (m, f)).collect();
    }

    // GintBUF 組立（JS topology() 末尾と同一レイアウト）
    let arc_length = pt.arc_buffer.len() + lt.arc_buffer.len();
    let arc_count = (pt.count + lt.count) as usize;
    let point_count = points.len();
    if point_count > 0 { elem[2] = point_count as u32; }
    let header: [u32; 16] = [
        1953392967, format_version, elem[0], elem[1], elem[2], elem[3],
        arc_length as u32, arc_count as u32, bbox[0], bbox[1], bbox[2], bbox[3],
        pt.poly_stream.len() as u32, lt.line_stream.len() as u32, pt.neighbor_stream.len() as u32, 0,
    ];
    let total = 64 + arc_length * 8 + arc_count * 8 * 4 + point_count * (8 + 4)
        + (pt.poly_stream.len() + lt.line_stream.len() + pt.neighbor_stream.len()) * 4;
    let mut data: Vec<u8> = Vec::with_capacity(total);
    // wasm32 はリトルエンディアン＝JS の TypedArray view.set と同一のバイト列
    let as_u8 = |p: *const u8, n: usize| unsafe { std::slice::from_raw_parts(p, n) };
    data.extend_from_slice(as_u8(header.as_ptr() as *const u8, 64));
    data.extend_from_slice(as_u8(pt.arc_buffer.as_ptr() as *const u8, pt.arc_buffer.len() * 8));
    data.extend_from_slice(as_u8(lt.arc_buffer.as_ptr() as *const u8, lt.arc_buffer.len() * 8));
    for &(m, _) in &points { data.extend_from_slice(&m.to_le_bytes()); }
    data.extend_from_slice(as_u8(pt.arc_meta.as_ptr() as *const u8, pt.arc_meta.len() * 4));
    data.extend_from_slice(as_u8(lt.arc_meta.as_ptr() as *const u8, lt.arc_meta.len() * 4));
    for &(_, f) in &points { data.extend_from_slice(&f.to_le_bytes()); }
    data.extend_from_slice(as_u8(pt.poly_stream.as_ptr() as *const u8, pt.poly_stream.len() * 4));
    data.extend_from_slice(as_u8(lt.line_stream.as_ptr() as *const u8, lt.line_stream.len() * 4));
    data.extend_from_slice(as_u8(pt.neighbor_stream.as_ptr() as *const u8, pt.neighbor_stream.len() * 4));
    debug_assert_eq!(data.len(), total);

    GintBufOut { data }
}
