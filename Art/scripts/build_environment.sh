#!/bin/bash
# Rebuilds the #84 assets: environment textures, effect/screen/sky textures and props.
# Download the sources first (see Art/README.md "Originals"), each archive extracted into its own fresh folder, then:
#   Art/scripts/build_environment.sh <folder with one extracted ambientCG folder per id> <MegaKit glTF folder>
# e.g. ids Concrete034 Concrete037 PaintedPlaster012 Concrete033 PaintedMetal004 Metal038 Rust004 Metal027 DiamondPlate008A Asphalt033
# and "Modular SciFi MegaKit[Standard]/glTF". Paths must be C:/... style under Git Bash. Output goes to client/public/assets/.
set -e
cd "$(dirname "$0")/.."
ROOT="$(cd .. && pwd -W 2>/dev/null || pwd)/client/public/assets"
node scripts/build_textures.mjs --src "$1" --out "$ROOT/textures"
node scripts/build_effects.mjs --out "$ROOT/effects"
node scripts/build_props.mjs --mega "$2" --out "$ROOT/props"
