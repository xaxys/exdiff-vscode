# Generates media/icon.png (128x128) for the VS Code Marketplace.
# Run from the repository root: powershell -ExecutionPolicy Bypass -File scripts/make-icon.ps1

Add-Type -AssemblyName System.Drawing

$size = 128
$bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.Clear([System.Drawing.Color]::Transparent)

function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = $r * 2
  $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
  $path.AddArc($x + $w - $diameter, $y, $diameter, $diameter, 270, 90)
  $path.AddArc($x + $w - $diameter, $y + $h - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($x, $y + $h - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-Brush([int]$r, [int]$g, [int]$b, [int]$a = 255) {
  return New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($a, $r, $g, $b))
}

function New-Pen([int]$r, [int]$g, [int]$b, [float]$width) {
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, $r, $g, $b), $width)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  return $pen
}

# Rounded background
$background = New-Brush 23 28 40
$backgroundPath = New-RoundedPath 2 2 124 124 26
$graphics.FillPath($background, $backgroundPath)

# Subtle top highlight
$highlight = New-Brush 35 43 61
$highlightPath = New-RoundedPath 2 2 124 60 26
$graphics.FillPath($highlight, $highlightPath)

# Left (old) file card
$leftCard = New-RoundedPath 18 32 54 66 8
$leftFill = New-Brush 43 50 69
$leftStroke = New-Pen 94 129 172 3
$graphics.FillPath($leftFill, $leftCard)
$graphics.DrawPath($leftStroke, $leftCard)

# Right (new) file card, overlapping
$rightCard = New-RoundedPath 56 22 54 66 8
$rightFill = New-Brush 35 42 58
$rightStroke = New-Pen 136 192 208 3
$graphics.FillPath($rightFill, $rightCard)
$graphics.DrawPath($rightStroke, $rightCard)

# Code lines
$lineBrush = New-Brush 108 122 150
foreach ($y in 44, 54, 64) {
  $graphics.FillRectangle($lineBrush, 28, $y, 32, 5)
}
foreach ($y in 36, 46, 56) {
  $graphics.FillRectangle($lineBrush, 66, $y, 32, 5)
}

# Minus badge (removed line)
$minusFill = New-Brush 191 97 106
$white = New-Pen 255 255 255 4
$graphics.FillEllipse($minusFill, 27, 74, 22, 22)
$graphics.DrawLine($white, 33, 85, 43, 85)

# Plus badge (added line)
$plusFill = New-Brush 163 190 140
$graphics.FillEllipse($plusFill, 79, 66, 22, 22)
$graphics.DrawLine($white, 85, 77, 95, 77)
$graphics.DrawLine($white, 90, 72, 90, 82)

$output = Join-Path (Split-Path -Parent $PSScriptRoot) 'media\icon.png'
$bitmap.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)

$graphics.Dispose()
$bitmap.Dispose()
Write-Output "Wrote $output"
