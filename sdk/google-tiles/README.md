# @ortho-earth/google-tiles

Google Photorealistic 3D Tiles for [`@ortho-earth/globe`](../../packages/globe). The globe already streams any 3D Tiles tileset (`map.add3DTiles`) and lets a tileset rewrite each of its requests (`requestTransform`). This package adds the Google-specific part on top of that:

- **API key.** Every request to `tile.googleapis.com` gets `key=…`. Requests to any other host are returned untouched, so the key is not sent elsewhere.
- **Session token.** Google puts `session=…` in the child tileset URIs. The content URIs inside those child tilesets are relative and come without it. The transform remembers the token and adds it to later requests that lack one.
- **Attribution.** "Google" first, then the data providers of the tiles on screen (glTF `asset.copyright`, split on `;`, most frequent first), shown in the globe's attribution panel and removed with the tileset.

```js
import { createGlobe } from "@ortho-earth/globe";
import { addGoogle3DTiles, googleTilesPlugin } from "@ortho-earth/google-tiles";

const map = await createGlobe({ target: "#map", view: "#16.6/35.6812/139.7671/45t" });
const tiles = await addGoogle3DTiles(map, { key: MY_MAP_TILES_API_KEY });   // root: GOOGLE_3D_TILES_ROOT, id "google-3d", maxSSE 16
tiles.copyrights;                                                         // ["Google", "Airbus", …] as tiles stream in
tiles.remove();

// plugin form
map.use(googleTilesPlugin({ key: MY_MAP_TILES_API_KEY }));
await map.gadget.googleTiles({ fit: false });
map.supports("gadget.googleTiles");                                       // true ("plugin", via "google-tiles")
```

- **Keep the key in your app.** Pass it at run time (from your own config or server). This package does not store, log or bundle it, and the repository has no key in it. Restrict the key to your origins in the Google Cloud console.
- **Low-level pieces.** `googleRequestTransform({ key, session?, hosts? })` is a plain `requestTransform` (with a read-only `.session`), and `googleAttribution(copyrights)` builds the text. Use them with `map.add3DTiles(root, { requestTransform, attribution })` if you need other options.
- **Other tileset options** (`maxSSE`, `maxMemoryMB`, `pickable`, …) pass through `addGoogle3DTiles(map, { key, ...opts })` to `add3DTiles`.
- **Terms.** Google's Map Tiles API terms apply to your use of the data, including how the attribution is shown.

Tests: `npm test -w @ortho-earth/google-tiles` (node: key only on allowed hosts, session carried, attribution text, plugin shape) and, in `packages/globe`, `npm run verify:ui -- t-googletiles` (a fake Google tree in `tests/fixtures/google` served locally: key on every request, session carried to the relative content, attribution in the panel and removed with the tileset, plugin form). Real data needs your own key and is checked by hand.
