# @ortho-earth/react

React bindings for [`@ortho-earth/globe`](../globe). No JSX runtime is required by the package itself (it uses `createElement`), so it works with any React ≥ 18 setup.

```jsx
import { Globe, Source, Layer, Data, Marker, useGlobe, useGlobeEvent } from "@ortho-earth/react";

function App() {
	return (
		<Globe options={{ view: "#11/35.68/139.76", chips: false }} style={{ height: 480 }} onLoad={map => map.setSky({ type: "atmosphere" })}>
			<Source id="pts" type="geojson" data={fc}>
				<Layer id="pts-circle" type="circle" paint={{ "circle-color": "#f33", "circle-radius": 6 }} />
			</Source>
			<Data kind="arcs" data={flights} getSourcePosition={d => d.from} getTargetPosition={d => d.to} />
			<Marker lngLat={[139.7671, 35.6812]} draggable onDragEnd={e => console.log(e.lngLat)}>🗼</Marker>
			<Clicks />
		</Globe>
	);
}
function Clicks() { useGlobeEvent("click", e => console.log(e.lngLat)); return null; }
```

- `<Globe>` draws one `div`, calls `createGlobe({ ...options, target })` once on mount and `destroy()` on unmount. `options` is read once; drive the camera with `useGlobe().easeTo(...)`. `ref` is the map.
- `<Source>` / `<Layer>` mirror `addSource` / `addLayer`. Changed `paint` / `layout` keys go through `setPaintProperty` / `setLayoutProperty`; `filter`, `minzoom` / `maxzoom` are followed too; a change of `type` / `source` recreates the layer. A geojson source follows its `data` prop with `setData`.
- `<Data>` wraps `map.addData` (points / arcs / trips / polygons / paths / columns, or any kind a plugin registered). `data` → `setData`, accessors → `setProps`.
- `<Marker>` is the DOM marker (`map.Marker`); children are portalled into the marker element.
- `useGlobeEvent(type, handler, layerId?)` subscribes with `map.on` and unsubscribes on unmount; the handler is kept in a ref.

Tests: `npm test -w @ortho-earth/react` (node, pure functions and server rendering) and `npm run verify:ui -- t-react` in `packages/globe` (real React DOM against a real map).
