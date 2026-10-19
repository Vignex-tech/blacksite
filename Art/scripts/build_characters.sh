#!/bin/bash
# Rebuilds the three character assets. Download the sources first (see Art/README.md "Originals") into fresh folders, then:
#   Art/scripts/build_characters.sh <UAL1_Standard.glb> <UAL2_Standard.glb> <Gun_Rifle.gltf> <T_Guns_Batch1_BaseColor.png>
# Paths must be C:/... style under Git Bash. Output goes to client/public/assets/characters/.
set -e
cd "$(dirname "$0")/.."
OUT="$(cd .. && pwd -W 2>/dev/null || pwd)/client/public/assets/characters"
node scripts/build_ghost.mjs --ual1 "$1" --ual2 "$2" --out "$OUT/mesh_ghost.glb"
node scripts/build_warden.mjs --ual1 "$1" --out "$OUT/mesh_warden.glb"
node scripts/build_rifle.mjs --gltf "$3" --atlas "$4" --out "$OUT/mesh_rifle.glb"
