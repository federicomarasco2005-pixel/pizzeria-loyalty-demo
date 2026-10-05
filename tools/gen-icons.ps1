# Icone della tessera installata sul telefono (schermata Home).
# Uso: powershell -File tools/gen-icons.ps1 -BrandColor "#b3261e"
# Produce public/icons/icon-192.png, icon-512.png (Android, anche "maskable") e apple-touch-icon.png (iPhone, 180px).
param([string]$BrandColor = '#b3261e')

Add-Type -AssemblyName System.Drawing
$outDir = Join-Path $PSScriptRoot '..\public\icons'
New-Item -ItemType Directory -Force $outDir | Out-Null
$pizza = [System.Drawing.Image]::FromFile((Join-Path $PSScriptRoot '..\public\stamps\pizza.png'))

foreach ($v in @(@('icon-192.png', 192), @('icon-512.png', 512), @('apple-touch-icon.png', 180))) {
  $s = $v[1]
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.InterpolationMode = 'HighQualityBicubic'
  $g.Clear([System.Drawing.ColorTranslator]::FromHtml($BrandColor))
  # pizza al 62%: resta dentro la "zona sicura" anche quando Android ritaglia l'icona a cerchio
  $d = [int]($s * 0.62); $o = [int](($s - $d) / 2)
  $g.DrawImage($pizza, $o, $o, $d, $d)
  $bmp.Save((Join-Path $outDir $v[0]), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
$pizza.Dispose()
Write-Output "Icone create in $outDir"
