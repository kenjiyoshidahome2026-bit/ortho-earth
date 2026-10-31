# custom-shaders-property-textures A/B (ortho, --gpu, --hide-ui, --settle 120000, refs and clock from v225)

Two shots per side, each on a fresh --force server with a warm-up page first.

| code | custom-shaders-property-textures colour/edges | 3d-tiles-1.1-s2-globe colour/edges |
|---|---|---|
| v225, 25d1b43d | .979/.920 | .992/.937 |
| main before the PR, cbcf2f8e (x2) | .948/.710 | .992/.937 |
| PR merged with main, f12fd60f (x2) | .948/.710 | .992/.937 |

The custom-shaders png is byte-identical across all four A/B shots, so the drop is not from PR #847. It came in between 25d1b43d and cbcf2f8e (first-parent commits, unbisected):

- cbcf2f8e2 Merge pull request #844 from kenjiyoshidahome2026-bit/gate-results/v226
- 33c7b5d56 Merge pull request #843 from kenjiyoshidahome2026-bit/gate-results/v227
- f3205da8e Merge pull request #842 from kenjiyoshidahome2026-bit/claude/project-thread-2iltj9
- 48ac83ede Merge pull request #841 from kenjiyoshidahome2026-bit/claude/project-thread-2iltj9
