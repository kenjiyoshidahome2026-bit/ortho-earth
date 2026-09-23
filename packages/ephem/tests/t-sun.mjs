#!/usr/bin/env node
// 太陽直下点と恒星時（sun.js・#42）の常設ハーネス。期待値＝天文年鑑の値（赤緯）と均時差（経度）。
import { sunSubpoint, gmstAt } from "../src/sun.js";
const R = 180 / Math.PI;
let fails = 0;
const near = (a, b, tol, label) => { if (Math.abs(a - b) <= tol) return; fails++; console.error(`  ✗ ${label}: ${a.toFixed(3)} vs ${b}`); };
const at = s => sunSubpoint(Date.parse(s)).map(v => v * R);
near(gmstAt(Date.parse("2000-01-01T12:00:00Z")) * R, 280.4606, 1e-3, "GMST at J2000");
near(at("2026-06-21T12:00:00Z")[1], 23.44, 0.05, "June solstice declination");
near(at("2026-12-21T12:00:00Z")[1], -23.44, 0.05, "December solstice declination");
near(at("2026-03-20T12:00:00Z")[1], 0, 0.3, "March equinox declination");
near(at("2026-11-03T12:00:00Z")[0], -4.1, 0.15, "early November: equation of time +16.4 min = sun 4.1° west at 12:00 UTC");
near(at("2026-02-11T12:00:00Z")[0], 3.55, 0.15, "mid February: equation of time −14.2 min = sun 3.6° east");
near(at("2026-09-23T00:00:00Z")[0], 178.1, 0.15, "midnight UTC, late September: equation of time +7.5 min = 178.1° (near the antimeridian)");
console.log(fails ? `✗ sun: ${fails} failed` : "✓ sun: all passed");
process.exit(fails ? 1 : 0);
