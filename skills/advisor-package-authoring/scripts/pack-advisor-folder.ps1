param(
  [Parameter(Mandatory = $true)][string]$SourceDir,
  [string]$OutputZip = ""
)

$source = (Resolve-Path -LiteralPath $SourceDir).Path
if (-not $OutputZip) {
  $OutputZip = Join-Path (Split-Path -Parent $source) ((Split-Path -Leaf $source) + ".zip")
}
$output = [System.IO.Path]::GetFullPath($OutputZip)
if (Test-Path -LiteralPath $output) { throw "输出 ZIP 已存在：$output" }

node (Join-Path $PSScriptRoot 'validate-advisor-folder.mjs') $source
if ($LASTEXITCODE -ne 0) { throw "目录校验失败，未创建 ZIP" }

Compress-Archive -LiteralPath $source -DestinationPath $output -CompressionLevel Optimal
Write-Output "Created: $output"
