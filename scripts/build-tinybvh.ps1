param(
  [string]$Empp = 'em++.exe',
  [string]$SourceDirectory = ''
)

$ErrorActionPreference = 'Stop'
$projectDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $SourceDirectory) {
  $rendererSource = Join-Path $projectDirectory 'src\tinybvh'
  $studioSource = Join-Path $projectDirectory 'lib\tinybvh'
  if (Test-Path -LiteralPath $rendererSource) {
    $SourceDirectory = $rendererSource
  } elseif (Test-Path -LiteralPath $studioSource) {
    $SourceDirectory = $studioSource
  } else {
    throw 'Unable to find src\tinybvh or lib\tinybvh.'
  }
}
$SourceDirectory = [IO.Path]::GetFullPath($SourceDirectory)
$wrapper = Join-Path $SourceDirectory 'tinybvh_wrapper.cpp'
$output = Join-Path $SourceDirectory 'tinybvh.wasm'
if (-not (Test-Path -LiteralPath $wrapper)) {
  throw "TinyBVH wrapper not found: $wrapper"
}

$includeDirectory = & node (Join-Path $PSScriptRoot 'fetch-tinybvh.mjs')
if ($LASTEXITCODE -ne 0) {
  throw 'Unable to prepare TinyBVH headers.'
}

$arguments = @(
  $wrapper,
  "-I$includeDirectory",
  '-O3',
  '-std=c++20',
  '--no-entry',
  '-sSTANDALONE_WASM',
  '-sFILESYSTEM=0',
  '-sALLOW_MEMORY_GROWTH=1',
  '-sSTACK_SIZE=1MB',
  '-sMALLOC=emmalloc',
  '-sEXPORTED_FUNCTIONS=_malloc,_free,_tinybvh_build,_tinybvh_result_data,_tinybvh_result_size,_tinybvh_result_max_depth,_tinybvh_result_layout,_tinybvh_result_destroy',
  '-o',
  $output
)
& $Empp @arguments
if ($LASTEXITCODE -ne 0) {
  throw "em++ failed with exit code $LASTEXITCODE"
}
Write-Output "Built $output from $includeDirectory"
