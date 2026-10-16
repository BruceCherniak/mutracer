param(
  [string]$Empp = 'em++.exe',
  [string]$SourceDirectory = ''
)

$ErrorActionPreference = 'Stop'
$revision = 'c9be3103cc9693b456b0a0353927c11cac7d710f'
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

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempDirectory = Join-Path $tempRoot (
  'tinybvh-header-' + [guid]::NewGuid().ToString('N')
)
New-Item -ItemType Directory -Path $tempDirectory | Out-Null

try {
  foreach ($name in @('tiny_bvh.h', 'tiny_bvh_base.h', 'tiny_bvh_arm_float.h',
    'tiny_bvh_arm_double.h', 'tiny_bvh_x86_float.h', 'tiny_bvh_x86_double.h')) {
    Invoke-WebRequest -UseBasicParsing (
      "https://raw.githubusercontent.com/jbikker/tinybvh/$revision/$name"
    ) -OutFile (Join-Path $tempDirectory $name)
  }

  $arguments = @(
    $wrapper,
    "-I$tempDirectory",
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
} finally {
  $resolvedTemp = [IO.Path]::GetFullPath($tempDirectory)
  if (
    (Test-Path -LiteralPath $resolvedTemp) -and
    $resolvedTemp.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)
  ) {
    Remove-Item -LiteralPath $resolvedTemp -Recurse
  }
}

Write-Output "Built $output from tinybvh@$revision"
