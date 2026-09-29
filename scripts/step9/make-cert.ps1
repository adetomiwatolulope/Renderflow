# Step 9 throwaway TLS material.
#
# The WEBHOOK_CALL executor refuses http:// (AGENTS rule 17), so the adversarial
# scenarios need a real TLS endpoint. This cert exists only to make a local
# https:// call resolvable and trusted by Node; it is not a secret, it is not
# trusted by anything but NODE_EXTRA_CA_CERTS in this workspace, and it must
# never be reused outside a disposable local test run.

param(
  [string]$OutDir = (Join-Path $PSScriptRoot "certs"),
  [string]$OpenSsl = "C:\Program Files\Git\usr\bin\openssl.exe"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $OpenSsl)) {
  throw "openssl not found at $OpenSsl"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# SAN is required, not optional: Node rejects a certificate whose only subject is
# a Common Name, and the scenarios call https://localhost, so localhost has to be
# present as a subject alternative name.
$config = Join-Path $OutDir "openssl.cnf"
$extFile = Join-Path $OutDir "localhost.ext"

@"
[req]
distinguished_name = dn
x509_extensions    = v3_req
prompt             = no

[dn]
CN = localhost

[v3_req]
basicConstraints = critical,CA:TRUE
keyUsage         = critical,digitalSignature,keyEncipherment,keyCertSign
extendedKeyUsage = serverAuth
subjectAltName   = @alt_names

[alt_names]
DNS.1 = localhost
IP.1  = 127.0.0.1
"@ | Set-Content -LiteralPath $config -Encoding ASCII

"localhost" | Out-File -LiteralPath $extFile -Encoding ASCII

# openssl writes key-generation progress to stderr. With ErrorActionPreference
# set to Stop, PowerShell turns that stderr into a terminating error and the
# script dies halfway through writing the files, so the preference is relaxed
# for this call and the exit code is what is trusted instead.
$ErrorActionPreference = "Continue"
& $OpenSsl req -x509 -nodes -newkey rsa:2048 -days 2 `
  -keyout (Join-Path $OutDir "key.pem") `
  -out    (Join-Path $OutDir "cert.pem") `
  -config $config -extensions v3_req | Out-Null
$exitCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"

if ($exitCode -ne 0) {
  throw "openssl failed to generate the certificate (exit $exitCode)"
}

Write-Output "STEP9_CERT_READY dir=$OutDir"
