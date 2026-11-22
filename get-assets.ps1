# One-time (Windows): download the MediaPipe runtime + models into .\vendor
# Run:  powershell -ExecutionPolicy Bypass -File .\get-assets.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$V = '0.10.14'
$CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@$V"
$MODELS = 'https://storage.googleapis.com/mediapipe-models'
New-Item -ItemType Directory -Force vendor\wasm, vendor\models | Out-Null
Invoke-WebRequest "$CDN/vision_bundle.mjs" -OutFile vendor\vision_bundle.mjs
foreach ($f in 'vision_wasm_internal.js','vision_wasm_internal.wasm','vision_wasm_nosimd_internal.js','vision_wasm_nosimd_internal.wasm') {
  Invoke-WebRequest "$CDN/wasm/$f" -OutFile "vendor\wasm\$f"
}
Invoke-WebRequest "$MODELS/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task" -OutFile vendor\models\hand_landmarker.task
Invoke-WebRequest "$MODELS/face_landmarker/face_landmarker/float16/1/face_landmarker.task" -OutFile vendor\models\face_landmarker.task
Write-Host 'Done. Now load this folder in chrome://extensions (Developer mode -> Load unpacked).'
