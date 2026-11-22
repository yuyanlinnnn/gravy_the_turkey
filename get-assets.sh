#!/usr/bin/env bash
# One-time: download the MediaPipe runtime + models into ./vendor (extensions can't load code from a CDN).
set -euo pipefail
cd "$(dirname "$0")"
V=0.10.14
CDN="https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@$V"
MODELS="https://storage.googleapis.com/mediapipe-models"
mkdir -p vendor/wasm vendor/models
curl -fL -o vendor/vision_bundle.mjs "$CDN/vision_bundle.mjs"
for f in vision_wasm_internal.js vision_wasm_internal.wasm vision_wasm_nosimd_internal.js vision_wasm_nosimd_internal.wasm; do
  curl -fL -o "vendor/wasm/$f" "$CDN/wasm/$f"
done
curl -fL -o vendor/models/hand_landmarker.task "$MODELS/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
curl -fL -o vendor/models/face_landmarker.task "$MODELS/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
echo "Done. Now load this folder in chrome://extensions (Developer mode → Load unpacked)."
