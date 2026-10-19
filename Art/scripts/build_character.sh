#!/bin/bash
# Reduce a rigged character glb to its triangle budget (no Blender needed).
# Usage: Art/scripts/build_character.sh <in.glb> <out.glb> <ratio> [error]
# Measured on 2026-10-20: UAL1 mannequin (13,744 tris) at ratio 0.28 error 0.02 -> 3,847 tris;
# KayKit Mannequin_Medium (6,916 tris) at ratio 0.7 error 0.01 -> 5,051 tris.
# Later issues (#79) add: clip pruning, resampling, texture/material edits, naming. Paths must be Windows-style
# (C:/...) when run from Git Bash because node does not understand /c/... paths.
set -e
cd "$(dirname "$0")/.."
npx gltf-transform simplify "$1" "$2" --ratio "$3" --error "${4:-0.01}"
