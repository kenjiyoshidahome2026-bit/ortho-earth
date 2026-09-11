# ortho-world

[![npm](https://img.shields.io/npm/v/ortho-world)](https://www.npmjs.com/package/ortho-world) [![license: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

**A country selector you can drop into a `<div>`.** 262 countries and territories with flags, capitals,
ISO / IOC codes, UN membership, area, population, GDP, HDI and more — in 26 languages, searchable,
sortable, no API keys, no servers.

It is a *part*, not an app: everything lives inside the element you hand it, and it talks to the rest of
your page through signals. The intended pairing is **selector × map** — you own the map, this owns the list.

```js
import world from "ortho-world";
import "ortho-world/ortho-world.css";

const w = await world({ target: "#selector", lang: "ja" });

// world → your page
w.on("map",    e => showMap(e.url));       // the map icon was clicked
w.on("select", e => pick(e.iso2));         // a country was chosen
w.on("hover",  e => e && glow(e.iso3));    // hovering the list (null when it leaves)

// your page → world
mapLayer.onHover = iso => w.hover(iso);    // hovering on your map highlights the card
mapLayer.onClick = iso => w.select(iso);   // clicking on your map opens it
```

## Identity: ISO 3166-1 is the shared vocabulary

Every signal carries the country in the codes a map is likely to hold:

```js
{ iso2: "JP", iso3: "JPN", isoNum: 392, key: "JP", qid: "Q17", ioc: "JPN",
  name: "Japan", label: "日本", nation: { /* area, population, capital, … */ } }
```

And anything you pass **in** is resolved against all of them — `w.hover("FR")`, `w.hover("FRA")`,
`w.hover(250)`, `w.hover("Q142")` all find France. Twelve entries (Antarctica, Abkhazia, …) are not in
ISO 3166-1; for those `iso2`/`iso3` are `""` and you use `key`, which is always present.

## API

| | |
|---|---|
| `world(opts)` | mount; returns a `Promise<WorldSelector>` — resolving **is** the ready signal |
| `.on(ev, cb)` / `.off(ev, cb)` | `"select"` `"hover"` `"map"` `"lang"` |
| `.hover(id \| null)` | highlight a country in the list (orange outline + scroll into view) |
| `.select(id)` | open a country (same as clicking its flag) |
| `.clear()` | drop the highlight |
| `.lang()` / `.lang(code)` | read / switch language |
| `.nation(id)` | look a country up |
| `.list()` | the countries currently visible (after filter and sort) |
| `.destroy()` | empty the box and detach every handler |
| `.el` | the element it is attached to |

Options: `target`, `lang`, `open`, `urlHash`, `debugGlobals`. Full types in
[`ortho-world.d.ts`](./sdk/ortho-world.d.ts).

## It stays in its box

Passing `target` means *embedded*: it does not write the URL, does not put anything on `window`, does not
read `?lang` / `?open`, and its stylesheet touches nothing outside `.ortho-world` — no `body`, no `html`,
no global reset. `destroy()` leaves the element exactly as it found it. Tooltips are born inside the box
too, so they inherit its direction and go away with it.

Omit `target` and it behaves as the page's own app instead (reads `?lang=`, keeps the URL in step).

⚠ **One instance per page.** Language state and the lookup table are module-level; two instances would
both render in whichever language was created last.

## Data

Loaded from the public ortho-earth bucket (`api.ortho-earth.com`) — no key, no account. IndexedDB first,
so a return visit paints immediately and the refresh happens behind it. Sources and their licences are
listed in [packages/world/SOURCES.md](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/world/SOURCES.md);
the database is CC BY-SA 4.0, this package is MIT.

## Example

[`example.html`](./example.html) wires the selector to a stand-in "map" panel in both directions — the
whole point of the package in one page.

## Requirements

Any evergreen browser. Ships as ESM; the CSS is a separate file you import yourself (same convention as
maplibre-gl). No runtime dependencies.
