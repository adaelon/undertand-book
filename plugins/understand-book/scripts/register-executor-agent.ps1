[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("personal", "project")]
    [string]$Scope,

    [Parameter()]
    [string]$WorkspaceRoot
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

$agentFileName = "understand-book-executor.toml"
$pluginRoot = [System.IO.Path]::GetFullPath((Join-Path -Path $PSScriptRoot -ChildPath ".."))
$templatePath = Join-Path -Path $pluginRoot -ChildPath "assets/codex-agents/$agentFileName"

if (-not (Test-Path -LiteralPath $templatePath -PathType Leaf)) {
    Stop-Registration -ExitCode 2 -Message "The installed executor agent template is unavailable."
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

    $resolvedWorkspaceRoot = $workspaceItem.FullName
    $targetDirectory = Join-Path -Path $resolvedWorkspaceRoot -ChildPath ".codex/agents"
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

function Get-AgentDigest {
    param(
        [Parameter(Mandatory = $true)]
        [string]$LiteralPath
    )

    $stream = [System.IO.File]::OpenRead($LiteralPath)
    try {
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
            $hash = $sha256.ComputeHash($stream)
        }
        finally {
            $sha256.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }

    return ([System.BitConverter]::ToString($hash)).Replace("-", "").ToLowerInvariant()
}

$targetPath = Join-Path -Path $targetDirectory -ChildPath $agentFileName
$templateDigest = Get-AgentDigest -LiteralPath $templatePath

function Write-SuccessResult {
    [pscustomobject]@{
        digest = $templateDigest
        scope = $Scope
        target = $targetPath
        activation = "new_task_required"
    } | ConvertTo-Json -Compress
}

if (Test-Path -LiteralPath $targetPath) {
    if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
        Stop-Registration -ExitCode 3 -Message "The executor agent target exists but is not a file; nothing was changed."
    }
    if ((Get-AgentDigest -LiteralPath $targetPath) -eq $templateDigest) {
        Write-SuccessResult
        exit 0
    }

    Stop-Registration -ExitCode 3 -Message "A different executor agent already exists at the target; nothing was changed."
}

New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
$temporaryPath = Join-Path -Path $targetDirectory -ChildPath (".{0}.{1}.tmp" -f $agentFileName, [Guid]::NewGuid().ToString("N"))

try {
    [System.IO.File]::Copy($templatePath, $temporaryPath, $false)
    if ((Get-AgentDigest -LiteralPath $temporaryPath) -ne $templateDigest) {
        Stop-Registration -ExitCode 2 -Message "The staged executor agent template failed its digest check."
    }

    try {
        [System.IO.File]::Move($temporaryPath, $targetPath)
    }
    catch [System.IO.IOException] {
        if ((Test-Path -LiteralPath $targetPath -PathType Leaf) -and
            ((Get-AgentDigest -LiteralPath $targetPath) -eq $templateDigest)) {
            Write-SuccessResult
            exit 0
        }

        Stop-Registration -ExitCode 3 -Message "A different executor agent won the registration race; nothing was overwritten."
    }
}
finally {
    if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
        Remove-Item -LiteralPath $temporaryPath -Force
    }
}

Write-SuccessResult
