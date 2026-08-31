[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("personal", "project")]
    [string]$Scope,

    [Parameter()]
    [string]$WorkspaceRoot,

    [Parameter()]
    [switch]$MigrateKnownPredecessor
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Stop-Registration {
    param(
        [Parameter(Mandatory = $true)]
        [int]$ExitCode,

        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    [Console]::Error.WriteLine($Message)
    exit $ExitCode
}

function Get-AgentBytes {
    param(
        [Parameter(Mandatory = $true)]
        [string]$LiteralPath
    )

    return [System.IO.File]::ReadAllBytes($LiteralPath)
}

function Test-AgentBytesEqual {
    param(
        [Parameter(Mandatory = $true)]
        [byte[]]$Left,

        [Parameter(Mandatory = $true)]
        [byte[]]$Right
    )

    if ($Left.Length -ne $Right.Length) {
        return $false
    }
    for ($byteIndex = 0; $byteIndex -lt $Left.Length; $byteIndex += 1) {
        if ($Left[$byteIndex] -ne $Right[$byteIndex]) {
            return $false
        }
    }
    return $true
}

function Get-NormalizedAgentText {
    param(
        [Parameter(Mandatory = $true)]
        [byte[]]$Bytes
    )

    return [System.Text.Encoding]::UTF8.GetString($Bytes).Replace("`r`n", "`n").Replace("`r", "`n")
}

function Test-AgentTextEqual {
    param(
        [Parameter(Mandatory = $true)]
        [byte[]]$Left,

        [Parameter(Mandatory = $true)]
        [byte[]]$Right
    )

    return (Get-NormalizedAgentText -Bytes $Left) -ceq (Get-NormalizedAgentText -Bytes $Right)
}

$agentFileName = "understand-book-executor.toml"
$knownPredecessorFileName = "understand-book-executor.known-predecessor.toml"
$targetVersion = "automatic_build_executor_session.v3"
$pluginRoot = [System.IO.Path]::GetFullPath((Join-Path -Path $PSScriptRoot -ChildPath ".."))
$templatePath = Join-Path -Path $pluginRoot -ChildPath "assets/codex-agents/$agentFileName"
$knownPredecessorPath = Join-Path -Path $pluginRoot -ChildPath "assets/codex-agents/$knownPredecessorFileName"

if (-not (Test-Path -LiteralPath $templatePath -PathType Leaf)) {
    Stop-Registration -ExitCode 2 -Message "The installed executor agent template is unavailable."
}
if (-not (Test-Path -LiteralPath $knownPredecessorPath -PathType Leaf)) {
    Stop-Registration -ExitCode 2 -Message "The installed executor agent predecessor template is unavailable."
}

if ($Scope -eq "project") {
    if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
        Stop-Registration -ExitCode 2 -Message "Project registration requires an explicit absolute WorkspaceRoot."
    }
    if (-not [System.IO.Path]::IsPathRooted($WorkspaceRoot)) {
        Stop-Registration -ExitCode 2 -Message "WorkspaceRoot must be an absolute path."
    }

    try {
        $workspaceItem = Get-Item -LiteralPath $WorkspaceRoot -ErrorAction Stop
    }
    catch {
        Stop-Registration -ExitCode 2 -Message "WorkspaceRoot must name an existing directory."
    }
    if (-not $workspaceItem.PSIsContainer) {
        Stop-Registration -ExitCode 2 -Message "WorkspaceRoot must name an existing directory."
    }

    $targetDirectory = Join-Path -Path $workspaceItem.FullName -ChildPath ".codex/agents"
}
else {
    if (-not [string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
        Stop-Registration -ExitCode 2 -Message "WorkspaceRoot is valid only for project registration."
    }

    $codexHome = [Environment]::GetEnvironmentVariable("CODEX_HOME")
    if (-not [string]::IsNullOrWhiteSpace($codexHome)) {
        if (-not [System.IO.Path]::IsPathRooted($codexHome)) {
            Stop-Registration -ExitCode 2 -Message "CODEX_HOME must be an absolute path."
        }

        try {
            $personalCodexRoot = [System.IO.Path]::GetFullPath($codexHome)
        }
        catch {
            Stop-Registration -ExitCode 2 -Message "CODEX_HOME must name a valid absolute path."
        }
    }
    else {
        $userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
        if ([string]::IsNullOrWhiteSpace($userProfile)) {
            Stop-Registration -ExitCode 2 -Message "The personal Codex configuration root could not be resolved."
        }
        $personalCodexRoot = Join-Path -Path $userProfile -ChildPath ".codex"
    }
    $targetDirectory = Join-Path -Path $personalCodexRoot -ChildPath "agents"
}

$targetPath = Join-Path -Path $targetDirectory -ChildPath $agentFileName
$templateBytes = Get-AgentBytes -LiteralPath $templatePath
$knownPredecessorBytes = Get-AgentBytes -LiteralPath $knownPredecessorPath

function Write-SuccessResult {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("absent", "same", "known_predecessor")]
        [string]$SourceState,

        [Parameter()]
        [AllowNull()]
        [object]$Backup
    )

    [ordered]@{
        source_state = $SourceState
        target_version = $targetVersion
        backup = $Backup
        new_task_required = $true
    } | ConvertTo-Json -Compress
}

if (-not (Test-Path -LiteralPath $targetPath)) {
    New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
    $temporaryPath = Join-Path -Path $targetDirectory -ChildPath (".{0}.{1}.tmp" -f $agentFileName, [Guid]::NewGuid().ToString("N"))
    try {
        [System.IO.File]::Copy($templatePath, $temporaryPath, $false)
        if (-not (Test-AgentBytesEqual -Left (Get-AgentBytes -LiteralPath $temporaryPath) -Right $templateBytes)) {
            Stop-Registration -ExitCode 2 -Message "The staged executor agent template differs from the published bytes."
        }

        try {
            [System.IO.File]::Move($temporaryPath, $targetPath)
        }
        catch [System.IO.IOException] {
            if ((Test-Path -LiteralPath $targetPath -PathType Leaf) -and
                (Test-AgentTextEqual -Left (Get-AgentBytes -LiteralPath $targetPath) -Right $templateBytes)) {
                Write-SuccessResult -SourceState "same" -Backup $null
                exit 0
            }
            Stop-Registration -ExitCode 3 -Message "A different executor agent won the registration race; nothing was overwritten."
        }

        if (-not (Test-AgentBytesEqual -Left (Get-AgentBytes -LiteralPath $targetPath) -Right $templateBytes)) {
            Stop-Registration -ExitCode 2 -Message "The installed executor agent differs from the published bytes."
        }
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
    }

    Write-SuccessResult -SourceState "absent" -Backup $null
    exit 0
}

if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
    Stop-Registration -ExitCode 3 -Message "The executor agent target exists but is not a file; nothing was changed."
}

$targetBytes = Get-AgentBytes -LiteralPath $targetPath
if (Test-AgentTextEqual -Left $targetBytes -Right $templateBytes) {
    Write-SuccessResult -SourceState "same" -Backup $null
    exit 0
}

if (-not (Test-AgentTextEqual -Left $targetBytes -Right $knownPredecessorBytes)) {
    Stop-Registration -ExitCode 3 -Message "An unknown executor agent already exists at the target; nothing was changed."
}
if (-not $MigrateKnownPredecessor.IsPresent) {
    Stop-Registration -ExitCode 3 -Message "The installed executor agent is the known predecessor; explicit -MigrateKnownPredecessor consent is required."
}

$backupPath = "$targetPath.automatic_build_executor_session.v2.bak"
if (Test-Path -LiteralPath $backupPath) {
    if (-not (Test-Path -LiteralPath $backupPath -PathType Leaf) -or
        -not (Test-AgentBytesEqual -Left (Get-AgentBytes -LiteralPath $backupPath) -Right $targetBytes)) {
        Stop-Registration -ExitCode 3 -Message "The fixed executor agent backup path conflicts; the target was not changed."
    }
}
else {
    try {
        $backupStream = [System.IO.File]::Open(
            $backupPath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        try {
            $backupStream.Write($targetBytes, 0, $targetBytes.Length)
        }
        finally {
            $backupStream.Dispose()
        }
    }
    catch [System.IO.IOException] {
        if (-not (Test-Path -LiteralPath $backupPath -PathType Leaf) -or
            -not (Test-AgentBytesEqual -Left (Get-AgentBytes -LiteralPath $backupPath) -Right $targetBytes)) {
            Stop-Registration -ExitCode 3 -Message "The fixed executor agent backup path conflicts; the target was not changed."
        }
    }
}

if (-not (Test-AgentBytesEqual -Left (Get-AgentBytes -LiteralPath $backupPath) -Right $targetBytes)) {
    Stop-Registration -ExitCode 3 -Message "The executor agent backup differs from the original target; the target was not changed."
}

$migrationTemporaryPath = Join-Path -Path $targetDirectory -ChildPath (".{0}.{1}.tmp" -f $agentFileName, [Guid]::NewGuid().ToString("N"))
$replacementBackupPath = Join-Path -Path $targetDirectory -ChildPath (".{0}.{1}.replace-backup.tmp" -f $agentFileName, [Guid]::NewGuid().ToString("N"))
try {
    [System.IO.File]::Copy($templatePath, $migrationTemporaryPath, $false)
    if (-not (Test-AgentBytesEqual -Left (Get-AgentBytes -LiteralPath $migrationTemporaryPath) -Right $templateBytes)) {
        Stop-Registration -ExitCode 2 -Message "The staged executor agent template differs from the published bytes; the target was not changed."
    }
    if (-not (Test-AgentBytesEqual -Left (Get-AgentBytes -LiteralPath $targetPath) -Right $targetBytes)) {
        Stop-Registration -ExitCode 3 -Message "The executor agent target changed during migration; it was not overwritten."
    }

    try {
        [System.IO.File]::Replace($migrationTemporaryPath, $targetPath, $replacementBackupPath, $true)
    }
    catch {
        Stop-Registration -ExitCode 3 -Message "The known predecessor could not be replaced; its backup and target were preserved."
    }
}
finally {
    if (Test-Path -LiteralPath $migrationTemporaryPath -PathType Leaf) {
        Remove-Item -LiteralPath $migrationTemporaryPath -Force
    }
    if (Test-Path -LiteralPath $replacementBackupPath -PathType Leaf) {
        Remove-Item -LiteralPath $replacementBackupPath -Force
    }
}

if (-not (Test-AgentBytesEqual -Left (Get-AgentBytes -LiteralPath $targetPath) -Right $templateBytes)) {
    Stop-Registration -ExitCode 2 -Message "The migrated executor agent differs from the published bytes."
}

Write-SuccessResult -SourceState "known_predecessor" -Backup $backupPath
