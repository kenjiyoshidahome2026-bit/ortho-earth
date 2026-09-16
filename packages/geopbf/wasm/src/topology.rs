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
use rustc_hash::FxHashMap;
use super::{pure_morton_from_int, TERMINAL_BIT};
use crate::l2_to_l2;

const RAD: f64 = std::f64::consts::PI / 180.0;
const RADIUS: f64 = 6371008.8;
const INV_SCALE_E: f64 = 1.0 / 10_000_000.0;

#[inline(always)]
fn vkey(x: u32, y: u32) -> u64 {
    ((x as u64) << 32) | (y as u64)
}

// ── 座標キー用ハッシュ ──────────────────────────────────────────────────
// gint 座標は precision<7 だと全て 10^(7-p) の倍数（ZCTA=precision5 → ×100＝下位2bit常時ゼロ）。
// FxHash（乗算1回）は下位ビットのエントロピーが下位に留まり、hashbrown のバケツ選択（ハッシュ下位）が
// 1/4 に集中→プローブ連鎖爆発（ZCTA実測：接合点判定 133s）。splitmix64 の仕上げ混合で
// 上位のエントロピーを下位へ折り返す＝キー構造に依らず均一分布。
#[inline(always)]
fn mix64(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
    z ^ (z >> 31)
}

#[derive(Default)]
struct MixHasher {
    h: u64,
}

impl std::hash::Hasher for MixHasher {
    #[inline(always)]
    fn finish(&self) -> u64 { self.h }
    #[inline(always)]
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes { self.h = mix64(self.h ^ b as u64); }
    }
    #[inline(always)]
    fn write_u32(&mut self, v: u32) { self.h = mix64(self.h ^ v as u64); }
    #[inline(always)]
    fn write_u64(&mut self, v: u64) { self.h = mix64(self.h ^ v); }
    #[inline(always)]
    fn write_usize(&mut self, v: usize) { self.h = mix64(self.h ^ v as u64); }
}

type MixBuild = std::hash::BuildHasherDefault<MixHasher>;
type MixMap<K, V> = std::collections::HashMap<K, V, MixBuild>;
type MixSet<K> = std::collections::HashSet<K, MixBuild>;

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
fn compute_junctions(xy: &[u32], ring_ranges: &[(usize, usize)]) -> MixSet<u64> {
    let mut pair: MixMap<u64, (u64, u64)> = MixMap::default();
    let mut marks: MixSet<u64> = MixSet::default();
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
    index: MixMap<(u64, u64, u32), Vec<u32>>,
}

impl ArcRegistry {
    fn new() -> Self { ArcRegistry { arcs: Vec::new(), index: MixMap::default() } }

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
fn split_ring(ring: &[u32], junctions: &MixSet<u64>, reg: &mut ArcRegistry) -> Vec<i32> {
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
    let mut hash: MixMap<u64, u32> = MixMap::default();
    for &(off, len) in line_ranges {
        for &t in &coords[off..off + len] { *hash.entry(t).or_insert(0) += 1; }
    }

    // 2. 分割＋共有 arc 照合（端点キー＋頂点数のみ・内容照合なし＝JS cutPolyline と同じ）
    let mut buffs: Vec<Vec<u64>> = Vec::new();
    let mut a_hash: MixMap<(u64, u64, u32), u32> = MixMap::default();
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
// fit（精度変換）→ 位相 → GintBUF（長辺の度アンカーは JS 後処理 insertDegreeAnchors が大円で打つ＝v5）
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
// JS read() と同一：呼び出し1回＝elem3++、採用 grab ごとに elem3++・ゼロデルタ棄却（1点目は除く）。densify は v5 で撤去（度アンカーは JS 後処理が大円で打つ）。
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
            // ゼロデルタ棄却。ただし1点目は必ず採用（差分の原点が(0,0)＝先頭が null island だと差分0で落ちていた）
            if dx != 0 || dy != 0 || prev.is_none() {
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
                // 長辺の細分はここでしない（v5）＝位相後の JS insertDegreeAnchors が大円で内挿する唯一の場所（JS read() と同一）
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

// =========================================================================
// purifier（JS topology.js の purifier をそのまま移植・2026-09-16）
// ライン同士／自身の交差点・T 字接触（端点が相手の辺から 11cm 以内）・共線重なりの端点を両方の線へ頂点として挿入し、
// A-B-A のスパイクを落とす＝後段の cutPolyline が交差点を接合点として arc を切れるようにする。
// 80k セグメント超は素通し（Census/OSM 級は位相整合済み・JS 版と同じ閾値）。
// 整数演算＝JS の BigInt と同じ真値（i128・除算は 0 方向切り捨て＝BigInt と同一）。
// JS 版との差＝無し（点集合は順序非依存・挿入順は Map の初出順を Vec で再現・距離ソートは stable）。
// =========================================================================
struct PSeg { line: usize, sidx: usize, x1: i64, y1: i64, x2: i64, y2: i64, bx1: i64, bx2: i64, by1: i64, by2: i64, p1: u64, p2: u64, hits: Vec<(i64, i64, u64)> }

fn purify_lines(coords: &mut Vec<u64>, ranges: &mut Vec<(usize, usize)>) {
    if ranges.is_empty() { return; }
    let total_segs: usize = ranges.iter().map(|&(_, len)| len.saturating_sub(1)).sum();
    if total_segs == 0 || total_segs > 80_000 { return; }
    const GRID_SHIFT: u32 = 16;
    const SNAP: i128 = 125;   // 11 cm
    const UNIT: i128 = 10;    // 10 cm grid

    // セグメント展開（連続重複点の辺は作らない＝JS と同じ）
    let mut segs: Vec<PSeg> = Vec::with_capacity(total_segs);
    let mut seg_of: Vec<Vec<i32>> = Vec::with_capacity(ranges.len());   // line → sidx → seg index（-1＝無し）
    let mut cells: Vec<Vec<u32>> = Vec::new();                          // 格子セル（初出順）
    let mut cell_of: FxHashMap<u64, u32> = FxHashMap::default();
    for (li, &(off, len)) in ranges.iter().enumerate() {
        let mut so = vec![-1i32; len.saturating_sub(1)];
        for i in 0..len.saturating_sub(1) {
            let (a, b) = (coords[off + i], coords[off + i + 1]);
            if a == b { continue; }
            let (ax, ay) = crate::unpack_to_int(a); let (bx, by) = crate::unpack_to_int(b);
            let (x1, y1, x2, y2) = (ax as i64, ay as i64, bx as i64, by as i64);
            let sid = segs.len() as u32;
            let sg = PSeg { line: li, sidx: i, x1, y1, x2, y2, bx1: x1.min(x2), bx2: x1.max(x2), by1: y1.min(y2), by2: y1.max(y2), p1: a, p2: b, hits: Vec::new() };
            for gx in (sg.bx1 as u64 >> GRID_SHIFT)..=(sg.bx2 as u64 >> GRID_SHIFT) {
                for gy in (sg.by1 as u64 >> GRID_SHIFT)..=(sg.by2 as u64 >> GRID_SHIFT) {
                    let key = (gx << 16) | gy;
                    let ci = *cell_of.entry(key).or_insert_with(|| { cells.push(Vec::new()); (cells.len() - 1) as u32 });
                    cells[ci as usize].push(sid);
                }
            }
            segs.push(sg);
            so[i] = sid as i32;
        }
        seg_of.push(so);
    }
    if segs.len() < 2 { return; }

    // 端点スナップ／格子スナップ（JS getPt）
    let get_pt = |ix: i128, iy: i128, eps: &[(i64, i64, u64); 4]| -> (i64, i64, u64) {
        for &(ex, ey, ep) in eps {
            let (dx, dy) = (ix - ex as i128, iy - ey as i128);
            if dx * dx + dy * dy <= SNAP { return (ex, ey, ep); }
        }
        let sx = ((ix + UNIT / 2) / UNIT * UNIT) as i64;
        let sy = ((iy + UNIT / 2) / UNIT * UNIT) as i64;
        (sx, sy, pure_morton_from_int(sx as u32, sy as u32) | TERMINAL_BIT)
    };
    // JS solver：交点・共線重なりの端点・端点の相手辺への射影（11cm 以内）
    let solve = |s1: &PSeg, s2: &PSeg, out: &mut Vec<(i64, i64, u64)>| {
        let (dx1, dy1) = ((s1.x2 - s1.x1) as i128, (s1.y2 - s1.y1) as i128);
        let (dx2, dy2) = ((s2.x2 - s2.x1) as i128, (s2.y2 - s2.y1) as i128);
        let det = dx1 * dy2 - dy1 * dx2;
        let eps = [(s1.x1, s1.y1, s1.p1), (s1.x2, s1.y2, s1.p2), (s2.x1, s2.y1, s2.p1), (s2.x2, s2.y2, s2.p2)];
        if det == 0 {
            let cross = (s2.x1 - s1.x1) as i128 * dy1 - (s2.y1 - s1.y1) as i128 * dx1;
            if cross == 0 {
                let on = |px: i64, py: i64, lx1: i64, ly1: i64, lx2: i64, ly2: i64| -> bool {
                    let (ldx, ldy) = ((lx2 - lx1) as i128, (ly2 - ly1) as i128);
                    let dot = (px - lx1) as i128 * ldx + (py - ly1) as i128 * ldy;
                    dot > 0 && dot < ldx * ldx + ldy * ldy
                };
                for &(ex, ey, ep) in &eps {
                    if on(ex, ey, s1.x1, s1.y1, s1.x2, s1.y2) || on(ex, ey, s2.x1, s2.y1, s2.x2, s2.y2) { out.push((ex, ey, ep)); }
                }
            }
        } else {
            let nt = (s2.x1 - s1.x1) as i128 * dy2 - (s2.y1 - s1.y1) as i128 * dx2;
            let nu = (s2.x1 - s1.x1) as i128 * dy1 - (s2.y1 - s1.y1) as i128 * dx1;
            let is_in = |n: i128, d: i128| if d > 0 { n >= 0 && n <= d } else { n <= 0 && n >= d };
            if is_in(nt, det) && is_in(nu, det) {
                out.push(get_pt(s1.x1 as i128 + (nt * dx1) / det, s1.y1 as i128 + (nt * dy1) / det, &eps));
            }
        }
        let proj = |px: i64, py: i64, lx1: i64, ly1: i64, lx2: i64, ly2: i64, out: &mut Vec<(i64, i64, u64)>| {
            let (ldx, ldy) = ((lx2 - lx1) as i128, (ly2 - ly1) as i128);
            let d2 = ldx * ldx + ldy * ldy;
            if d2 == 0 { return; }
            let t = (px - lx1) as i128 * ldx + (py - ly1) as i128 * ldy;
            if t <= 0 || t >= d2 { return; }
            let crs = (px - lx1) as i128 * ldy - (py - ly1) as i128 * ldx;
            // JS: (crs*crs)/d2 <= snap（BigInt 切り捨て）⇔ crs² < (snap+1)·d2。crs² は i128 の縁に届き得るので u128 で比べる
            let c2 = (crs.unsigned_abs() as u128) * (crs.unsigned_abs() as u128);
            if c2 < ((SNAP + 1) as u128) * (d2 as u128) {
                out.push(get_pt(lx1 as i128 + (t * ldx) / d2, ly1 as i128 + (t * ldy) / d2, &eps));
            }
        };
        proj(s2.x1, s2.y1, s1.x1, s1.y1, s1.x2, s1.y2, out);
        proj(s2.x2, s2.y2, s1.x1, s1.y1, s1.x2, s1.y2, out);
        proj(s1.x1, s1.y1, s2.x1, s2.y1, s2.x2, s2.y2, out);
        proj(s1.x2, s1.y2, s2.x1, s2.y1, s2.x2, s2.y2, out);
    };

    // 格子セル内の総当たり（JS と同じ：2 本未満・1500 本超のセルは飛ばす）
    let seg_count = segs.len();
    let mut checked: rustc_hash::FxHashSet<u64> = rustc_hash::FxHashSet::default();
    let mut pts: Vec<(i64, i64, u64)> = Vec::new();
    let add_hit = |s: &mut PSeg, p: (i64, i64, u64)| { if !s.hits.iter().any(|h| h.0 == p.0 && h.1 == p.1) { s.hits.push(p); } };   // JS Map.set＝同キーは初出位置を保つ
    for cell in &cells {
        if cell.len() < 2 || cell.len() > 1500 { continue; }
        for i in 0..cell.len() {
            for j in (i + 1)..cell.len() {
                let (a, b) = (cell[i] as usize, cell[j] as usize);
                {
                    let (s1, s2) = (&segs[a], &segs[b]);
                    if s1.line == s2.line && (s1.sidx as i64 - s2.sidx as i64).abs() <= 1 { continue; }
                    if !checked.insert((a.min(b) * seg_count + a.max(b)) as u64) { continue; }
                    if s1.bx2 < s2.bx1 || s1.bx1 > s2.bx2 || s1.by2 < s2.by1 || s1.by1 > s2.by2 { continue; }
                    pts.clear();
                    solve(s1, s2, &mut pts);
                }
                if pts.is_empty() { continue; }
                let (lo, hi) = (a.min(b), a.max(b));
                let (left, right) = segs.split_at_mut(hi);
                let (sa, sb) = (&mut left[lo], &mut right[0]);
                for &p in &pts { add_hit(sa, p); add_hit(sb, p); }
            }
        }
    }

    // 再構築（JS pushClean＝連続重複を捨て・A-B-A スパイクは戻す）
    let mut new_coords: Vec<u64> = Vec::with_capacity(coords.len());
    let mut new_ranges: Vec<(usize, usize)> = Vec::with_capacity(ranges.len());
    let mut final_: Vec<u64> = Vec::new();
    for (li, &(off, len)) in ranges.iter().enumerate() {
        final_.clear();
        let mut push_clean = |p: u64, f: &mut Vec<u64>| {
            let n = f.len();
            if n > 0 && f[n - 1] == p { return; }
            if n > 1 && f[n - 2] == p { f.pop(); return; }
            f.push(p);
        };
        if len > 0 {
            for i in 0..len - 1 {
                push_clean(coords[off + i], &mut final_);
                let sid = seg_of[li][i];
                if sid >= 0 {
                    let s = &mut segs[sid as usize];
                    if !s.hits.is_empty() {
                        let (x1, y1) = (s.x1 as f64, s.y1 as f64);
                        s.hits.sort_by(|a, b| {
                            let da = (a.0 as f64 - x1).powi(2) + (a.1 as f64 - y1).powi(2);
                            let db = (b.0 as f64 - x1).powi(2) + (b.1 as f64 - y1).powi(2);
                            da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
                        });
                        for h in &s.hits { push_clean(h.2, &mut final_); }
                    }
                }
            }
            push_clean(coords[off + len - 1], &mut final_);
        }
        let start = new_coords.len();
        if final_.len() >= 2 { new_coords.extend_from_slice(&final_); }
        else { new_coords.extend_from_slice(&coords[off..off + len]); }   // JS: final が 2 点未満なら原線のまま
        new_ranges.push((start, new_coords.len() - start));
    }
    *coords = new_coords;
    *ranges = new_ranges;
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
    purify_lines(&mut line_coords, &mut line_ranges);   // 自己交差修復（JS buildPolylines の purifier 相当・80k セグ以下）
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
