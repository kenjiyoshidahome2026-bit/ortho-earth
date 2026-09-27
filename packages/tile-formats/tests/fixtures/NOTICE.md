# Test fixtures — provenance and licenses

These files are test inputs only; none of them ship in the package (`files` in package.json excludes `tests/`).

| Directory | Source | License |
|---|---|---|
| `synthetic/` | [maplibre/maplibre-tile-spec](https://github.com/maplibre/maplibre-tile-spec) `test/synthetic/0x01/` (Java reference encoder output + the expected logical JSON) | Apache-2.0 (the spec repository) |
| `simple/` | maplibre-tile-spec `test/fixtures/simple/*.mvt` and `test/expected/0x01/simple/*.mlt` (hand crafted by Dane Springmeyer, 2024) | CC0 1.0 (see `simple/LICENSE`) |
| `omt/` | maplibre-tile-spec `test/fixtures/omt/0_0_0.mvt` (OpenMapTiles z0 tile) and `test/expected/0x01/omt/0_0_0.mlt` (the same tile written by the Java reference encoder) | data © OpenStreetMap contributors, ODbL 1.0; schema © OpenMapTiles (BSD 3-Clause) |

The `omt/` pair is what makes the equivalence check honest: a real tile, encoded by a different encoder than the one in this repository, with FSST/shared-dictionary string columns, pre-tessellated polygon layers and 64-bit ids.
