// packages/wasm/src/pbf_decoder.rs

#[inline]
pub fn read_svarint(buffer: &[u8], pos: &mut usize) -> i32 {
    let mut value: u64 = 0;
    let mut shift = 0;
    while *pos < buffer.len() {
        let byte = buffer[*pos];
        *pos += 1;
        value |= ((byte & 0x7F) as u64) << shift;
        if (byte & 0x80) == 0 { break; }
        shift += 7;
    }
    ((value >> 1) as i32) ^ -((value & 1) as i32)
}

#[inline]
fn spread_bits_32(x: u32) -> u64 {
    let mut val = x as u64;
    val = (val | (val << 16)) & 0x0000FFFF0000FFFF;
    val = (val | (val << 8))  & 0x00FF00FF00FF00FF;
    val = (val | (val << 4))  & 0x0F0F0F0F0F0F0F0F;
    val = (val | (val << 2))  & 0x3333333333333333;
    val = (val | (val << 1))  & 0x5555555555555555;
    val
}

#[inline]
fn pack_gint_morton(x: i32, y: i32) -> u64 {
    let x_spread = spread_bits_32(x as u32);
    let y_spread = spread_bits_32(y as u32);
    (x_spread << 1) | y_spread
}

/// 🚀 1本の独立したアーク（線分）を一気呵成にデコードするピュア関数
pub fn decode_single_arc(
    buffer: &[u8],
    mut pos: usize,
    end: usize,
    count: Option<usize>,
    is_poly: bool,
) -> (Vec<u64>, usize) {
    let capacity = match count {
        Some(n) => n + if is_poly { 1 } else { 0 },
        None => (end - pos) / 2 + 1,
    };
    let mut gint_vec = Vec::with_capacity(capacity);
    let mut px: i32 = 0;
    let mut py: i32 = 0;
    let mut is_first = true;
    let mut first_val = 0u64;

    if let Some(mut n) = count {
        while n > 0 && pos < end {
            px += read_svarint(buffer, &mut pos);
            py += read_svarint(buffer, &mut pos);
            let val = pack_gint_morton(px, py);
            if is_first {
                first_val = val;
                is_first = false;
            }
            gint_vec.push(val);
            n -= 1;
        }
    } else {
        while pos < end {
            px += read_svarint(buffer, &mut pos);
            py += read_svarint(buffer, &mut pos);
            let val = pack_gint_morton(px, py);
            if is_first {
                first_val = val;
                is_first = false;
            }
            gint_vec.push(val);
        }
    }

    // GeoPBF仕様：ポリゴンの削られた末尾1点を完全に復元して閉じる
    if is_poly && !is_first {
        gint_vec.push(first_val);
    }

    gint_vec.shrink_to_fit();
    (gint_vec, pos)
}