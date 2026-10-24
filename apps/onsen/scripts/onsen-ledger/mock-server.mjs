// 模擬サーバ: Wikipedia API / Wikidata API / SPARQL の応答を fixtures から返す（網が閉じた器での検定用）
//   node mock-server.mjs <port>   → WIKI_API=http://127.0.0.1:<port>/w/api.php WD_API=.../wd/api.php SPARQL=.../sparql
import http from "node:http";
import { PAGES, META, REDIRECTS, CATS, LISTS, WD, ADM, OSM, GSI_HITS, HITOU_LIST, HITOU_PAGES } from "./fixtures/wikitext.mjs";

const port = +(process.argv[2] || 18080);
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"); let raw = ""; for await (const c of req) raw += c;
  const q = Object.fromEntries(new URLSearchParams(raw + "&" + u.searchParams.toString()));
  const send = o => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
  if (u.pathname === "/w/index.php" && q.action === "raw") { let t = q.title.replace(/_/g, " "); if (REDIRECTS[t]) return res.end(`#REDIRECT [[${REDIRECTS[t]}]]`); if (!PAGES[t]) { res.statusCode = 404; return res.end(""); } res.setHeader("content-type", "text/x-wiki"); return res.end(PAGES[t]); }
  if (u.pathname === "/w/api.php") {
    if (q.list === "categorymembers") { const c = CATS[q.cmtitle] || { subcats: [], pages: [] }; return send({ batchcomplete: true, query: { categorymembers: [...c.subcats.map(t => ({ ns: 14, title: t, type: "subcat" })), ...c.pages.map((t, i) => ({ ns: 0, title: t, type: "page", pageid: 5000 + i }))] } }); }
    if (q.prop === "links") return send({ query: { pages: q.titles.split("|").map(t => { const l = LISTS[t]; return l ? { title: t, links: l.map(x => ({ ns: 0, title: x })) } : { title: t, missing: true }; }) } });
    if (q.prop?.includes("coordinates")) {
      const redirects = [], pages = [];
      for (let t of q.titles.split("|")) { if (REDIRECTS[t]) { redirects.push({ from: t, to: REDIRECTS[t] }); t = REDIRECTS[t]; }
        const m = META[t]; if (!m) { pages.push({ title: t, missing: true }); continue; }
        const p = { pageid: m.pageid, ns: 0, title: t, categories: [...PAGES[t].matchAll(/\[\[Category:([^\]]+)\]\]/g)].map(x => ({ ns: 14, title: "Category:" + x[1] })), revisions: [{ slots: { main: { contentmodel: "wikitext", content: PAGES[t] } } }] };
        if (m.coord) p.coordinates = [{ lat: m.coord.lat, lon: m.coord.lon, primary: true, globe: "earth" }];
        if (m.qid) p.pageprops = { wikibase_item: m.qid }; pages.push(p); }
      return send({ batchcomplete: true, query: { redirects, pages } });
    }
  }
  if (u.pathname === "/wd/api.php" && q.action === "wbgetentities") {
    const entities = {};
    for (const id of q.ids.split("|")) { const e = WD[id]; if (!e) { entities[id] = { id, missing: "" }; continue; }
      entities[id] = { id, labels: Object.fromEntries(Object.entries(e.labels).map(([l, v]) => [l, { language: l, value: v }])), sitelinks: Object.fromEntries(Object.entries(e.sitelinks).map(([s, t]) => [s, { site: s, title: t }])),
        claims: { ...(e.P625 ? { P625: [{ rank: "normal", mainsnak: { datavalue: { value: e.P625 } } }] } : {}), P131: e.P131.map(id => ({ mainsnak: { datavalue: { value: { id } } } })), ...(e.P18 ? { P18: [{ mainsnak: { datavalue: { value: e.P18 } } }] } : {}), P31: [{ mainsnak: { datavalue: { value: { id: "Q177380" } } } }] } }; }
    return send({ entities, success: 1 });
  }
  if (u.pathname === "/sparql") {
    const query = q.query || "";
    const E = v => ({ type: "uri", value: "http://www.wikidata.org/entity/" + v }), L = (v, l = "ja") => ({ type: "literal", value: v, "xml:lang": l });
    if (query.includes("Q177380")) { const b = []; for (const [id, e] of Object.entries(WD)) { const r = { x: E(id), xLabel: L(e.labels.ja || e.labels.en) }; if (e.P625) r.coord = { type: "literal", value: `Point(${e.P625.longitude} ${e.P625.latitude})` }; if (e.P131[0]) r.adm = E(e.P131[0]); if (e.sitelinks.jawiki) r.ja = { type: "uri", value: "https://ja.wikipedia.org/wiki/" + encodeURIComponent(e.sitelinks.jawiki.replace(/ /g, "_")) }; if (e.sitelinks.enwiki) r.en = { type: "uri", value: "https://en.wikipedia.org/wiki/" + encodeURIComponent(e.sitelinks.enwiki.replace(/ /g, "_")) }; b.push(r); } return send({ results: { bindings: b } }); }
    if (query.includes("Q50337")) { const ids = [...query.matchAll(/wd:(Q\d+)/g)].map(m => m[1]); return send({ results: { bindings: ids.filter(i => ADM[i]).map(i => ({ a: E(i), aja: L(ADM[i].ja), prefja: L(ADM[i].pref) })) } }); }
  }
  const sendHtml = t => { res.setHeader("content-type", "text/html"); res.end(t); };
  if (u.pathname === "/hitou/provider/list") return sendHtml(HITOU_LIST);
  if (u.pathname.startsWith("/hitou/provider/")) { const p = HITOU_PAGES[u.pathname.split("/").pop()]; if (p) return sendHtml(p); }
  if (u.pathname === "/osm") return send(OSM[q.q] || []);
  if (u.pathname === "/gsi") return send(GSI_HITS[q.q] || []);
  res.statusCode = 404; send({ error: { code: "mock", info: "no fixture for " + req.url } });
}).listen(port, "127.0.0.1", () => console.error("mock on", port));
