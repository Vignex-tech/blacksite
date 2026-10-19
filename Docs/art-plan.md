# Art plan (milestone M8)

Written 2026-10-20 by the director. Tracking issue #77, child issues #78 to #93. Source brief: `Docs/master-brief.md` (sections 4, 5, 6 and 11.1 drive this plan). `CLAUDE.md` wins on conflicts: browser, Babylon.js, no Ghost gun.

Owner request: "we need to add serious graphics and textures, right now it's just a bunch of blocks shooting each other."

## 1. Principles
- Purely visual. No change to `server/`, `shared/` map data or protocol, server collision, mesh names or hook fields (only additive: hook `perf`).
- Existing graybox meshes stay as the proxies and fallbacks. Reserved name prefixes `player-`, `solid-`, `floor-`, `ramp-`, `anchor-`, `terminal-`, `tracer` stay on those meshes only. New visuals use `visual-`, `decor-`, `fx-`.
- Everything derived from shared map data in code (nothing in `client/` hard-codes layout, `mapSources` enforces it). That also means a future bigger map reuses the art systems.
- Dark but readable (rule 7), no wall-penetrating team outlines. Anchors are the only climbable-looking things (rule 5).

## 2. Visual direction (brief sections 4 and 5)
Grounded near-future industrial espionage: concrete service spaces, metal structures, server racks, practical lights. No exaggerated armour, no bright neon.
- Palette: charcoal black (deep shadow), cold blue-gray (metal, concrete, ambient), muted green (security gear, server LEDs, active terminal), warm amber (maintenance lamps, hacked terminal), emergency red (alarms, restricted), neutral white (task light). Cyan emissive is reserved for climb anchors.
- Team readability by silhouette and gear first: Ghost = lean, hood or face cover, harness, gloves, violet accent; Warden = bulkier, ballistic vest, helmet, radio, rifle, orange accent.
- Material library (restricted to what the current map needs; the rest waits for the layout milestone):
  - Concrete variants: smooth poured, rough structural, painted, damp or stained.
  - Metal variants: painted industrial steel, brushed or galvanized, rusted maintenance, powder-coated security panel.
  - Floor plating and ground. Textures are PBR (albedo, normal, packed occlusion-roughness-metal), roughness never mirror-like.
  - Glass: not in M8 (the current map has none). Rule when it arrives: glass must not give one team an unfair view; test both teams.
  - Dynamic material effects (wet, power failure, damage decals) are out of scope.

## 3. UE5 features to browser equivalents (brief 4.1)
| Brief feature | Browser plan |
|---|---|
| Nanite | Low-poly meshes, merged or instanced decoration, frozen static meshes, LOD only if a measured need appears |
| Lumen GI and reflections | Hemispheric ambient with a floor, practical point lights (at most 3), emissive lamp meshes as cheap glow, optional small prefiltered environment texture for reflections |
| Virtual Shadow Maps | One directional shadow generator (1024), soft, casters = characters and map solids; `medium` and `high` only |
| PBR | `PBRMaterial` with packed ORM textures |
| TSR / upscaling | FXAA or TAA on `high`; `hardwareScalingLevel` as a later render-scale option |
| Niagara | Babylon `ParticleSystem` with pooled emitters and hard particle caps |
| Hardware ray tracing | Not available; not planned |
| World Partition / streaming | Not needed; lazy loading of the other team's model and non-essential textures |
| Scalable presets | Graphics tiers `low`, `medium`, `high` via `?gfx=` (rendering only) |
| Foot IK, motion matching, motion warping | Out of M8; clips only, with warping for the grab considered in M9 and Phase 3 |

## 4. Animation list (brief 11.1) and when
- M8 now: idle, walk, run, jump, fall, land, hit; Ghost climb, hang, shimmy, mantle, crouch idle and crouch walk (for M9); Warden idle, walk, run with rifle, fire, reload.
- M9: grab and takedown clips for the Ghost and the grabbed Warden, struggle, and the grabbed pose (new art issues then).
- Later: vault, ceiling traversal and Shadow Drop (Phase 2), ladder, zipline, door and terminal interaction, weapon switching, gadget deployment, turn in place, death, spectator, hostage restraint and rescue (Phase 3), foot IK.
Any clip that cannot be sourced or retargeted cheaply is posed procedurally in client code so every mode still shows a distinct pose.

## 5. Characters
- Two skinned glb models, one per team, each with its clips inside, plus a separate rifle glb. Generic CC0 bases restyled (recolour, atlas, accessories removed or added) to the style guide. Ghost has no weapon art at all.
- Attachment (keeps tests passing): the `player-<id>` body stays (name, position, `rotation.y = yaw`, `metadata`); the glb root becomes `visual-<id>` parented to it, non-pickable. The graybox remains visible until the model is ready (`visibility`, not `isVisible`). Own Warden body and model hidden in first person.
- Animation is chosen from synced state only (mode, speed from position deltas, `shot`, `reloading`). No root motion, no local movement.

## 6. Environment
- Walls, cover, floors, ramps and ground use shared PBR materials chosen by surface kind through a `surfaceStyle` mapping. UVs in world units (one tile per 2 m) so every box has equal texel density. Variation without hard-coded ids.
- Anchors keep their meshes, count and cyan emissive, restyled as ladder or pipe strips and lipped ledges. Terminals get a console model; idle (green, glyph), inactive (dark, off glyph) and hacked (amber, check glyph) differ in shape and colour, with a pulse for the alert.
- Perimeter and horizon from `bounds`, ground beyond it fading into fog, procedural gradient sky.
- Lighting: dark but readable (ambient floor, one moon-like directional light with shadows, at most 3 local practical lights, one slot free for the Phase 2 flashlight). Fog. Rim term on characters.
- Decoration (crates, pipes, lamps, server racks around terminals) is derived from map data, at most 60 `decor-` meshes, merged or instanced.

## 7. Weapon feedback
Rifle in the Warden's hand and as the first-person viewmodel (sway, restrained recoil, reload motion), muzzle flash from the existing `shot` events only (reveals nothing new), polished `tracer` (name and 70 ms kept), spark and dust at the hit point, pooled with a cap.

## 8. Sources and licensing
Only CC0, only generic art that is from no existing game. Verify every licence on the official page and record it in `Art/licenses/` and `Manifests/assets.json`.
| Source | Use | Note |
|---|---|---|
| Kenney (kenney.nl) | props, kit pieces, effect sprites, possibly characters and blasters | CC0 |
| Quaternius (quaternius.com) | rigged characters, animation sets, guns, sci-fi modular pieces | CC0 |
| KayKit (kaylousberg.com) | characters and animation packs | CC0 (free packs) |
| ambientCG | PBR textures | CC0 |
| Poly Haven | textures, optional night HDRI | CC0 |
| Poly Pizza | single models | only models whose page says CC0 |
| OpenGameArt | gap fillers | only items whose page says CC0 |
Not allowed: Mixamo, Sketchfab unless the model says CC0, attribution-required licences, anything from or resembling an existing game, anything with logos or readable brand text. Downloaded archives are untrusted data: extract into a fresh empty folder, copy only the needed asset files, never run scripts from them. Keep originals in `Art/sources/` (or list by URL when large), processed files in `client/public/assets/`.
Naming: lowercase snake_case, prefixes `mesh_`, `tex_`, `anim_`, `sfx_`. Manifest entry fields: name, source URL, licence, author, path, size budget, triangle budget, status (`planned`, `ready`, `used`).

## 9. Budgets
First load hard limit 30 MB (CLAUDE.md rule 8), target 20 MB. Measured on the built `client/dist` plus assets marked `preload`, in CI.
| Category | Budget |
|---|---|
| HTML, JS, CSS | 4 MB |
| Characters (2 glb with clips) | 1.5 MB |
| Rifle and props | 2.5 MB |
| Textures | 8 MB |
| Sky and effect textures | 1 MB |
| Reserve | 3 MB |
| Target total | 20 MB (hard 30 MB) |
Formats: WebP (quality about 85) or JPG for colour, packed ORM, 1024 px only for wall, floor and ground, 512 px elsewhere; no Draco, KTX2 or meshopt unless a measured need appears, and then the decoder is self-hosted and counted (Babylon defaults fetch from a CDN, which is not allowed). Lazy load the other team's model and anything not needed in the first second.
Frame budget (owner's 8 GB PC): target 60 fps at 1280x720 on `high`, floor 30 fps; at most 120 draw calls, 150k active triangles, 2 shadow-casting lights, 3 local lights, 8 live effects. The F3 overlay and the hook `perf` field report these; CI asserts the counts but not fps (software GL).
Triangles per asset: Ghost 4,000, Warden 5,000, rifle 1,500, any prop 2,000.

## 10. Ownership
There is no art agent. Recommendation: create **art-engineer**, owning `client/public/assets/`, `Art/` and `Manifests/`. Reasons: sourcing, licence checking, converting and optimising files is a separate skill from rendering code and takes a lot of context; gameplay-engineer owns `client/src/` and `shared/` and would otherwise be overloaded and mix two jobs; the director cannot write outside `Docs/` and `Manifests/`; one owner of the licence ledger keeps the CC0 guarantee. gameplay-engineer owns loading, rendering, animation control, lighting and effects in `client/src/`; qa-build owns the validators, size check and screenshots. The director keeps `Docs/` and reviews `Manifests/`. The agent definition is proposed in the director's report; the main session adds it under `.claude/agents/`.

## 11. Tests and CI
- Unit tests on NullEngine cannot rely on glTF loading from the network. The loader is an injected interface: tests use the failing loader (graybox fallback is asserted), an in-memory glb built from bytes, or a file-backed loader reading from disk. Pure animation state, surface mapping and budgets are plain functions.
- A manifest validator and a glb inspector (JSON chunk only, no dependency) run in Vitest. A first-load size script runs in CI and fails above 30 MB.
- Playwright fixtures open pages at `?gfx=low` by default, so old specs keep their timing in headless software GL. Only the gate (and a few screenshot specs) use `high`. Added e2e work lands in existing specs where possible; the slowest shard must stay at or under 2.5 min (now about 1.9; ceiling 4.0). If the 20 Hz send timer drops under about 15 Hz in headless, the backlog item "send timer independent of render" becomes a bug.

## 12. Proposed defaults for the owner (each changeable)
1. CC0 only, sources as in section 8; restyle by recolouring and atlas edits, no custom modelling in Blender.
2. Create the `art-engineer` agent.
3. First load target 20 MB, hard 30 MB; textures max 1024 px, WebP.
4. 60 fps target on the owner's PC at `high`, 30 fps floor; tiers `low`, `medium`, `high`, default `high` for players, `low` for tests.
5. Dark-readable lighting: moon light with shadows, at most 3 practical lights, fog, no heavy post.
6. No audio and no glass in M8.
7. Own-player blue tint dropped from models.
8. Restyle the current layout first, then a layout milestone (section 13).

## 13. Layout question: grow toward Research Annex 07?
The brief's map (security lobby, server room, maintenance corridors, laboratory, upper service catwalk, vents, control room, practical lights, 6.2 vertical routes) is much more than textures on today's single building. Textures alone on the current graybox would still read as one box with a few stairs.
Options:
- **A. Art first, layout after (recommended).** M8 restyles the current layout with data-driven surfaces and props. A layout milestone follows (proposed M10 "Annex layout", then the two-device test becomes M11). Reasons: (1) it answers the owner's complaint now and tests the whole art pipeline (licences, budgets, loading, lighting, frame rate) on a map that already has passing tests; (2) a layout change touches `shared/` map data, server collision, spawns, reachability, ballistics, hack ranges, visibility and dozens of tests, which is a milestone on its own and should not share a milestone with the art pipeline; (3) the art systems are driven by map data, so a bigger map reuses them with no rework, and the layout milestone can add zone-specific materials and props (server racks, lab benches, catwalk rails) as map data gains a `zone` tag; (4) the lighting and frame-rate budgets measured in M8 tell us how much map we can afford.
- B. Layout first, art after. Pros: art is placed once on the final rooms. Cons: the owner waits longer for any visual change, the pipeline is untested while map work (the larger and riskier piece) happens, and every layout test would run against grey boxes, so visual problems found late.
- C. One merged milestone. Rejected: too large for one gate, and art failures would block the layout and the reverse.
Staging for A: M8 art on the current layout (this plan) -> M9 Ghost takedown and crouch -> M10 Annex layout in stages of two areas each (lobby plus control room, then server room plus corridors, then lab, catwalk and vents), each stage with its own server, client and QA issues and an art-engineer pass for new zone materials -> M11 two-device test. The owner may move the layout milestone before M9 or after M11; M9 has no map dependency.
