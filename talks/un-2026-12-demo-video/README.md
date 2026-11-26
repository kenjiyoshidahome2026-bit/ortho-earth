# Demo video for the UN Open GIS Initiative talk (2026-12-09)

3-minute silent video with English captions that follows the slides of "The Earth Is Round". Not part of the engine or the site.

- `timeline.js`: scenes, captions, timings (single source of truth)
- `render.html`: draws every frame on a 1920x1080 canvas (d3-geo for the globe, Mercator → Equal Earth morph); live scenes use recorded frames from `clips/<scene-id>/NNNNN.jpg`
- `rv.js`: renders frames through Playwright into H.264 (`node rv.js animatic out.mp4` uses placeholder stills, `final` uses the clips)
- `final.sh <clips folder>`: builds the final cut from the five recorded mp4 shots
- `storyboard.md`, `captions-en.srt`

World boundaries: Natural Earth via world-atlas (public domain).
