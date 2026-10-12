// 検定用の three.js モジュール（t-three.html）＝params.boxes の箱を置く。three は setup の引数で受ける（bare import しない＝利用者のモジュールの作法）。
let group = null;
export function setup(THREE, scene, h) {
	group = new THREE.Group(); scene.add(group);
	for (const b of h.params?.boxes || []) {
		const m = new THREE.Mesh(new THREE.BoxGeometry(b.size, b.size, b.size), new THREE.MeshBasicMaterial({ color: b.color }));   // 無灯＝色がそのまま出る（検定で画素を読む）
		m.position.copy(h.lnglatToLocal(b.lon, b.lat, b.h)); m.name = b.name; m.userData = { size: b.size };
		group.add(m);
	}
	// ENU の向きの確かめ＝原点から東 1km・北 1km・上 1km の点を localToLnglat で戻す
	const e = h.localToLnglat(new THREE.Vector3(1000, 0, 0)), n = h.localToLnglat(new THREE.Vector3(0, 1000, 0)), u = h.localToLnglat(new THREE.Vector3(0, 0, 1000));
	h.post({ type: "setup", n: group.children.length, east: e, north: n, up: u, origin: h.origin });
}
export function onMessage(d, h) {
	if (d?.type === "move") { const m = group.getObjectByName(d.name); if (m) m.position.copy(h.lnglatToLocal(d.lon, d.lat, d.h)); }
	else if (d?.type === "spin") spin = !!d.on;
}
let spin = false;
export function update(dt) { if (spin) group.rotation.z += dt; return spin; }
