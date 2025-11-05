# make-zip-windows.ps1 — create a zip of the current project (PowerShell)
# Usage: In project root: .\make-zip-windows.ps1
param(
  [string]$Out = "personal-copilot-local.zip"
)

Write-Host "Creating $Out (excluding node_modules and .git)..."

# Build an inclusion list of files excluding node_modules and .git
$cwd = Get-Location
$items = Get-ChildItem -Recurse -Force -File |
  Where-Object {
    # exclude files in node_modules or .git
    ($_.FullName -notmatch '\\node_modules\\') -and ($_.FullName -notmatch '\\.git\\') -and ($_.Name -ne $Out)
  }

if (-not $items) {
  Write-Error "No files found to zip."
  exit 1
}

# Create a temporary folder, copy selected files preserving structure, then Compress-Archive
$tmp = Join-Path $env:TEMP ("pcopilot_zip_" + [System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $tmp | Out-Null

foreach ($f in $items) {
  $rel = $f.FullName.Substring($cwd.Path.Length).TrimStart('\','/')
  $dest = Join-Path $tmp $rel
  New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
  Copy-Item -Path $f.FullName -Destination $dest -Force
}

Compress-Archive -LiteralPath $tmp\* -DestinationPath $Out -Force
# cleanup
Remove-Item -Recurse -Force $tmp

Write-Host "Created $Out"