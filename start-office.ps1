Set-Location $PSScriptRoot
$pg = "C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe"
$data = Join-Path $PSScriptRoot ".pgdata"
if ((Test-Path $pg) -and (Test-Path $data)) {
  & $pg -D $data status | Out-Null
  if ($LASTEXITCODE -ne 0) {
    & $pg -D $data -l (Join-Path $data "server.log") -o "-p 5433" start
  }
}
if (-not (Test-Path node_modules)) { npm install }
npm start
