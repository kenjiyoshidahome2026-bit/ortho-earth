// 生成物（scripts/mlspec-gen.mjs・手で書き換えない）＝MapLibre style-spec 26.4.4 の v8.json の写し：層の型ごとの layout／paint の性質の名前・source の型・root と層の鍵。
// 入口の検査（mlstyle.ts の validateMLStyle）と網羅表（globe scripts/ml-coverage.mjs）が読む
export const ML_SPEC_VERSION = "26.4.4";
export const ML_LAYER_PROPS: Record<string, { layout: string[]; paint: string[] }> = {
	"fill": {
		"layout": [
			"fill-sort-key",
			"visibility"
		],
		"paint": [
			"fill-antialias",
			"fill-opacity",
			"fill-layer-opacity",
			"fill-color",
			"fill-outline-color",
			"fill-translate",
			"fill-translate-anchor",
			"fill-pattern"
		]
	},
	"line": {
		"layout": [
			"line-cap",
			"line-join",
			"line-miter-limit",
			"line-round-limit",
			"line-sort-key",
			"visibility"
		],
		"paint": [
			"line-opacity",
			"line-layer-opacity",
			"line-color",
			"line-translate",
			"line-translate-anchor",
			"line-width",
			"line-gap-width",
			"line-offset",
			"line-blur",
			"line-dasharray",
			"line-pattern",
			"line-gradient"
		]
	},
	"symbol": {
		"layout": [
			"symbol-placement",
			"symbol-spacing",
			"symbol-avoid-edges",
			"symbol-sort-key",
			"symbol-z-order",
			"icon-allow-overlap",
			"icon-overlap",
			"icon-ignore-placement",
			"icon-optional",
			"icon-rotation-alignment",
			"icon-size",
			"icon-text-fit",
			"icon-text-fit-padding",
			"icon-image",
			"icon-rotate",
			"icon-padding",
			"icon-keep-upright",
			"icon-offset",
			"icon-anchor",
			"icon-pitch-alignment",
			"text-pitch-alignment",
			"text-rotation-alignment",
			"text-field",
			"text-font",
			"text-size",
			"text-max-width",
			"text-line-height",
			"text-letter-spacing",
			"text-justify",
			"text-radial-offset",
			"text-variable-anchor",
			"text-variable-anchor-offset",
			"text-anchor",
			"text-max-angle",
			"text-writing-mode",
			"text-rotate",
			"text-padding",
			"text-keep-upright",
			"text-transform",
			"text-offset",
			"text-allow-overlap",
			"text-overlap",
			"text-ignore-placement",
			"text-optional",
			"symbol-height-offset",
			"symbol-height-anchor",
			"visibility"
		],
		"paint": [
			"icon-opacity",
			"icon-color",
			"icon-halo-color",
			"icon-halo-width",
			"icon-halo-blur",
			"icon-translate",
			"icon-translate-anchor",
			"text-opacity",
			"text-color",
			"text-halo-color",
			"text-halo-width",
			"text-halo-blur",
			"text-translate",
			"text-translate-anchor"
		]
	},
	"circle": {
		"layout": [
			"circle-sort-key",
			"visibility"
		],
		"paint": [
			"circle-radius",
			"circle-color",
			"circle-blur",
			"circle-opacity",
			"circle-translate",
			"circle-translate-anchor",
			"circle-pitch-scale",
			"circle-pitch-alignment",
			"circle-stroke-width",
			"circle-stroke-color",
			"circle-stroke-opacity"
		]
	},
	"heatmap": {
		"layout": [
			"visibility"
		],
		"paint": [
			"heatmap-radius",
			"heatmap-weight",
			"heatmap-intensity",
			"heatmap-color",
			"heatmap-opacity"
		]
	},
	"fill-extrusion": {
		"layout": [
			"visibility",
			"fill-extrusion-rounded-corner-distance"
		],
		"paint": [
			"fill-extrusion-opacity",
			"fill-extrusion-color",
			"fill-extrusion-translate",
			"fill-extrusion-translate-anchor",
			"fill-extrusion-pattern",
			"fill-extrusion-height",
			"fill-extrusion-base",
			"fill-extrusion-vertical-gradient"
		]
	},
	"raster": {
		"layout": [
			"visibility"
		],
		"paint": [
			"raster-opacity",
			"raster-hue-rotate",
			"raster-brightness-min",
			"raster-brightness-max",
			"raster-saturation",
			"raster-contrast",
			"resampling",
			"raster-resampling",
			"raster-fade-duration"
		]
	},
	"hillshade": {
		"layout": [
			"visibility"
		],
		"paint": [
			"hillshade-illumination-direction",
			"hillshade-illumination-altitude",
			"hillshade-illumination-anchor",
			"hillshade-exaggeration",
			"hillshade-shadow-color",
			"hillshade-highlight-color",
			"hillshade-accent-color",
			"hillshade-method",
			"resampling"
		]
	},
	"color-relief": {
		"layout": [
			"visibility"
		],
		"paint": [
			"color-relief-opacity",
			"color-relief-color",
			"resampling"
		]
	},
	"background": {
		"layout": [
			"visibility"
		],
		"paint": [
			"background-color",
			"background-pattern",
			"background-opacity"
		]
	}
};
export const ML_SOURCE_TYPES: string[] = ["vector","raster","raster-dem","geojson","video","image"];
export const ML_ROOT_KEYS: string[] = ["version","name","metadata","center","centerAltitude","zoom","bearing","pitch","roll","state","light","sky","projection","terrain","sources","sprite","glyphs","font-faces","transition","layers"];
export const ML_LAYER_KEYS: string[] = ["id","type","metadata","source","source-layer","minzoom","maxzoom","filter","layout","paint"];
