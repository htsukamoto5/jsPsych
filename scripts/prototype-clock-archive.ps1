$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$prototypeRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $prototypeRoot 'dist'))
$archivePath = [IO.Path]::GetFullPath((Join-Path $artifactRoot 'shared-clock-prototype.jzip'))
$assetsPath = [IO.Path]::GetFullPath((Join-Path $artifactRoot 'shared-clock-prototype'))
$metadataPath = [IO.Path]::GetFullPath((Join-Path $artifactRoot 'shared-clock-prototype.jas'))
if (-not $archivePath.StartsWith($prototypeRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Archive escaped the repository'
}
if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf) -or -not (Test-Path -LiteralPath $assetsPath -PathType Container)) {
  throw 'Prepare the disposable study assets first'
}
if (Test-Path -LiteralPath $archivePath -PathType Leaf) { Remove-Item -LiteralPath $archivePath }
$archive = [IO.Compression.ZipFile]::Open($archivePath, [IO.Compression.ZipArchiveMode]::Create)
try {
  [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $metadataPath, 'shared-clock-prototype.jas') | Out-Null
  foreach ($asset in (Get-ChildItem -LiteralPath $assetsPath -File)) {
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $asset.FullName, ('shared-clock-prototype/' + $asset.Name)) | Out-Null
  }
} finally { $archive.Dispose() }
Write-Output "Archive: $archivePath"
