---
# https://vitepress.dev/reference/default-theme-home-page
layout: home

hero:
  name: "Ortho Earth"
  text: "A modern orthographic map renderer."
  tagline: Explore the World Orthographically.
  actions:
    - theme: brand
      text: ortho earth
      link: /ortho-earth.md
    - theme: alt
      text: geopbf
      link: /geopbf.md
    - theme: alt
      text: altpbf
      link: /altpbf.md
    - theme: alt
      text: native-bucket
      link: /native-bucket.md

features:
  - title: ortho earth
    details: High-performance, lightweight orthographic map renderer engine utilizing Web Workers and Canvas2D / WebGL2. Renders PBF binary data directly for a seamless experience.
  - title: geopbf
    details: geopbf is a lightweight, Protocol Buffers (PBF) based data engine. It is designed to complement existing GIS standards like GeoJSON and Shapefiles by providing a high-performance binary alternative that enhances memory efficiency and rendering speed in the browser.
  - title: altpbf
    details: A specialized engine for altitude and terrain data. Leveraging binary PBF formats to handle high-resolution elevation mapping and 3D geospatial calculations with minimal overhead.
  - title: native-bucket
    details: A minimalist storage utility optimized for Cloudflare R2. Facilitates a "Direct-to-Edge" data delivery model, managing public data access and secure updates with a simple, serverless-first approach.
---

