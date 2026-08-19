# native-bucket.js (v1.0.0)

A high-performance bridge between **Cloudflare Edge (R2/Workers)** and **Browser Storage (IndexedDB)**. Optimized for handling heavy binary datasets (GIS, archives, large assets) with zero-latency interaction.

[![Cloudflare Workers](https://img.shields.io/badge/Powered_by-Cloudflare_Workers-F38020?logo=cloudflare-workers&logoColor=white)](https://dash.cloudflare.com/)
[![Vite](https://img.shields.io/badge/Build_with-Vite-646CFF?logo=vite&logoColor=white)](<https://vitejs.dev/>)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
![Size](https://img.shields.io/badge/Size-6.6KB-brightgreen.svg)

---

## 🏗 System Architecture

![Architecture](etc/architecture.png)
*Orchestration of data flow across Remote Servers, Edge Proxies, R2 Buckets, and Local Persistent Cache.*

---

## 🎮 **Demo** [👉 View Live Demo](https://kenjiyoshidahome2026-bit.github.io/native-bucket/demo/)

Experience the zero-latency data flow and surgical ZIP extraction in action.

---

## 🚀 Server-Side Setup ([Cloudflare Workers](https://dash.cloudflare.com))

### 1. Configuration (`wrangler.toml`)

(Sign-up and) deploy the backend to handle R2 operations and Proxy requests. The `index.js` automatically manages CORS for you.
Please edit the file: "wrangler.toml" under "worker" directory.

```toml
name = "native-bucket-api"
main = "index.js"
compatibility_date = "2026-04-01"

[[r2_buckets]]
# [DO NOT CHANGE] Internal binding for the library
binding = "MY_BUCKET"
# [REQUIRED] Your actual R2 bucket name
bucket_name = "my-r2-storage" # <=== change here

[vars]
# [WHITELIST] Comma-separated domains (Suffix matching supported)
# Example: "ortho-earth.com,localhost:5173" allows all subdomains of ortho-earth.
ALLOWED_DOMAINS = "ortho-earth.com,localhost:5173" # <=== change here
```

### 2. Deployment with bash in console

```bash
bash
cd workers
npx wrangler deploy
```

---

## 🛠 Client-Side Setup

### Option A: ESM (Modern Bundlers)

```javascript
import nativeBucket from './src/index.js';
```

### Option B: CDN / Global Script (The Easiest Way)

The library automatically attaches to `window.nativeBucket` (or `self.nativeBucket`) for non-ESM or direct HTML environments.

```html
<script type="module" src="https://cdn.jsdelivr.net/gh/kenjiyoshidahome2026-bit/native-bucket@main/dist/native-bucket.iife.js"></script>
<script>
  window.addEventListener('load', () => { // Access via global nativeBucket after page load
    const { Fetch, Bucket, Cache } = nativeBucket("https://your-worker.dev/");
    ...
   });
</script>
```

---

## 📖 Detailed API Reference

### Initialization

Register your Worker endpoint to unlock the three core modules.

```javascript
const { Fetch, Bucket, Cache } = nativeBucket("https://your-worker.workers.dev/");
```

### 🔒 Proxy access control

`/proxy` is a public endpoint, so forwarding is gated. A request passes if **either** gate opens:

1. **Target host is on the list** — `PROXY_ALLOWED_HOSTS` in `wrangler.toml` (dot-boundary suffix match: `gsi.go.jp` matches `maps.gsi.go.jp` but not `evilgsi.go.jp`). Open to anyone, `GET`/`HEAD` only.
2. **Caller is trusted** — request `Origin` is in `ALLOWED_DOMAINS`, or `X-API-Key` matches `API_KEY`. Any target host, any method.

Otherwise `403`. **If `PROXY_ALLOWED_HOSTS` is unset, only gate 2 opens** — a deployment with no configuration forwards nothing to anonymous callers.

```toml
[vars]
PROXY_ALLOWED_HOSTS = "e-stat.go.jp,nlftp.mlit.go.jp,naturalearth.s3.amazonaws.com"
```

Always enforced, even for trusted callers:

* `http:` / `https:` only — no `file:`, `data:`, etc.
* Loopback, private, link-local and cloud-metadata addresses are refused (SSRF).
* Self-reference is refused (amplification loop).
* Redirects are followed manually, **re-checked at every hop** (max 5), so an allow-listed host cannot bounce you to an arbitrary one.

Do not list user-content hosts (`raw.githubusercontent.com`, generic S3 domains) — that turns the proxy into an arbitrary-file laundering path. Reach those through gate 2 instead.

Run `npm run test:proxy` to verify the gate (29 cases, no deploy needed).

---

### 🌐 `Fetch(url, options)`

A smart proxy that bypasses CORS and can surgically extract specific files from remote ZIP archives.

| Parameter | Type | Description |
| :--- | :---: | :--- |
| `type` | String | Output format: `"file"` (Default), `"blob"`, `"json"`, `"text"`. |
| `cors` | Boolean | true/false: pre-flight check without this parameter |
| `target` | String | Path inside the ZIP to extract a specific file. |
| `encoding` | String | encoding (default:`"utf8"`) |
| `silent` | Boolean | if true then no progress log |
| `eventTarget` | dom | target of event (default: window or self[webWorker]) |

```javascript
// get an entire remote zip file
const zip = await Fetch("https://server.com/data.zip");
console.log(`Received: ${zip.name} (${zip.size} bytes)`);

// Extract a file from remote ZIP as JSON without pre-flight.
const json = await Fetch("https://server.com/data.zip", { target: "layers/japan.geojson" ,cors:true, type:"json"});
console.log(`Received: `, json);
```

### 🪣 `Bucket(directory, options)`

High-level interface for Cloudflare R2. Features automatic Gzip detection and parallelized Multipart uploads for files >5MB.

| Parameter | Type | Description |
| :--- | :---: | :--- |
| `silent` | Boolean | if true then no progress log |
| `eventTarget` | dom | target of event (default: window or self[webWorker]) |

```javascript
const storage = await Bucket("v1/geodata");
const file = new File(["This is a file"], "test.txt", {type:"text/plain"});

// Upload a File object (Auto-handles multipart if large)
await storage.put(file);

// Download as a File object (Auto-decompressed if Gzipped)
const file = await storage.get("test.txt");

// get meta information from the File. (size, ETag etc.)
const meta = await storage.meta("test.txt");

// Rename file
await storage.move("test.txt", "text.old.txt");

// delete file
await storage.del("text.old.txt");

// List items in the directory
const list = await storage.list();

// read a zip file as file array
const files = await storage.gets("name");

// put a zip file from file array
await storage.puts(fileArray);
```

### ⚡ `Cache(dbName/tableName)`

A persistent Key-Value file store powered by IndexedDB. Perfect for instant subsequent loads with **ultra-low latency**. For categorization, several tableNames can be assigned to the one same dbName. This case, the version of indexedDB will be incremented automatically, and users don't need to take care of "onupgradeneeded".

```javascript
// open the database with "dbName/tableName"
const local = await Cache("assets/v1");

// List names in database
const list = await local();

// Load the File object instantly (Getter)
const file = await local("tile_01");

// Save a File locally (Setter)
await local(file); // or await local(file.name, file);

// Delete a File locally
await local("tile_01", null);
```

---

## 🔒 Security: Suffix-Matching Whitelist

Access is strictly enforced via the `ALLOWED_DOMAINS` whitelist in `wrangler.toml`.

- **`ortho-earth.com`** matches `ortho-earth.com`, `www.ortho-earth.com`, `dev.ortho-earth.com`, etc.
- **`localhost:5173`** allows access from your local dev-server.

---

## 📄 License

(c) 2026 Kenji Yoshida. Released under the **MIT License**.
