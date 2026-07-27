param(
    [string]$GlyphRoot = (Join-Path $PSScriptRoot '..\app\assets\glyphs'),
    [string]$ProvenancePath = (Join-Path $PSScriptRoot 'artifacts\dual-family-glyph-provenance.csv'),
    [string]$ProofPath = (Join-Path $PSScriptRoot 'artifacts\dual-family-glyph-check.png')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$letters = [char[]]'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
$families = @('autobot', 'decepticon')
$summary = [Collections.Generic.List[object]]::new()
$familyHashes = @{}

$legacyFiles = @(Get-ChildItem -LiteralPath $GlyphRoot -File -Filter '*.png')
if ($legacyFiles.Count -ne 0) {
    throw "Legacy root glyphs remain under $GlyphRoot; expected family directories only"
}

$provenance = @(Import-Csv -LiteralPath $ProvenancePath)
if ($provenance.Count -ne 52) {
    throw "Expected 52 provenance rows, found $($provenance.Count)"
}

foreach ($family in $families) {
    $directory = Join-Path $GlyphRoot $family
    $assetFiles = @(Get-ChildItem -LiteralPath $directory -File -Filter '*.png')
    if ($assetFiles.Count -ne 26) {
        throw "Expected exactly 26 $family PNG glyphs, found $($assetFiles.Count)"
    }

    $hashes = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $familyHashes[$family] = @{}
    foreach ($letter in $letters) {
        $path = Join-Path $directory "$letter.png"
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Missing $family glyph asset: $path"
        }

        $check = [Drawing.Bitmap]::new($path)
        try {
            $minAlpha = 255
            $maxAlpha = 0
            $transparentPixels = 0
            $visiblePixels = 0
            $mixedAlphaPixels = 0
            $firstVisibleColumn = $check.Width
            $lastVisibleColumn = -1
            for ($y = 0; $y -lt $check.Height; $y++) {
                for ($x = 0; $x -lt $check.Width; $x++) {
                    $pixel = $check.GetPixel($x, $y)
                    $alpha = $pixel.A
                    $minAlpha = [Math]::Min($minAlpha, $alpha)
                    $maxAlpha = [Math]::Max($maxAlpha, $alpha)
                    if ($alpha -eq 0) { $transparentPixels++ }
                    if ($alpha -gt 0) {
                        $visiblePixels++
                        $firstVisibleColumn = [Math]::Min($firstVisibleColumn, $x)
                        $lastVisibleColumn = [Math]::Max($lastVisibleColumn, $x)
                        if ($pixel.R -ne 0 -or $pixel.G -ne 0 -or $pixel.B -ne 0) {
                            throw "$family/$letter has a non-black visible pixel at ($x, $y)"
                        }
                    }
                    if ($alpha -gt 0 -and $alpha -lt 255) { $mixedAlphaPixels++ }
                }
            }

            $hasAlpha = (($check.PixelFormat -band [Drawing.Imaging.PixelFormat]::Alpha) -ne 0)
            if (-not $hasAlpha) { throw "$family/$letter has no alpha pixel format" }
            if ($check.Width -le 0 -or $check.Height -le 0) { throw "$family/$letter has invalid dimensions" }
            if ($minAlpha -ne 0) { throw "$family/$letter MinAlpha is $minAlpha, expected 0" }
            if ($maxAlpha -le 0) { throw "$family/$letter has no visible pixels" }
            if ($transparentPixels -le 0 -or $visiblePixels -le 0 -or $mixedAlphaPixels -le 0) {
                throw "$family/$letter must contain transparent, visible, and mixed-alpha pixels"
            }

            $leftMargin = $firstVisibleColumn
            $rightMargin = $check.Width - 1 - $lastVisibleColumn
            if ($leftMargin -ne 0 -or $rightMargin -ne 0) {
                throw "$family/$letter horizontal transparent margins are $leftMargin/$rightMargin, expected 0/0"
            }

            $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
            if (-not $hashes.Add($hash)) { throw "$family/$letter duplicates another glyph asset hash" }
            $familyHashes[$family][[string]$letter] = $hash
            $sourceRow = @($provenance | Where-Object { $_.Family -eq $family -and $_.Letter -eq [string]$letter })
            if ($sourceRow.Count -ne 1) { throw "Expected one provenance row for $family/$letter" }
            if ([int]$sourceRow[0].SourceBottom -ge [int]$sourceRow[0].LabelBandTop) {
                throw "$family/$letter provenance overlaps an English label band"
            }
            if ([int]$sourceRow[0].OutputWidth -ne $check.Width -or [int]$sourceRow[0].OutputHeight -ne $check.Height) {
                throw "$family/$letter dimensions differ from extraction provenance"
            }

            $summary.Add([pscustomobject]@{
                Family = $family
                Letter = [string]$letter
                Width = $check.Width
                Height = $check.Height
                Transparent = $transparentPixels
                Visible = $visiblePixels
                Mixed = $mixedAlphaPixels
                LeftMargin = $leftMargin
                RightMargin = $rightMargin
                SHA256 = $hash
            })
        } finally {
            $check.Dispose()
        }
    }
}

foreach ($letter in @('A', 'M', 'Z')) {
    if ($familyHashes.autobot[$letter] -eq $familyHashes.decepticon[$letter]) {
        throw "Autobot and Decepticon $letter hashes must differ"
    }
}

$proof = [Drawing.Bitmap]::new(980, 430, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [Drawing.Graphics]::FromImage($proof)
try {
    $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.Clear([Drawing.Color]::FromArgb(245, 246, 243))
    $titleFont = [Drawing.Font]::new('Bahnschrift', 18, [Drawing.FontStyle]::Bold)
    $labelFont = [Drawing.Font]::new('Bahnschrift', 12, [Drawing.FontStyle]::Bold)
    $inkBrush = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(16, 18, 18))
    try {
        $graphics.DrawString('DUAL FAMILY GLYPH CHECK // A M Z', $titleFont, $inkBrush, 26, 20)
        $panels = @(
            [pscustomobject]@{ Family = 'autobot'; Label = 'AUTOBOT / LIGHT'; X = 26; Y = 62; Background = [Drawing.Color]::FromArgb(253, 253, 251) },
            [pscustomobject]@{ Family = 'decepticon'; Label = 'DECEPTICON / LIGHT'; X = 502; Y = 62; Background = [Drawing.Color]::FromArgb(253, 253, 251) },
            [pscustomobject]@{ Family = 'autobot'; Label = 'AUTOBOT / DARK'; X = 26; Y = 236; Background = [Drawing.Color]::FromArgb(112, 120, 124) },
            [pscustomobject]@{ Family = 'decepticon'; Label = 'DECEPTICON / DARK'; X = 502; Y = 236; Background = [Drawing.Color]::FromArgb(112, 120, 124) }
        )
        foreach ($panel in $panels) {
            $backgroundBrush = [Drawing.SolidBrush]::new($panel.Background)
            try {
                $graphics.FillRectangle($backgroundBrush, $panel.X, $panel.Y, 452, 148)
            } finally {
                $backgroundBrush.Dispose()
            }
            $graphics.DrawRectangle([Drawing.Pens]::Black, $panel.X, $panel.Y, 452, 148)
            $graphics.DrawString($panel.Label, $labelFont, $inkBrush, $panel.X + 14, $panel.Y + 12)
            $slot = 0
            foreach ($letter in @('A', 'M', 'Z')) {
                $glyphPath = Join-Path (Join-Path $GlyphRoot $panel.Family) "$letter.png"
                $glyph = [Drawing.Bitmap]::new($glyphPath)
                try {
                    $targetHeight = 82
                    $targetWidth = [Math]::Max(1, [Math]::Round($glyph.Width * $targetHeight / $glyph.Height))
                    $centerX = $panel.X + 96 + $slot * 132
                    $graphics.DrawImage($glyph, $centerX - $targetWidth / 2, $panel.Y + 47, $targetWidth, $targetHeight)
                    $graphics.DrawString($letter, $labelFont, $inkBrush, $centerX - 5, $panel.Y + 128)
                } finally {
                    $glyph.Dispose()
                }
                $slot++
            }
        }
    } finally {
        $titleFont.Dispose()
        $labelFont.Dispose()
        $inkBrush.Dispose()
    }
    $proof.Save($ProofPath, [Drawing.Imaging.ImageFormat]::Png)
} finally {
    $graphics.Dispose()
    $proof.Dispose()
}

$summary | Sort-Object Family, Letter | Format-Table Family, Letter, Width, Height, Transparent, Visible, Mixed, LeftMargin, RightMargin -AutoSize
foreach ($family in $families) {
    $familySummary = @($summary | Where-Object Family -eq $family)
    Write-Output ("{0}: 26 unique files; transparent={1}; visible={2}; mixed={3}; dimensions={4}..{5} x {6}..{7}." -f `
        $family, ($familySummary | Measure-Object Transparent -Sum).Sum, ($familySummary | Measure-Object Visible -Sum).Sum, `
        ($familySummary | Measure-Object Mixed -Sum).Sum, ($familySummary | Measure-Object Width -Minimum).Minimum, `
        ($familySummary | Measure-Object Width -Maximum).Maximum, ($familySummary | Measure-Object Height -Minimum).Minimum, `
        ($familySummary | Measure-Object Height -Maximum).Maximum)
}
Write-Output 'Dual-family black transparent glyph assertions passed: 52 files, no legacy root PNGs, A/M/Z hashes differ, source bands exclude English labels.'
Write-Output "Visual proof: $ProofPath"