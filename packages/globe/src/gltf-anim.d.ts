// gltf-anim.js（JS のまま）の型。gadgets の model が読む分だけ（TS 化 段 4・batch 2）＝gltf-anim.js が TS になれば消える。

/** rig（worker の rigFromGltf）＝ノードの親子・静止の TRS・アニメの channel の数列（中身は gltf-anim.js だけが読む） */
export interface GltfRig { nodes: unknown[]; animations: unknown[] }
/** place＝glTF のローカル → ECEF（G）と、ECEF → 世界座標の局所線形化（F） */
export interface GltfPlace { G: { A: ArrayLike<number>; T: ArrayLike<number> }; F: { L: ArrayLike<number>; t: ArrayLike<number> } }
/** 全ノードの world 行列（アニメ後 W と静止 W0） */
export interface GltfPose { W: ArrayLike<number>[]; W0: ArrayLike<number>[] }
/** 世界座標の affine（L＝3x3 列優先・t＝平行移動） */
export interface WorldXf { L: Float64Array; t: number[] }
/** 再生の時刻 → アニメの時刻（loop＝duration で畳む・それ以外は端で留める） */
export function wrapTime(time: number, duration: number, loop: boolean): number;
export function samplePose(rig: GltfRig, animIndex: number, time: number): GltfPose | null;
export function worldXf(pose: GltfPose, node: number, place: GltfPlace): WorldXf | null;
/** renderer に渡す 12 個（L 9＋原点相対の平行移動 3）。xf が無ければ null */
export function batchXf(xf: WorldXf | null, origin: ArrayLike<number> | null | undefined): Float32Array | null;
