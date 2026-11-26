# The Earth Is Round: 3-minute demo video storyboard

For the UN Open GIS Initiative Monthly (2026-12-09, 23:00 JST). The 11-slide story compressed to 3 minutes. No audio: English on-screen captions carry it, so it works played during the talk or shared on its own.

Colours and type match the slides (ink #0E1A2B, paper #F4F1EA, orange #E8743B; Space Grotesk + Inter).

| Time | Scene | Slides | Picture | Captions |
|---|---|---|---|---|
| 0:00–0:10 | Opening | 1 Cover | Rotating globe, "The Earth is round." | (none) |
| 0:10–0:28 | 2005 | 2, 3 | Web Mercator world map; the 256 px tile grid grows z0 → z3. "2005", then "2026 · still the default" | 2005: the web map is cut into 256-pixel squares… / A brilliant compromise… / Twenty years later, the compromise is still the default. |
| 0:28–0:50 | Area | 4 | Africa (orange) and Greenland (blue) on Mercator → morph to Equal Earth → "14×" → UN GA "164 – 1" card | On Web Mercator, Greenland looks about as big as Africa. / On Equal Earth… about 14 times larger. |
| 0:50–1:22 | **Live** One model | 5, 7 | One continuous flyTo from orbit to Tokyo Station (PLATEAU), then a slow orbit | A tilted Mercator plane is… / one model, a round Earth, from orbit… / …down to the street… |
| 1:22–1:42 | **Live** Earthquakes | 6, 8 | 1.5 M earthquakes; tilt toward the Japan Trench to show hypocentre depth | 1.5 million earthquakes… / Computed on the device's GPU… |
| 1:42–1:57 | **Live** Satellites | 6, 8 | Wide view of ~16,000 satellites | About 16,000 satellites… |
| 1:57–2:27 | **Live** Offline | 7, 8 | Choose an area on the Equal Earth map → save → network off → globe and search still work | For field sites with no network… / The device saves… / Then go offline… |
| 2:27–2:45 | **Live** Compatibility | 9 | MapLibre gallery and Sandcastle | Your MapLibre and CesiumJS code runs unchanged. / 137 … 91/43/3/0 … 304 … 264/40 |
| 2:45–2:51 | Formula | 9 | MapLibre × Cesium − ~~Mercator~~ + α | (α = Equal Earth · real 3D · analysis on the device · offline) |
| 2:51–3:00 | Close | 10, 11 | Use it · Shape it · Build it / The Earth is round. Our maps can be, too. / URLs | (none) |

Scenes with a world map (2005, Area, Offline) carry the same UN boundary disclaimer as slide 8, bottom right.

## How the live shots are recorded (5 shots, about 2 minutes)

1920×1080, no browser chrome or tabs in frame. Each shot runs 1–2 s longer than its captions.

1. **One model (32 s)** Open `/japan/` on the whole globe and descend in one continuous move to Tokyo Station `#16/35.6812/139.7671/60t/30r`. Last 10 s: slow orbit.
2. **Earthquakes (20 s)** `/globe/quakes/`: from the whole Pacific to the Japan Trench, tilted to show depth.
3. **Satellites (15 s)** `/globe/sats`: pull back to show the whole shell of satellites.
4. **Offline (30 s)** Choose an area on Equal Earth → save (progress bar) → turn Wi-Fi off (the menu-bar Wi-Fi icon in frame helps) → reload → search a place name and fly there.
5. **Compatibility (18 s)** `/maplibre/`: open 2–3 examples showing score and Run → a few seconds of `/sandcastle/`.

Shots 1, 2, 3 and 5 are recorded automatically on the Mac mini (Chrome, real GPU). Shot 4 has many steps, so recording it by hand is the safest.
