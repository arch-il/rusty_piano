# Runs the engine in this console; the coach API and the web page run in the background
# with their output in .dev-logs/. With -Mixed all three print here (make dev-here).
# Ctrl+C stops all three. Used by `make dev`; or run: pwsh -File scripts/dev.ps1
param([switch]$Mixed)
$root = Split-Path -Parent $PSScriptRoot

if ($Mixed) {
    $api = Start-Process uv -ArgumentList 'run', '--project', 'coach', 'coach', 'serve' -WorkingDirectory $root -NoNewWindow -PassThru
    $web = Start-Process node -ArgumentList 'node_modules/vite/bin/vite.js' -WorkingDirectory "$root/coach/web" -NoNewWindow -PassThru
    Write-Host 'Starting engine, api (http://127.0.0.1:8765) and web (http://localhost:5173). Ctrl+C stops all three (Enter stops the engine and then the rest).'
}
else {
    New-Item -ItemType Directory -Force "$root/.dev-logs" | Out-Null
    $api = Start-Process uv -ArgumentList 'run', '--project', 'coach', 'coach', 'serve' -WorkingDirectory $root -NoNewWindow -PassThru -RedirectStandardOutput "$root/.dev-logs/api.log" -RedirectStandardError "$root/.dev-logs/api.err.log"
    $web = Start-Process node -ArgumentList 'node_modules/vite/bin/vite.js' -WorkingDirectory "$root/coach/web" -NoNewWindow -PassThru -RedirectStandardOutput "$root/.dev-logs/web.log" -RedirectStandardError "$root/.dev-logs/web.err.log"
    Write-Host 'api (http://127.0.0.1:8765) and web (http://localhost:5173) run in the background, logs in .dev-logs/. Ctrl+C stops all three (Enter stops the engine and then the rest).'
}

try {
    Push-Location "$root/engine"
    cargo run --release -- --ws-port 8790
}
finally {
    Pop-Location
    foreach ($p in $api, $web) {
        if ($p -and -not $p.HasExited) {
            taskkill /T /F /PID $p.Id *> $null
        }
    }
    Write-Host 'all stopped'
}
