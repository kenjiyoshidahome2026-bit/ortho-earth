> **English** · [日本語](Apps-and-URLs-ja)

# Apps and URLs

Every page under `apps/*` is a shell over the packages. All URLs are on `https://www.ortho-earth.com`.

## Served by the `/globe/` host (`apps/globe-host`, Worker `ortho-globe`)

| URL | App | What it shows |
|---|---|---|
| [/globe/](https://www.ortho-earth.com/globe/) | `apps/globe-map` | The world globe (Globe ⇄ Equal Earth) |
| [/globe/arcs](https://www.ortho-earth.com/globe/arcs) | `apps/arcs` | Great-circle arcs to every capital and world air routes |
| [/globe/clock](https://www.ortho-earth.com/globe/clock) | `apps/clock` | World clock: time zones on the globe |
| [/globe/clouds](https://www.ortho-earth.com/globe/clouds) | `apps/clouds` | Clouds now: geostationary infrared imagery |
| [/globe/hex](https://www.ortho-earth.com/globe/hex) | `apps/hex` | World population as H3 hexagon columns |
| [/globe/parks](https://www.ortho-earth.com/globe/parks) | `apps/parks-us` | The 63 US national parks |
| [/globe/physical](https://www.ortho-earth.com/globe/physical) | `apps/physical` | Landforms of the world |
| [/globe/sats](https://www.ortho-earth.com/globe/sats) | `apps/sats` | Every active satellite on its orbit |
| [/globe/splat](https://www.ortho-earth.com/globe/splat) | `apps/splat` | Gaussian splats on the globe |
| [/globe/voxel](https://www.ortho-earth.com/globe/voxel) | `apps/voxel` | Voxels: clouds, Mt Fuji in blocks, earthquake density |

## Served by the `/japan/` host (`apps/japan-host`, Worker `ortho-japan`)

| URL | App | What it shows |
|---|---|---|
| [/japan/](https://www.ortho-earth.com/japan/) | `apps/japan-map` | The flagship 3D map of Japan from public data (GSI, PLATEAU, JAXA) |
| [/japan/terrain](https://www.ortho-earth.com/japan/terrain) | `apps/terrain` | About 1,500 landforms of Japan |
| [/japan/parks](https://www.ortho-earth.com/japan/parks) | `apps/parks` | The 35 national parks of Japan |
| [/japan/models](https://www.ortho-earth.com/japan/models) | `apps/models` | Famous places as 3D models |
| [/japan/onsen](https://www.ortho-earth.com/japan/onsen) | `apps/onsen` | About 5,300 hot springs |
| [/japan/fireworks](https://www.ortho-earth.com/japan/fireworks) | `apps/fireworks` | Fireworks in the 3D scene |
| [/japan/pointcloud](https://www.ortho-earth.com/japan/pointcloud) | `apps/pointcloud` | Point clouds of Shizuoka and Atami (COPC) |
| [/japan/scene](https://www.ortho-earth.com/japan/scene) | `apps/scene` | Scenes editor: camera scripts exported as MP4 |
| [/japan/tellus](https://www.ortho-earth.com/japan/tellus) | `apps/tellus` | Tellus satellite data (PALSAR-2, AVNIR-2, GCOM) |
| [/japan/geoedit](https://www.ortho-earth.com/japan/geoedit) | `apps/geoedit-app` | Topological GeoPBF editor |

## Apps with their own Worker

| URL | App (Worker) | What it shows |
|---|---|---|
| [/globe/engine/](https://www.ortho-earth.com/globe/engine/current.json) | `apps/engine` (`ortho-engine`) | The shared engine, see [Architecture](Architecture) |
| [/globe/quakes/](https://www.ortho-earth.com/globe/quakes/) | `apps/quakes` (`ortho-quakes`) | World earthquakes since 1967 at true depth |
| [/japan/census2020/](https://www.ortho-earth.com/japan/census2020/) | `apps/census2020` | Japan's 2020 census, small areas and risk zones |
| [/yokohama/](https://www.ortho-earth.com/yokohama/) | `apps/yokohama` (`ortho-yokohama`) | Yokohama digital twin for citizens |
| [/equal/](https://www.ortho-earth.com/equal/) | `apps/equal` (`ortho-equal`) | Equal Earth world map |
| [/world/](https://www.ortho-earth.com/world/) | `apps/world` (`world`) | Countries and territories as cards |
| [/quiz/](https://www.ortho-earth.com/quiz/) | `apps/quiz` (`ortho-world-quiz`) | Geography quiz |
| [/solar/](https://www.ortho-earth.com/solar/) | `apps/solar` (`ortho-solar`) | Planets and moons over time |
| [/himekuri/](https://www.ortho-earth.com/himekuri/) | `apps/himekuri` (`ortho-himekuri`) | Daily calendar with sun and moon times |
| [/nl/](https://www.ortho-earth.com/nl/) | `apps/ortho-nl` (`ortho-nl`) | The Netherlands in 3D |
| /choju/ | `apps/choju` (`ortho-choju`) | Wildlife capture records on the 3D map (not listed on the top page) |
| /sokutei/ | `apps/sokutei` (`ortho-sokutei`) | PWA measuring captured animals from photos (not listed) |

## Built into the site (`apps/www`, Cloudflare Pages)

| URL | App | What it shows |
|---|---|---|
| [/](https://www.ortho-earth.com/) | `apps/www` | Top page and demo cards |
| [/maplibre/](https://www.ortho-earth.com/maplibre/) | `apps/www` | MapLibre example gallery with match scores |
| [/sandcastle/](https://www.ortho-earth.com/sandcastle/) | `apps/www` | Cesium Sandcastle gallery on `@ortho-earth/cesium` |
| [/docs/](https://www.ortho-earth.com/docs/) | `apps/docs` | Guides (from MapLibre, from Cesium, Equal Earth…) |
| [/geopbf/](https://www.ortho-earth.com/geopbf/) | `apps/geopbf-demo` | Convert GIS files in the browser |
| [/gishub-jp/](https://www.ortho-earth.com/gishub-jp/) | `apps/gishub-jp` | Japan's open GIS data: view and convert |

## Internal

`apps/uploader` (bakes data and uploads it to R2), `apps/account` (sign-in and per-user storage at `/auth`, `/me`), `apps/quakes-mirror` and `apps/sats-mirror` (mirror the USGS and CelesTrak feeds).
