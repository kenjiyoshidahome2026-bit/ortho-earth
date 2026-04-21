const layers = [
	["whiteEarth", "whiteEarth", null, 7, "Natural Earth", 
		{ ja: "白地図", en: "whiteEarth", zh: "白地图", ko: "흰색 지도" }],
	["google.street","naturalEarth", "google.streets", 22, "Natural Earth / ©︎ Google", 
		{ ja: "google:ストリート", en: "google:street", zh: "Google:街道", ko: "Google: 거리" }],
	["google.terrain","naturalEarth", "google.terrain", 22, "Natural Earth / ©︎ Google",
		{ ja: "google:テライン", en: "google:terrain", zh: "Google:地形", ko: "Google: 지형" }],
	["google.satellite","google.satellite", "google.satellite", 22, "©︎ Google",
		{ ja: "google:航空写真", en: "google:satellite", zh: "Google:卫星", ko: "Google: 위성" }],
	["google.hybrid","google.satellite", "google.hybrid", 22, "©︎ Google", 
		{ ja: "google:ハイブリッド", en: "google:hybrid", zh: "Google:混合", ko: "Google: 하이브리드" }],
	["osm.street", "naturalEarth", "osm.street", 19, "Natural Earth / ©︎ OpenStreetMap contributors",
		{ ja: "OSM:ストリート", en: "OSM:street", zh: "OSM:街道", ko: "OSM: 거리" }],
	["osm.satellite", "osm.satellite", "osm.satellite", 19, "© Microsoft",
		{ ja: "OSM:航空写真", en: "OSM:satellite", zh: "OSM:卫星", ko: "OSM: 위성" }],
	["cyberjapan.std", "naturalEarth", "cyberjapan.std", 19, "Natural Earth / ©︎ 国土地理院",
		{ ja: "国土地理院:標準地図", en: "GIAJ:standard", zh: "国土地理院:标准", ko: "국토지리원: 표준" }],
	["cyberjapan.pale", "naturalEarth", "cyberjapan.pale", 19, "Natural Earth / ©︎ 国土地理院",
		{ ja: "国土地理院:淡色地図", en: "GIAJ:pale", zh: "国土地理院:淡色", ko: "국토지리원: 연한색" }]
];
const tileURL = function (type) {
	if (!type) return null;
	let count = 0;
	const index = ([x, y, z]) => {
		let s = "";
		for (let i = z - 1; i >= 0; i--) s += ((y >> i & 1) << 1 | (x >> i & 1));
		return s || "0";
	};
	const osm0 = ([x, y, z]) => `https://tile.openstreetmap.jp/${z}/${x}/${y}.png`;
	const bing = t => `https://tiler.ortho-earth.com/bing/${index(t)}`;
	const osm = type => type == "satellite" ? bing : osm0;
	const cyberjapan = type => {
		const { PI, cos, tan, log } = Math;
		const xmin = (122 + 180) / 360;
		const xmax = (154 + 180) / 360;
		const ymin = (1 - log(tan(46 * PI / 180) + 1 / cos(46 * PI / 180)) / PI) / 2;
		const ymax = (1 - log(tan(20 * PI / 180) + 1 / cos(20 * PI / 180)) / PI) / 2;
		return ([x, y, z]) => {
			const n = 1 << z;
			return (z < 5 || x < xmin * n || x > xmax * n || y < ymin * n || y > ymax * n) ?
				osm0([x, y, z]) : `https://cyberjapandata.gsi.go.jp/xyz/${type}/${z}/${x}/${y}.png`;
		};
	};
	const google = type => {
		const s = ({ streets: "m", satellite: "s", hybrid: "s,h", terrain: "p" })[type];
		return ([x, y, z]) => `https://mt${(count++) % 4}.google.com/vt/lyrs=${s}&x=${x}&y=${y}&z=${z}`;
	};
	type = type.split(".");
	return ({ cyberjapan, osm, google })[type[0]](type[1]);
}; 
	
export const layerList = {};
layers.map(([name, base, tile, maxZoom, attr, trans])=> {
	layerList[name] = {
		base:base+".webp",
		tile: tileURL(tile),
		maxZoom, 
		attr: "orthoEarth / " + attr,
		trans:lang=>trans[lang]
	};
});
