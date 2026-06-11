#[wasm_bindgen]
impl GintConverter {
    pub fn identify_polygon(&self, mix: i32, miy: i32, error: i32) -> i32 {
        let err_sq = (error as i64) * (error as i64);
        let x_min = (mix - error).max(0);
        let x_max = mix + error;
        let y_min = (miy - error).max(0);
        let y_max = miy + error;

        let x_mid = if ((x_min ^ x_max) & (1 << 31)) != 0 {
            Some(x_max & !((1 << (31 - (x_min ^ x_max).leading_zeros())) - 1))
        } else { None };

        let y_mid = if ((y_min ^ y_max) & (1 << 31)) != 0 {
            Some(y_max & !((1 << (31 - (y_min ^ y_max).leading_zeros())) - 1))
        } else { None };

        let sub_quads = [
            Some((x_min, x_mid.map_or(x_max, |m| m - 1), y_min, y_mid.map_or(y_max, |m| m - 1))),
            x_mid.map(|m| (m, x_max, y_min, y_mid.map_or(y_max, |m| m - 1))),
            y_mid.map(|m| (x_min, x_mid.map_or(x_max, |m| m - 1), m, y_max)),
            if x_mid.is_some() && y_mid.is_some() { Some((x_mid.unwrap(), x_max, y_mid.unwrap(), y_max)) } else { None }
        ];

        let mut hit_arcs = Vec::with_capacity(32);

        for quad in sub_quads.iter().flatten() {
            let q_min = self.pack_from_int(quad.0, quad.2) & !0x3F;
            let q_max = self.pack_from_int(quad.1, quad.3) | 0x3F;

            let start_idx = match self.coordinate_stream.binary_search_by(|&m| (m & !0x3F).cmp(&q_min)) {
                Ok(idx) => idx,
                Err(idx) => idx,
            };

            for i in start_idx..self.coordinate_stream.len() {
                let m = self.coordinate_stream[i];
                if (m & !0x3F) > q_max { break; }

                let (ix, iy) = self.unpack_to_int(m);
                if ix >= x_min && ix <= x_max && iy >= y_min && iy <= y_max {
                    let dx = (ix - mix) as i64;
                    let dy = (iy - miy) as i64;
                    if dx * dx + dy * dy <= err_sq {
                        if let Some(aid) = self.find_arc_id_by_index(i as u32) {
                            hit_arcs.push(aid);
                        }
                    }
                }
            }
        }

        if hit_arcs.is_empty() { return -1; }

        self.find_feature_id_by_arcs(&hit_arcs)
    }

    fn pack_from_int(&self, x: i32, y: i32) -> u64 {
        ((x as u64) << 32) | ((y as u64) & 0xFFFFFFFF)
    }

    fn unpack_to_int(&self, m: u64) -> (i32, i32) {
        ((m >> 32) as i32, (m & 0xFFFFFFFF) as i32)
    }

    fn find_arc_id_by_index(&self, idx: u32) -> Option<u32> {
        let mut low = 0;
        let mut high = (self.arc_meta_stream.len() / 8) - 1;
        while low <= high {
            let mid = (low + high) >> 1;
            let off = self.arc_meta_stream[mid * 8];
            let len = self.arc_meta_stream[mid * 8 + 1];
            if idx >= off && idx < off + len { return Some(mid as u32); }
            if off > idx { high = mid - 1; } else { low = mid + 1; }
        }
        None
    }

    fn find_feature_id_by_arcs(&self, hit_arcs: &[u32]) -> i32 {
        let mut pos = 0;
        while pos < self.feature_index_stream.len() {
            let feat_id = self.feature_index_stream[pos];
            let num_rings = self.feature_index_stream[pos + 1] as usize;
            pos += 2;
            for _ in 0..num_rings {
                let num_arcs = self.feature_index_stream[pos] as usize;
                pos += 1;
                for _ in 0..num_arcs {
                    let arc_idx = self.feature_index_stream[pos];
                    let aid = if arc_idx < 0 { !arc_idx } else { arc_idx } as u32;
                    if hit_arcs.contains(&aid) { return feat_id; }
                    pos += 1;
                }
            }
        }
        -1
    }

    pub fn identify_point(&self, mix: i32, miy: i32, error: i32) -> i32 {
        let err_sq = (error as i64) * (error as i64);
        let quads = self.compute_sub_quads(mix, miy, error);
        
        let x_min = (mix - error).max(0);
        let x_max = mix + error;
        let y_min = (miy - error).max(0);
        let y_max = miy + error;

        for quad in quads.iter().flatten() {
            let q_min = self.pack_from_int(quad.0, quad.2);
            let q_max = self.pack_from_int(quad.1, quad.3);

            let start_idx = match self.point_buffer.binary_search(&q_min) {
                Ok(idx) => idx,
                Err(idx) => idx,
            };

            for i in start_idx..self.point_buffer.len() {
                let m = self.point_buffer[i];
                if m > q_max { break; }

                let (ix, iy) = self.unpack_to_int(m);
                if ix >= x_min && ix <= x_max && iy >= y_min && iy <= y_max {
                    let dx = (ix - mix) as i64;
                    let dy = (iy - miy) as i64;
                    if dx * dx + dy * dy <= err_sq {
                        return self.point_meta_stream[i] as i32;
                    }
                }
            }
        }
        -1
    }

    pub fn identify_polyline(&self, mix: i32, miy: i32, error: i32) -> i32 {
        let err_sq = (error as i64) * (error as i64);
        let quads = self.compute_sub_quads(mix, miy, error);
        
        let x_min = (mix - error).max(0);
        let x_max = mix + error;
        let y_min = (miy - error).max(0);
        let y_max = miy + error;

        let mut hit_arcs = Vec::with_capacity(32);

        for quad in quads.iter().flatten() {
            let q_min = self.pack_from_int(quad.0, quad.2) & !0x3F;
            let q_max = self.pack_from_int(quad.1, quad.3) | 0x3F;

            let start_idx = match self.coordinate_stream.binary_search_by(|&m| (m & !0x3F).cmp(&q_min)) {
                Ok(idx) => idx,
                Err(idx) => idx,
            };

            for i in start_idx..self.coordinate_stream.len() {
                let m = self.coordinate_stream[i];
                if (m & !0x3F) > q_max { break; }

                let (ix, iy) = self.unpack_to_int(m);
                if ix >= x_min && ix <= x_max && iy >= y_min && iy <= y_max {
                    let dx = (ix - mix) as i64;
                    let dy = (iy - miy) as i64;
                    if dx * dx + dy * dy <= err_sq {
                        if let Some(aid) = self.find_arc_id_by_index(i as u32) {
                            hit_arcs.push(aid);
                        }
                    }
                }
            }
        }

        if hit_arcs.is_empty() { return -1; }

        self.find_polyline_id_by_arcs(&hit_arcs)
    }

    fn compute_sub_quads(&self, mix: i32, miy: i32, error: i32) -> [Option<(i32, i32, i32, i32)>; 4] {
        let x_min = (mix - error).max(0);
        let x_max = mix + error;
        let y_min = (miy - error).max(0);
        let y_max = miy + error;

        let x_mid = if ((x_min ^ x_max) & (1 << 31)) != 0 {
            Some(x_max & !((1 << (31 - (x_min ^ x_max).leading_zeros())) - 1))
        } else { None };

        let y_mid = if ((y_min ^ y_max) & (1 << 31)) != 0 {
            Some(y_max & !((1 << (31 - (y_min ^ y_max).leading_zeros())) - 1))
        } else { None };

        [
            Some((x_min, x_mid.map_or(x_max, |m| m - 1), y_min, y_mid.map_or(y_max, |m| m - 1))),
            x_mid.map(|m| (m, x_max, y_min, y_mid.map_or(y_max, |m| m - 1))),
            y_mid.map(|m| (x_min, x_mid.map_or(x_max, |m| m - 1), m, y_max)),
            if x_mid.is_some() && y_mid.is_some() { Some((x_mid.unwrap(), x_max, y_mid.unwrap(), y_max)) } else { None }
        ]
    }

    fn find_polyline_id_by_arcs(&self, hit_arcs: &[u32]) -> i32 {
        let mut pos = 0;
        while pos < self.polyline_index_stream.len() {
            let feat_id = self.polyline_index_stream[pos];
            let num_lines = self.polyline_index_stream[pos + 1] as usize;
            pos += 2;
            for _ in 0..num_lines {
                let num_arcs = self.polyline_index_stream[pos] as usize;
                pos += 1;
                for _ in 0..num_arcs {
                    let arc_idx = self.polyline_index_stream[pos];
                    let aid = if arc_idx < 0 { !arc_idx } else { arc_idx } as u32;
                    if hit_arcs.contains(&aid) { return feat_id; }
                    pos += 1;
                }
            }
        }
        -1
    }
}