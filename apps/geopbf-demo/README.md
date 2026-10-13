# geopbf-demo

The GeoPBF converter: drop a GIS file, check it on the globe, write it out in another format — 18 formats in, 14 out,
entirely in the browser (`packages/geopbf`). Served at `www.ortho-earth.com/geopbf/`.

| | |
|---|---|
| URL | `/geopbf/` — `?lang=`, `#` view hash once a file is on the globe |
| Languages | 26 (`i18n/ui.json`); language `<select>` in the header |
| Engine | `@ortho-earth/globe` (shared engine in production), globe UI forced to English |
| Head | English `<head>` with share card (`og:image` = www thumbnail), canonical, theme-color, pinch zoom allowed |

## Develop

```
npm run dev -w geopbf-demo        # http://localhost:5191/geopbf/
npm run verify:i18n -w geopbf-demo  # also runs inside build
```

License: GPL-3.0-or-later (the `geopbf` package itself is MIT).
