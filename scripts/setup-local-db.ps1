<#
.SYNOPSIS
Creates the local RenderFlow role and database, then applies migrations.

.DESCRIPTION
Idempotent. Safe to re-run: an existing role or database is left alone.
Requires the PostgreSQL superuser password, which is prompted for.
Must be run from the repository root.

.PARAMETER Port
PostgreSQL port. Defaults to 5432; override it when a local instance runs
elsewhere (a second cluster on 5433, for example).

.NOTES
$rolePassword below is a throwaway credential for a disposable local
development database. It is not a secret and must never be reused anywhere
real; the superuser password is never written to disk.
#>

param(
    [int]$Port = 5432
)

$ErrorActionPreference = "Stop"

$psql = "C:\Program Files\PostgreSQL\16\bin\psql.exe"
if (-not (Test-Path -LiteralPath $psql)) {
    throw "psql.exe not found at $psql"
}

$role = "renderflow"
$db = "renderflow"
$rolePassword = "renderflow"

# The password is read here and passed through PGPASSWORD rather than letting
# psql prompt for it. psql's own prompt writes to the console, and this script
# captures psql's output, so relying on the prompt is not reliable in a
# non-interactive or redirected run.
$superuserPassword = Read-Host "PostgreSQL superuser (postgres) password" -AsSecureString
$env:PGPASSWORD = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($superuserPassword)
)
try {
    function Invoke-SuperuserSql {
        param([string]$Sql)

        $result = & $psql -U postgres -h localhost -p $Port -d postgres -tAc $Sql 2>&1
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
        Invoke-SuperuserSql "CREATE ROLE $role LOGIN PASSWORD '$rolePassword'" | Out-Null
    }

    Write-Host "Checking for database '$db'..." -ForegroundColor Cyan
    if (Invoke-SuperuserSql "SELECT 1 FROM pg_database WHERE datename = '$db'") {
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
}
finally {
    $env:PGPASSWORD = $null
}
