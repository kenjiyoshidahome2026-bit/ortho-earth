# ortho-solar

A real-scale, heliocentric 3D Solar System: planets, the Moon and Pluto on their true orbits (`@ortho-earth/ephem`),
eclipse and ring shadows, time scrubbing by year / day / hour. WebGL2, no libraries, no server.
Served at `www.ortho-earth.com/solar/`; `/japan/` opens it from the "Solar System" gadget at low zoom.

| | |
|---|---|
| URL | `/solar/` — `?lang=`, `?back=<same-origin URL>` (shows a "Back" button), `#` view hash |
| Languages | 26 (`i18n/ui.json` → `i18n/lang/<code>.json`); no language selector yet (use `?lang=`) |
| Data | textures in `public/tex/` (NASA/JPL, see the in-app credits) |
| Head | English `<head>` with share card (`public/ogp.jpg`, taken by `npm run og`), canonical, theme-color |

## Develop

```
npm run dev -w solar              # http://localhost:5199/solar/
npm test -w solar                 # verify:i18n + ephem tests
npm run i18n:build -w solar
```

License: GPL-3.0-or-later.
