param(
    [string]$SourceImage = (Join-Path $PSScriptRoot '..\塞伯坦文字2.jpg'),
    [string]$GlyphRoot = (Join-Path $PSScriptRoot '..\app\assets\glyphs'),
    [string]$ProvenancePath = (Join-Path $PSScriptRoot 'artifacts\dual-family-glyph-provenance.csv')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$letters = [char[]]'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
$outputScale = 4
$opaqueLuminance = 112
$transparentLuminance = 242
$autobotDirectory = Join-Path $GlyphRoot 'autobot'
$decepticonDirectory = Join-Path $GlyphRoot 'decepticon'
New-Item -ItemType Directory -Force -Path $autobotDirectory, $decepticonDirectory, (Split-Path -Parent $ProvenancePath) | Out-Null

$legacyFiles = @(Get-ChildItem -LiteralPath $GlyphRoot -File -Filter '*.png')
if ($legacyFiles.Count -notin @(0, 26)) {
    throw "Expected zero or 26 legacy root glyphs, found $($legacyFiles.Count)"
}

if ($legacyFiles.Count -eq 26) {
    foreach ($letter in $letters) {
        $legacyPath = Join-Path $GlyphRoot "$letter.png"
        $destinationPath = Join-Path $autobotDirectory "$letter.png"
        if (-not (Test-Path -LiteralPath $legacyPath -PathType Leaf)) {
            throw "Missing legacy Autobot glyph: $legacyPath"
        }
        if (-not (Test-Path -LiteralPath $destinationPath -PathType Leaf)) {
            Copy-Item -LiteralPath $legacyPath -Destination $destinationPath
        }
        $legacyHash = (Get-FileHash -LiteralPath $legacyPath -Algorithm SHA256).Hash
        $destinationHash = (Get-FileHash -LiteralPath $destinationPath -Algorithm SHA256).Hash
        if ($legacyHash -ne $destinationHash) {
            throw "Autobot migration changed bytes for $letter"
        }
    }
    Remove-Item -LiteralPath $legacyFiles.FullName
}

function Get-CellBounds {
    param([double[]]$Centers, [int]$OuterLeft, [int]$OuterRight)

    $bounds = [Collections.Generic.List[object]]::new()
    for ($index = 0; $index -lt $Centers.Count; $index++) {
        $left = if ($index -eq 0) { $OuterLeft } else { [Math]::Floor(($Centers[$index - 1] + $Centers[$index]) / 2) + 1 }
        $right = if ($index -eq $Centers.Count - 1) { $OuterRight } else { [Math]::Floor(($Centers[$index] + $Centers[$index + 1]) / 2) }
        $bounds.Add([pscustomobject]@{ Left = $left; Right = $right })
    }
    return $bounds
}

function Export-GlyphCell {
    param(
        [Drawing.Bitmap]$Source,
        [int]$Left,
        [int]$Right,
        [int]$Top,
        [int]$Bottom,
        [string]$Destination
    )

    $sourceWidth = $Right - $Left + 1
    $sourceHeight = $Bottom - $Top + 1
    $cellWidth = $sourceWidth * $outputScale
    $cellHeight = $sourceHeight * $outputScale
    $resampled = [Drawing.Bitmap]::new($cellWidth, $cellHeight, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $resampleGraphics = [Drawing.Graphics]::FromImage($resampled)
    try {
        $resampleGraphics.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceCopy
        $resampleGraphics.CompositingQuality = [Drawing.Drawing2D.CompositingQuality]::HighQuality
        $resampleGraphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $resampleGraphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $resampleGraphics.DrawImage(
            $Source,
            [Drawing.Rectangle]::new(0, 0, $cellWidth, $cellHeight),
            $Left,
            $Top,
            $sourceWidth,
            $sourceHeight,
            [Drawing.GraphicsUnit]::Pixel
        )
    } finally {
        $resampleGraphics.Dispose()
    }

    $alphaRows = [Collections.Generic.List[byte[]]]::new()
    $firstVisibleColumn = $cellWidth
    $lastVisibleColumn = -1

    try {
        for ($cellY = 0; $cellY -lt $cellHeight; $cellY++) {
            $row = [byte[]]::new($cellWidth)
            for ($cellX = 0; $cellX -lt $cellWidth; $cellX++) {
                $pixel = $resampled.GetPixel($cellX, $cellY)
                $luminance = 0.2126 * $pixel.R + 0.7152 * $pixel.G + 0.0722 * $pixel.B
                $alpha = if ($luminance -ge $transparentLuminance) {
                    0
                } elseif ($luminance -le $opaqueLuminance) {
                    255
                } else {
                    [Math]::Round(($transparentLuminance - $luminance) * 255 / ($transparentLuminance - $opaqueLuminance))
                }
                $row[$cellX] = $alpha
                if ($alpha -gt 0) {
                    $firstVisibleColumn = [Math]::Min($firstVisibleColumn, $cellX)
                    $lastVisibleColumn = [Math]::Max($lastVisibleColumn, $cellX)
                }
            }
            $alphaRows.Add($row)
        }
    } finally {
        $resampled.Dispose()
    }

    if ($lastVisibleColumn -lt 0) {
        throw "No visible source pixels in cell x=$Left..$Right y=$Top..$Bottom"
    }

    $cropLeft = $firstVisibleColumn
    $cropRight = $lastVisibleColumn
    $outputWidth = $cropRight - $cropLeft + 1
    $output = [Drawing.Bitmap]::new($outputWidth, $cellHeight, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        for ($outputY = 0; $outputY -lt $cellHeight; $outputY++) {
            for ($outputX = 0; $outputX -lt $outputWidth; $outputX++) {
                $alpha = $alphaRows[$outputY][$cropLeft + $outputX]
                $output.SetPixel($outputX, $outputY, [Drawing.Color]::FromArgb($alpha, 0, 0, 0))
            }
        }
        $temporaryPath = "$Destination.extracting.png"
        $output.Save($temporaryPath, [Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $output.Dispose()
    }
    Move-Item -LiteralPath $temporaryPath -Destination $Destination -Force

    return [pscustomobject]@{
        OutputWidth = $outputWidth
        OutputHeight = $cellHeight
        VisibleSourceLeft = $Left + $firstVisibleColumn
        VisibleSourceRight = $Left + $lastVisibleColumn
    }
}

$rows = @(
    [pscustomobject]@{ Family = 'autobot'; StartIndex = 0; SourceTop = 66; SourceBottom = 109; LabelTop = 119; Centers = [double[]](39.5, 95, 150.5, 204, 253, 302.5, 358.5, 408.5, 458, 517.5, 577.5, 630.5, 682); Method = 'byte-identical migration of verified first-table assets' },
    [pscustomobject]@{ Family = 'autobot'; StartIndex = 13; SourceTop = 175; SourceBottom = 219; LabelTop = 228; Centers = [double[]](37.5, 90.5, 154.5, 203.5, 256.5, 302.5, 358, 407, 463.5, 520.5, 580.5, 630, 682.5); Method = 'byte-identical migration of verified first-table assets' },
    [pscustomobject]@{ Family = 'decepticon'; StartIndex = 0; SourceTop = 356; SourceBottom = 400; LabelTop = 411; Centers = [double[]](47, 98.5, 143, 192.5, 240, 297, 350, 405.5, 459.5, 515.5, 576, 632, 681); Method = 'label-center cells; continuous luminance-to-alpha extraction' },
    [pscustomobject]@{ Family = 'decepticon'; StartIndex = 13; SourceTop = 459; SourceBottom = 501; LabelTop = 514; Centers = [double[]](45, 99.5, 147.5, 187.5, 246.5, 296, 352.5, 407, 463, 525, 575, 631, 686); Method = 'label-center cells; continuous luminance-to-alpha extraction' }
)

$source = [Drawing.Bitmap]::new([string](Resolve-Path -LiteralPath $SourceImage).Path)
$provenance = [Collections.Generic.List[object]]::new()
try {
    if ($source.Width -ne 734 -or $source.Height -ne 592) {
        throw "Unexpected source dimensions $($source.Width)x$($source.Height); expected 734x592"
    }

    foreach ($row in $rows) {
        if ($row.SourceBottom -ge $row.LabelTop) {
            throw "$($row.Family) source band overlaps its English labels"
        }
        $cells = Get-CellBounds -Centers $row.Centers -OuterLeft 18 -OuterRight 716
        for ($column = 0; $column -lt 13; $column++) {
            $letter = [string]$letters[$row.StartIndex + $column]
            $cell = $cells[$column]
            $path = Join-Path (Join-Path $GlyphRoot $row.Family) "$letter.png"
            $result = $null
            $result = Export-GlyphCell -Source $source -Left $cell.Left -Right $cell.Right -Top $row.SourceTop -Bottom $row.SourceBottom -Destination $path
            $asset = [Drawing.Bitmap]::new($path)
            try {
                $provenance.Add([pscustomobject]@{
                    Family = $row.Family
                    Letter = $letter
                    SourceTable = if ($row.Family -eq 'autobot') { 'AUTOBOT first table' } else { 'DECEPTICON second table' }
                    SourceCellLeft = $cell.Left
                    SourceCellRight = $cell.Right
                    SourceTop = $row.SourceTop
                    SourceBottom = $row.SourceBottom
                    LabelBandTop = $row.LabelTop
                    VisibleSourceLeft = $result.VisibleSourceLeft
                    VisibleSourceRight = $result.VisibleSourceRight
                    OutputWidth = $asset.Width
                    OutputHeight = $asset.Height
                    Method = "label-center cells; ${outputScale}x bicubic supersampling; luminance $opaqueLuminance..$transparentLuminance to alpha; zero horizontal transparent margin"
                })
            } finally {
                $asset.Dispose()
            }
        }
    }
} finally {
    $source.Dispose()
}

$decepticonFiles = @(Get-ChildItem -LiteralPath $decepticonDirectory -File -Filter '*.png')
if ($decepticonFiles.Count -ne 26 -or $provenance.Count -ne 52) {
    throw "Extraction did not produce the expected 26 Decepticon files and 52 provenance rows"
}
$provenance | Export-Csv -LiteralPath $ProvenancePath -NoTypeInformation -Encoding utf8
Write-Output "Dual-family extraction passed: 52 ${outputScale}x supersampled PNG assets with continuous alpha and zero horizontal transparent margin."
Write-Output "Provenance: $ProvenancePath"