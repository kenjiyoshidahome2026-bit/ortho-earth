# MapLibre expression tests — provenance

`tests.json` bundles every `test.json` under `test/integration/expression/tests/` of
[maplibre/maplibre-style-spec](https://github.com/maplibre/maplibre-style-spec) (version and commit are recorded in the file's `source`).
They are test inputs only and do not ship in the package. License: BSD 3-Clause, see `LICENSE.txt` (copied from that repository).

Refresh: `node scripts/ml-expression-fixtures.mjs <maplibre-style-spec checkout>`, then `node tests/ml-expression.mjs --update` and review the change in `tests/ml-expression-known.json`.
