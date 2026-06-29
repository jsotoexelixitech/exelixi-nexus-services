# Regenera el indice de simbolos ctags para todo el workspace
# Uso: .\update-tags.ps1
Set-Location $PSScriptRoot
ctags -R `
  --exclude=node_modules `
  --exclude=dist `
  --exclude=build `
  --exclude=.git `
  --exclude=dev-dist `
  --exclude=.cache `
  --exclude=.antigravity `
  --exclude=.agents `
  --exclude="*.min.js" `
  --exclude="*.map" `
  --exclude=workbox* `
  --languages=JavaScript,TypeScript,SQL `
  --output-format=u-ctags `
  -f tags `
  .
$lines = (Get-Content tags | Measure-Object -Line).Lines
Write-Host "tags actualizado: $lines simbolos"
