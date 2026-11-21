#requires -Version 5.1
<#
.SYNOPSIS
  Read-only diagnostic for Al-Hakim Brave profile isolation and ownership locks.
.DESCRIPTION
  Does not launch, close, kill, unlock, or delete anything. Run on the Windows
  machine where the NestJS backend and Brave processes run.
.EXAMPLE
  .\scripts\verify-brave-profiles.ps1 -ProfileBasePath '.\data\brave-profiles' -SessionNames session1,session2
.NOTES
  Stale candidates are NOT authorization to delete locks. Also verify other
  backend instances, shared storage, and surviving unmarked browser processes.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $ProfileBasePath,

    [string[]] $SessionNames = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $ProfileBasePath -PathType Container)) {
    throw "Profile base path not found: $ProfileBasePath"
}
$base = (Resolve-Path -LiteralPath $ProfileBasePath).ProviderPath
$locksRoot = Join-Path $base '.openwa-profile-locks'

if ($SessionNames.Count -eq 0) {
    $fromProfiles = @(Get-ChildItem -LiteralPath $base -Directory |
        Where-Object { $_.Name -ne '.openwa-profile-locks' } |
        ForEach-Object { $_.Name })
    $fromLocks = @()
    if (Test-Path -LiteralPath $locksRoot -PathType Container) {
        $fromLocks = @(Get-ChildItem -LiteralPath $locksRoot -Directory |
            Where-Object { $_.Name -notmatch '\.recovered-' } |
            ForEach-Object { $_.Name })
    }
    $SessionNames = @($fromProfiles + $fromLocks | Sort-Object -Unique)
}
if ($SessionNames.Count -eq 0) {
    Write-Warning 'No session profile folders or lock folders were found.'
    exit 0
}

# Query once; absence of CIM access must never become "no browsers found".
$processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
$computerName = [Environment]::MachineName
$hasIssue = $false
$results = foreach ($session in $SessionNames) {
    if ($session -cnotmatch '^[a-zA-Z0-9-]{1,50}$') {
        Write-Warning "Skipping invalid session key: $session"
        $hasIssue = $true
        continue
    }
    $profilePath = [System.IO.Path]::GetFullPath((Join-Path $base $session))
    $lockPath = Join-Path $locksRoot $session
    $ownerPath = Join-Path $lockPath 'owner.json'
    $lockExists = Test-Path -LiteralPath $lockPath -PathType Container
    $owner = $null
    $ownerPid = $null
    $ownerAlive = $null
    $localOwner = $null
    if (Test-Path -LiteralPath $ownerPath -PathType Leaf) {
        try {
            $owner = Get-Content -LiteralPath $ownerPath -Raw | ConvertFrom-Json -ErrorAction Stop
            if ($null -ne $owner.pid -and $null -ne $owner.host) {
                $ownerPid = [int]$owner.pid
                $localOwner = [string]$owner.host -ieq $computerName
                if ($localOwner) {
                    $ownerAlive = @($processes | Where-Object { $_.ProcessId -eq $ownerPid }).Count -gt 0
                }
            }
        }
        catch {
            $owner = $null
        }
    }

    $sessionFlag = "--al-hakim-session=$session"
    $sessionPattern = '(?:^|\s)' + [regex]::Escape($sessionFlag) + '(?=$|\s)'
    $sessionProcesses = @($processes | Where-Object {
        $_.CommandLine -and [regex]::IsMatch($_.CommandLine, $sessionPattern)
    })

    # Match exact --user-data-dir, even if the process has no Al-Hakim marker.
    $profileProcesses = @($processes | Where-Object {
        if (-not $_.CommandLine) { return $false }
        $m = [regex]::Match($_.CommandLine, '(?:^|\s)--user-data-dir=(?:"(?<quoted>[^"]+)"|(?<plain>\S+))')
        if (-not $m.Success) { return $false }
        $candidate = if ($m.Groups['quoted'].Success) { $m.Groups['quoted'].Value } else { $m.Groups['plain'].Value }
        try { [string]::Equals([IO.Path]::GetFullPath($candidate), $profilePath, [StringComparison]::OrdinalIgnoreCase) }
        catch { $false }
    })

    $status = if (-not $lockExists) {
        if ($profileProcesses.Count -gt 0) { 'UNLOCKED_BUT_PROFILE_IN_USE' }
        else { 'UNLOCKED' }
    }
    elseif ($null -eq $owner -or $null -eq $ownerPid -or $null -eq $localOwner) {
        'LOCK_METADATA_UNVERIFIABLE'
    }
    elseif (-not $localOwner) {
        'REMOTE_OWNER_VERIFY_SEPARATELY'
    }
    elseif ($ownerAlive) {
        'ACTIVE_OWNER'
    }
    elseif ($profileProcesses.Count -gt 0 -or $sessionProcesses.Count -gt 0) {
        'DEAD_OWNER_BROWSER_PRESENT'
    }
    else {
        'STALE_CANDIDATE_REQUIRES_VERIFICATION'
    }

    if ($status -notin @('UNLOCKED', 'ACTIVE_OWNER')) { $hasIssue = $true }
    [pscustomobject]@{
        Session = $session
        LockStatus = $status
        OwnerPid = $ownerPid
        OwnerAlive = $ownerAlive
        SessionBrowserPids = (@($sessionProcesses | ForEach-Object { $_.ProcessId }) -join ',')
        ProfileUserPids = (@($profileProcesses | ForEach-Object { $_.ProcessId }) -join ',')
        ProfileExists = Test-Path -LiteralPath $profilePath -PathType Container
    }
}

$results | Format-Table -AutoSize | Out-Host
if ($hasIssue) {
    Write-Warning 'Potential ownership/recovery problems found. This diagnostic made NO changes.'
    exit 2
}
exit 0
