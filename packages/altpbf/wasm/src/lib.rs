// altpbf の標高（packed SVarint の差分）→ 累積の Int16。src/svarint.ts の JS 版と同じ値を出す。
//   入力は JS が IN へ写した塊（既定 1 MiB）。塊の途中で varint が切れないよう、最後の塊でなければ「残り 5 バイト以上」の所までだけ読む。
//   値は 32bit の zigzag（(v>>1)^-(v&1)）・累積は wrapping（Int16 への格納は 2^16 を法に JS の double の累積と同じ値）。
//   32 bit を超える varint・最後の塊で len を越えて読む入力は −1（JS が Pbf の読みでやり直す＝値も例外も今までどおり）。
//   SIMD128 版（target-feature=+simd128 で焼いた方）は「16 バイト続けて 1 バイトの varint」を i16x8 の prefix sum で 16 値ずつ進める。
#![no_std]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! { core::arch::wasm32::unreachable() }
#[cfg(target_feature = "simd128")]
use core::arch::wasm32::*;

static mut POS: u32 = 0;
static mut SUM: i32 = 0;
/// 直前の sv_run が読み終えた位置（塊の先頭から）
#[no_mangle] pub extern "C" fn sv_pos() -> u32 { unsafe { POS } }
/// 直前の sv_run の終わりの累積（次の塊へ持ち越す）
#[no_mangle] pub extern "C" fn sv_sum() -> i32 { unsafe { SUM } }

#[inline(always)]
unsafe fn one(p: *const u8, pos: &mut usize) -> Option<i32> {
	let mut b = *p.add(*pos) as u32; *pos += 1; let mut v = b & 0x7f;
	if b & 0x80 != 0 { b = *p.add(*pos) as u32; *pos += 1; v |= (b & 0x7f) << 7;
		if b & 0x80 != 0 { b = *p.add(*pos) as u32; *pos += 1; v |= (b & 0x7f) << 14;
			if b & 0x80 != 0 { b = *p.add(*pos) as u32; *pos += 1; v |= (b & 0x7f) << 21;
				if b & 0x80 != 0 { b = *p.add(*pos) as u32; *pos += 1; v |= (b & 0x0f) << 28; if b & 0xf0 != 0 { return None; } } } } }
	Some(((v >> 1) as i32) ^ -((v & 1) as i32))
}

#[cfg(target_feature = "simd128")]
#[inline(always)]
unsafe fn psum(x: v128) -> v128 {   // i16x8 の累積（左から）
	let z = i16x8_splat(0);
	let x = i16x8_add(x, i16x8_shuffle::<8, 0, 1, 2, 3, 4, 5, 6>(x, z));
	let x = i16x8_add(x, i16x8_shuffle::<8, 8, 0, 1, 2, 3, 4, 5>(x, z));
	i16x8_add(x, i16x8_shuffle::<8, 8, 8, 8, 0, 1, 2, 3>(x, z))
}

/// inp[0..len) を読み out へ書く。last＝最後の塊・sum＝前の塊からの累積。戻り＝書いた値の数（−1＝JS の Pbf の読みに任せる）
#[no_mangle]
pub unsafe extern "C" fn sv_run(inp: *const u8, len: u32, out: *mut i16, last: u32, sum: i32) -> i32 {
	let len = len as usize;
	let stop = if last != 0 { len } else { len.saturating_sub(4) };   // 最後でなければ「5 バイト読める所」まで＝varint は塊の中で必ず閉じる
	let (mut pos, mut i, mut sum) = (0usize, 0usize, sum);
	while pos < stop {
		#[cfg(target_feature = "simd128")]
		if pos + 16 <= len {
			let c = v128_load(inp.add(pos) as *const v128);
			if i8x16_bitmask(c) == 0 {   // 16 値とも 1 バイト
				let d = v128_xor(u8x16_shr(c, 1), i8x16_neg(v128_and(c, i8x16_splat(1))));
				let lo = i16x8_add(psum(i16x8_extend_low_i8x16(d)), i16x8_splat(sum as i16));
				let hi = i16x8_add(psum(i16x8_extend_high_i8x16(d)), i16x8_splat(i16x8_extract_lane::<7>(lo)));
				v128_store(out.add(i) as *mut v128, lo);
				v128_store(out.add(i + 8) as *mut v128, hi);
				sum = i16x8_extract_lane::<7>(hi) as i32;   // 累積は Int16 の幅で持てば足りる（格納が 2^16 を法）
				pos += 16; i += 16;
				continue;
			}
			// 2 バイト以上が混じる 16 バイト＝その 16 バイトを越えるまで 1 値ずつ（急な地形で毎値の検査が無駄にならないよう）
			let w = (pos + 16).min(stop);
			while pos < w {
				match one(inp, &mut pos) {
					Some(d) => { sum = sum.wrapping_add(d); *out.add(i) = sum as i16; i += 1; }
					None => return -1,
				}
			}
			continue;
		}
		match one(inp, &mut pos) {
			Some(d) => { sum = sum.wrapping_add(d); *out.add(i) = sum as i16; i += 1; }
			None => return -1,
		}
	}
	if pos > len { return -1; }
	POS = pos as u32; SUM = sum;
	i as i32
}
