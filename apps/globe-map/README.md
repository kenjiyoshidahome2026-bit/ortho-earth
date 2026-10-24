# globe-map

The globe's front page, **Globe ⇄ Equal Earth**, at `www.ortho-earth.com/globe/` (`?start=equal` opens on the Equal Earth side).
A globe without Japan data (up to z8, the world data's range) with the same world content as Equal Earth: borders, states, lakes, rivers, roads, rail, cities and names in 26 languages.
Right-click a point to open Equal Earth centred there.

It has no Worker of its own. Its output (`dist/site/globe/`) is gathered and served by [`apps/globe-host`](../globe-host) (Worker `ortho-globe`), like every other `/globe/` app.

```
npm run dev -w globe-map            # http://localhost:5186/globe/
npm run build -w globe-map          # i18n gate, then vite build
npm run verify:i18n -w globe-map
```

License: GPL-3.0-or-later.
