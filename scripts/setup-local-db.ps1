<#
.SYNOPSIS
Creates the local RenderFlow role and database, then applies migrations.

.DESCRIPTION
Idempotent. Safe to re-run: an existing role or database is left alone.
Requires the PostgreSQL superuser password, which psql will prompt for.
Must be run from the repository root.
#>

$ErrorActionPreference = "Stop"

$psql = "C:\Program Files\PostgreSQL\16\bin\psql.exe"
if (-not (Test-Path -LiteralPath $psql)) {
    throw "psql.exe not found at $psql"
}

$role = "renderflow"
$db = "renderflow"

function Invoke-SuperuserSql {
    param([string]$Sql)

    $result = & $psql -U postgres -h localhost -d postgres -tAc $Sql 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "psql failed: $result"
    }
    return $result.Trim()
}

Write-Host "Checking for role '$role'..." -ForegroundColor Cyan
if (Invoke-SuperuserSql "SELECT 1 FROM pg_roles WHERE rolname = '$role'") {
    Write-Host "  role already exists, leaving it alone" -ForegroundColor DarkGray
} else {
    Write-Host "  creating role" -ForegroundColor Cyan
    Invoke-SuperuserSql "CREATE ROLE $role LOGIN PASSWORD 'renderflow' CREATEDB" | Out-Null
}

Write-Host "Checking for database '$db'..." -ForegroundColor Cyan
if (Invoke-SuperuserSql "SELECT 1 FROM pg_database WHERE datname = '$db'") {
    Write-Host "  database already exists, leaving it alone" -ForegroundColor DarkGray
} else {
    Write-Host "  creating database" -ForegroundColor Cyan
    Invoke-SuperuserSql "CREATE DATABASE $db OWNER $role" | Out-Null
}

Write-Host "Applying migrations..." -ForegroundColor Cyan
& npx.cmd prisma migrate deploy
if ($LASTEXITCODE -ne 0) {
    throw "prisma migrate deploy failed"
}

Write-Host ""
Write-Host "Ready. Run: npm run test:integration" -ForegroundColor Green
