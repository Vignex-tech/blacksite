# Blacksite style guide

Source: `Docs/master-brief.md` sections 4, 5 and 11, and `Docs/art-plan.md`. If this file and `CLAUDE.md` disagree, `CLAUDE.md` wins.

## Direction
Grounded, near-future industrial espionage. A believable secure facility converted into a tactical battleground: concrete service spaces, metal structures, ventilation, server rooms, practical lights. Low-poly and dark-lit, with readable silhouettes. Avoid exaggerated sci-fi armour, bright neon, unrealistic weapons and noisy surfaces.

## Palette (restrained)
| Role | Colour use | Notes |
|---|---|---|
| Charcoal black | deep structural shadow, powder-coated panels | never pure black: keep a faint floor so shapes read |
| Cold blue-gray | concrete, metal, ambient light, moonlight | the base of every surface |
| Muted green | security gear, server LEDs, an idle terminal | small areas only |
| Warm amber | maintenance lamps, a hacked terminal | the main warm accent |
| Emergency red | alarms, restricted access | rare and small |
| Neutral white | task and security light | highest brightness in the scene |
| Cyan emissive | climb anchors only | rule 5: nothing else may glow cyan |
| Violet | Ghost accent | small trim, not a full-body colour |
| Orange | Warden accent | visor and trim, not a full-body colour |

No bright neon, no saturated large areas.

## Teams: silhouette and gear first, colour second
Team colour is never the only signal (brief 4.2). No wall-penetrating outlines (rule 7 keeps darkness from making a player unreadable, but through-wall markers are a wallhack).
- **Ghost** (infiltrator): lean, light proportions. Dark technical clothing, hood or face cover, flexible armour panels, reinforced knees, gloves, utility straps and a compact climbing harness. Violet accent. No weapon art at all.
- **Warden** (defender): bulkier and broader. Ballistic vest with plates, helmet, radio, practical flashlight mount, rifle. Orange visor or trim accent.
- A Ghost and a Warden must be told apart in a silhouette test (greyscale, small size) before colour is applied.

## Surfaces and materials
- PBR with packed textures: albedo, normal, ORM (occlusion in red, roughness in green, metal in blue). Roughness is never mirror-like; metal stays 0 or 1 with believable roughness variation.
- Concrete: smooth poured, rough structural, painted, damp or stained. Metal: painted industrial steel, brushed or galvanized, rusted maintenance, powder-coated security panel. Plus floor plating and ground. Subtle wear only; avoid repetitive patterns and excessive grunge.
- Texel density equal everywhere: one tile per 2 m, UVs in world units. Avoid high-frequency detail that adds noise at competitive distances.
- No glass, no decals with text, no logos, no readable brand text. Screens show our own simple glyphs.
- Terminal states differ in shape and colour, not colour alone: idle green with a glyph, inactive dark with an off glyph, hacked amber with a check mark.
- Climb anchors are the only things that look climbable (rule 5): ladder strips and lipped ledges with cyan emissive. Decoration must not look like a ledge or ladder.

## Lighting and readability (brief 4.3)
Dark but readable: an ambient floor, one moon-like directional light, at most 3 practical lights, fog, no heavy post. A hidden Ghost, a Ghost in partial light, a Ghost silhouetted against a brighter background and a Ghost lit by a flashlight must all stay distinguishable. Prefer a faint rim light on characters over outlines.

## Budgets (hard)
First load target 20 MB, hard limit 30 MB. Ghost 4,000 tris, Warden 5,000, rifle 1,500, any prop 2,000, props total about 20,000. Textures 1024 px for wall, floor and ground, 512 px elsewhere, WebP. At most 120 draw calls and 150k active triangles in a frame.

## Naming and files
Lowercase snake_case with prefix `mesh_`, `tex_`, `anim_`, `sfx_`. In the scene graph new visual nodes use `visual-`, `decor-` or `fx-`; the prefixes `player-`, `solid-`, `floor-`, `ramp-`, `anchor-`, `terminal-` and `tracer` belong to the existing graybox meshes only.

## Animation
Clips only, chosen from synced state (no root motion). Briefly anticipate big movements but never delay responsive controls. Missing clips are posed procedurally in client code so each mode still has a distinct pose (see `Art/README.md`).
