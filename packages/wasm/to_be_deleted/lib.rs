// packages/wasm/src/lib.rs

mod l1_to_l2;
use wasm_bindgen::prelude::*;

// 【永続共通バッファ】使い回し用の巨大領域
static mut SHARED_GINT_BUFFER: Vec<u64> = Vec::new();

#[wasm_bindgen]
pub fn init_shared_buffer() -> *mut u64 {
    unsafe {
        // 🌟 2回目以降の呼び出しではメモリ確保をスキップし、既存のポインタを返す安全設計
        if SHARED_GINT_BUFFER.is_empty() {
            SHARED_GINT_BUFFER = vec![0u64; 524288]; // 4MB (u64で約50万頂点分)
        }
        SHARED_GINT_BUFFER.as_mut_ptr()
    }
}

// --- 既存のメモリ管理窓口（傑作ロジック等に必要なためすべて完全保持） ---
#[wasm_bindgen]
pub fn allocate_u8_buffer(len: usize) -> *mut u8 {
    let mut buf = vec![0u8; len]; let ptr = buf.as_mut_ptr(); std::mem::forget(buf); ptr
}
#[wasm_bindgen]
pub fn free_u8_buffer(ptr: *mut u8, len: usize) {
    unsafe { let _ = Vec::from_raw_parts(ptr, len, len); }
}
#[wasm_bindgen]
pub fn allocate_u32_buffer(len: usize) -> *mut u32 {
    let mut buf = vec![0u32; len]; let ptr = buf.as_mut_ptr(); std::mem::forget(buf); ptr
}
#[wasm_bindgen]
pub fn free_u32_buffer(ptr: *mut u32, len: usize) {
    unsafe { let _ = Vec::from_raw_parts(ptr, len, len); }
}
#[wasm_bindgen]
pub fn allocate_u64_buffer(len: usize) -> *mut u64 {
    let mut buf = vec![0u64; len]; let ptr = buf.as_mut_ptr(); std::mem::forget(buf); ptr
}
#[wasm_bindgen]
pub fn free_u64_buffer(ptr: *mut u64, len: usize) {
    unsafe { let _ = Vec::from_raw_parts(ptr, len, len); }
}

// --- 傑作ロジック（完全保持） ---
#[wasm_bindgen]
pub fn bulk_l1_to_l2_wasm(buffer_ptr: *mut u64, meta_ptr: *const u32, arc_count: usize, mlen: usize) {
    l1_to_l2::execute(buffer_ptr, meta_ptr, arc_count, mlen);
}

// --- 最速モートンエンコード ---
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

#[wasm_bindgen]
pub fn pack_gint_morton(x: i32, y: i32) -> u64 {
    let x_spread = spread_bits_32(x as u32);
    let y_spread = spread_bits_32(y as u32);
    (y_spread << 1) | x_spread
}

/// 🚀 【解決の鍵】実行時にWASMインスタンスの生メモリ（memory）を安全にJSへ引き渡す公式ルート
#[wasm_bindgen]
pub fn get_wasm_memory() -> JsValue {
    wasm_bindgen::memory()
}