$ErrorActionPreference = 'Stop'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) {
    throw 'Native tests need Visual Studio C++ Build Tools (or compile pedal.test.cpp with another C++ compiler).'
}
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $installation) { throw 'Visual Studio C++ compiler not installed.' }
$vcvars = Join-Path $installation 'VC\Auxiliary\Build\vcvars64.bat'
$output = Join-Path $PSScriptRoot '.build'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$source = Join-Path $PSScriptRoot 'pedal.test.cpp'
$command = 'call "{0}" >nul && cd /d "{1}" && cl /nologo /std:c++17 /EHsc /W4 /WX /D_CRT_SECURE_NO_WARNINGS "{2}" /Fe:pedal.test.exe && pedal.test.exe' -f $vcvars, $output, $source
& $env:ComSpec /c $command
if ($LASTEXITCODE -ne 0) { throw "Pedal tests failed (exit $LASTEXITCODE)." }
