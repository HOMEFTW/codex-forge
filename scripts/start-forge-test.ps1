$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$profile=Join-Path $root 'output\native-forge'
$homeDir=Join-Path $profile 'codex-home'
New-Item -ItemType Directory -Path $homeDir -Force | Out-Null
$fixture=@'
model = "gpt-6.1-sol"
model_provider = "fixture"
cli_auth_credentials_store = "file"
[model_providers.fixture]
name = "Isolated local fixture"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
requires_openai_auth = false
'@
[IO.File]::WriteAllText((Join-Path $homeDir 'config.toml'),$fixture,[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $homeDir 'auth.json'),'{"OPENAI_API_KEY":"isolated-fixture-not-a-real-key"}',[Text.UTF8Encoding]::new($false))
& node (Join-Path $root 'cli\forge.mjs') install (Join-Path $root 'examples\hello-forge') --home (Join-Path $homeDir 'forge')
Start-Process -FilePath (Join-Path $root 'release\package-full\CodexForge.exe') -ArgumentList ('--profile "'+$profile+'" --debug-port 9322') -WindowStyle Hidden
