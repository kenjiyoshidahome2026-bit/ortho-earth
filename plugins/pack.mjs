#!/usr/bin/env node
// プラグインを配布の形にする：plugins/dist/com.ortho-earth.unity-<v>.tgz（UPM の tarball）と OrthoEarth-unreal-<v>.zip（ソースのプラグイン）。
//   版は package.json（Unity）と OrthoEarth.uplugin の VersionName（Unreal）。tar と zip は OS の物（macOS・Linux に標準）。
//   実行：node plugins/pack.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)), dist = path.join(here, "dist");
fs.mkdirSync(dist, { recursive: true });

// Unity：tarball の中は package/ の下（npm pack と同じ形＝Unity が読む）
const upm = path.join(here, "unity", "com.ortho-earth.unity");
const uv = JSON.parse(fs.readFileSync(path.join(upm, "package.json"), "utf8")).version;
const tgz = path.join(dist, `com.ortho-earth.unity-${uv}.tgz`);
const rename = process.platform === "darwin" || process.platform === "freebsd" ? ["-s", ",^com.ortho-earth.unity,package,"] : ["--transform", "s,^com.ortho-earth.unity,package,"];   // bsdtar／GNU tar
execFileSync("tar", ["-czf", tgz, "-C", path.dirname(upm), ...rename, "com.ortho-earth.unity"], { stdio: "inherit", env: { ...process.env, COPYFILE_DISABLE: "1" } });

// Unreal：zip の中は OrthoEarth/（Binaries・Intermediate は入れない）
const ue = path.join(here, "unreal");
const vv = JSON.parse(fs.readFileSync(path.join(ue, "OrthoEarth", "OrthoEarth.uplugin"), "utf8")).VersionName;
const zip = path.join(dist, `OrthoEarth-unreal-${vv}.zip`);
fs.rmSync(zip, { force: true });
execFileSync("zip", ["-qr", zip, "OrthoEarth", "-x", "OrthoEarth/Binaries/*", "OrthoEarth/Intermediate/*", "*.DS_Store"], { cwd: ue, stdio: "inherit" });

for (const f of [tgz, zip]) console.log(path.relative(process.cwd(), f), `${(fs.statSync(f).size / 1024).toFixed(0)} KB`);
