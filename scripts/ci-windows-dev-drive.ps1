# Windows CI: put TEMP on a Dev Drive (ReFS in dev-drive mode) for the test step.
#
# The coding-agent suite creates and removes tens of thousands of temp files, git repositories and
# per-file agent directories. A Dev Drive is the volume Windows provides for exactly that workload;
# it also keeps that churn off the system volume, where the runner's own background services were
# saturating the disk during test stalls (disk queue 8-17). Every later step of the job sees
# TEMP/TMP pointing at R:\temp. Any failure here fails the step: tests never run on a half-made drive.
$ErrorActionPreference = "Stop"

$vhd = Join-Path $env:RUNNER_TEMP "pi-dev-drive.vhdx"
$script = Join-Path $env:RUNNER_TEMP "pi-dev-drive.diskpart"
@"
create vdisk file="$vhd" maximum=25600 type=expandable
select vdisk file="$vhd"
attach vdisk
create partition primary
assign letter=R
"@ | Set-Content -Encoding ascii $script
diskpart /s $script
if ($LASTEXITCODE -ne 0) { throw "diskpart failed with exit code $LASTEXITCODE" }

Format-Volume -DriveLetter R -DevDrive -Confirm:$false -Force | Out-Null
fsutil devdrv trust R:
if ($LASTEXITCODE -ne 0) { throw "fsutil devdrv trust failed with exit code $LASTEXITCODE" }
fsutil devdrv query R:

New-Item -ItemType Directory -Force -Path "R:\temp" | Out-Null
Add-Content -Path $env:GITHUB_ENV -Value "TEMP=R:\temp"
Add-Content -Path $env:GITHUB_ENV -Value "TMP=R:\temp"
Write-Host "TEMP and TMP now point at the Dev Drive R:\temp"
