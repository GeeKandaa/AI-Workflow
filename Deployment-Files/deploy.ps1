<#
.SYNOPSIS
  Activates the AI plan workflow template in this folder, then deletes this script.

.DESCRIPTION
  Run once from the workspace root after copying the contents of the template package into it:

    powershell -ExecutionPolicy Bypass -File .\deploy.ps1

  Steps (all checks run before anything is changed):
    1. Checks Node.js 18+ and git are on PATH.
    2. If a previous install exists, backs up .claude -> .claude.old and CLAUDE.md -> CLAUDE.md.old and carries
       over .claude\settings.local.json. Refuses if an archival is in progress or a backup already exists.
    3. Renames .claude-template -> .claude and CLAUDE.template.md -> CLAUDE.md.
    4. Asks whether to keep or remove .gitignore (it stops plans being committed by default). The suggested
       answer is Keep when this folder is inside a git repository (a .git found here or in any parent folder),
       otherwise Remove.
    5. Lists the discovered worktrees and runs the workflow tests.
    6. Deletes this script.

.PARAMETER GitIgnore
  Keep or Remove .gitignore without asking.

.PARAMETER Yes
  Skip the prompts: use the suggested .gitignore answer (unless -GitIgnore is given) and do not ask to confirm.

.PARAMETER SkipTests
  Do not run the workflow tests after deploying.
#>
[CmdletBinding()]
param(
  [ValidateSet('Keep', 'Remove')]
  [string]$GitIgnore,
  [switch]$Yes,
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Fail([string]$msg) {
  Write-Host "deploy: $msg" -ForegroundColor Red
  Write-Host 'Nothing was changed.' -ForegroundColor Red
  exit 1
}
function Step([string]$msg) { Write-Host "  - $msg" }
function In([string]$name) { Join-Path $root $name }

Write-Host "AI plan workflow: deploying into $root"

# --- 1. Checks (nothing is changed until all of them pass) --------------------------------------------------------

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js was not found on PATH. Install Node.js 18 or newer.' }
$nodeVersion = (& node --version).Trim()
if ($nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 18) { Fail "Node.js 18 or newer is required (found $nodeVersion)." }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'git was not found on PATH.' }

$template = In '.claude-template'
$claudeTemplate = In 'CLAUDE.template.md'
if (-not (Test-Path -LiteralPath $template -PathType Container)) { Fail ".claude-template was not found next to deploy.ps1. Copy the whole package into this folder first." }
if (-not (Test-Path -LiteralPath $claudeTemplate -PathType Leaf)) { Fail "CLAUDE.template.md was not found next to deploy.ps1. Copy the whole package into this folder first." }

$claude = In '.claude'
$claudeMd = In 'CLAUDE.md'
$upgrade = Test-Path -LiteralPath $claude
if ($upgrade) {
  if (Test-Path -LiteralPath (In '.claude.old')) { Fail '.claude.old already exists. Remove it (or finish a previous upgrade) and run deploy.ps1 again.' }
  if ((Test-Path -LiteralPath $claudeMd) -and (Test-Path -LiteralPath (In 'CLAUDE.md.old'))) { Fail 'CLAUDE.md.old already exists. Remove it and run deploy.ps1 again.' }
  if (Test-Path -LiteralPath (Join-Path $claude 'state\archive.lock.json')) { Fail 'An archival is in progress in the existing install. Finish or abort it first.' }
}

# The nearest folder, from here up to the top of the drive, that contains .git (a folder, or a file for worktrees).
$repoRoot = $null
$dir = Get-Item -LiteralPath $root
while ($dir) {
  if (Test-Path -LiteralPath (Join-Path $dir.FullName '.git')) { $repoRoot = $dir.FullName; break }
  $dir = $dir.Parent
}

if ((Split-Path -Leaf $root) -eq 'Deployment-Files') {
  Write-Host 'Warning: this folder is named "Deployment-Files". If it is the template source, do not deploy here.' -ForegroundColor Yellow
}

# Keep or remove .gitignore: -GitIgnore wins, then the user's answer, then the suggestion.
$gitignorePath = In '.gitignore'
$keepGitignore = $false
if (Test-Path -LiteralPath $gitignorePath) {
  $suggested = if ($repoRoot) { 'Keep' } else { 'Remove' }
  $choice = $GitIgnore
  if (-not $choice -and -not $Yes) {
    Write-Host ''
    Write-Host '.gitignore stops plans being committed (only plans/archive/.gitkeep is tracked).'
    if ($repoRoot) { Write-Host "This folder is inside the git repository at $repoRoot." }
    else { Write-Host 'No git repository was found in this folder or above it.' }
    while (-not $choice) {
      $hint = if ($suggested -eq 'Keep') { '[K/r]' } else { '[k/R]' }
      $answer = (Read-Host "Keep or remove .gitignore? $hint").Trim()
      if ($answer -eq '') { $choice = $suggested }
      elseif ($answer -match '^(k|keep)$') { $choice = 'Keep' }
      elseif ($answer -match '^(r|remove)$') { $choice = 'Remove' }
      else { Write-Host '  Please answer k (keep) or r (remove).' }
    }
  }
  if (-not $choice) { $choice = $suggested }
  $keepGitignore = ($choice -eq 'Keep')
}

Write-Host ''
Write-Host 'This will:'
if ($upgrade) {
  Write-Host '  - back up the existing .claude to .claude.old (keeping settings.local.json)'
  if (Test-Path -LiteralPath $claudeMd) { Write-Host '  - back up the existing CLAUDE.md to CLAUDE.md.old' }
}
Write-Host '  - rename .claude-template to .claude and CLAUDE.template.md to CLAUDE.md'
if (Test-Path -LiteralPath $gitignorePath) {
  if ($keepGitignore) { Write-Host '  - keep .gitignore' } else { Write-Host '  - delete .gitignore' }
}
Write-Host '  - delete deploy.ps1'
if (-not $Yes) {
  $answer = Read-Host 'Continue? [y/N]'
  if ($answer -notmatch '^(y|yes)$') { Fail 'Cancelled.' }
}

# --- 2. Back up a previous install ----------------------------------------------------------------------------------

Write-Host ''
if ($upgrade) {
  Rename-Item -LiteralPath $claude -NewName '.claude.old'
  Step 'backed up .claude to .claude.old'
  if (Test-Path -LiteralPath $claudeMd) { Rename-Item -LiteralPath $claudeMd -NewName 'CLAUDE.md.old'; Step 'backed up CLAUDE.md to CLAUDE.md.old' }
}

# --- 3. Activate ----------------------------------------------------------------------------------------------------

Rename-Item -LiteralPath $template -NewName '.claude'
Step 'renamed .claude-template to .claude'
Rename-Item -LiteralPath $claudeTemplate -NewName 'CLAUDE.md'
Step 'renamed CLAUDE.template.md to CLAUDE.md'

if ($upgrade) {
  $local = Join-Path (In '.claude.old') 'settings.local.json'
  if (Test-Path -LiteralPath $local) { Copy-Item -LiteralPath $local -Destination (Join-Path $claude 'settings.local.json'); Step 'carried over settings.local.json' }
}

# --- 4. .gitignore --------------------------------------------------------------------------------------------------

if (Test-Path -LiteralPath $gitignorePath) {
  if ($keepGitignore) { Step 'kept .gitignore' }
  else { Remove-Item -LiteralPath $gitignorePath -Force; Step 'deleted .gitignore' }
}

# --- 5. Verify ------------------------------------------------------------------------------------------------------

Write-Host ''
Write-Host 'Worktrees found:'
& node (Join-Path $claude 'workflow\plan.mjs') repos
if (-not $SkipTests) {
  Write-Host ''
  Write-Host 'Running the workflow tests...'
  $testOutput = & node --test (Join-Path $claude 'tests\workflow.test.mjs') 2>&1 | ForEach-Object { "$_" }
  $failLine = $testOutput | Where-Object { $_ -match '^# fail (\d+)' } | Select-Object -First 1
  if ($LASTEXITCODE -eq 0) { Write-Host '  tests passed' -ForegroundColor Green }
  else {
    Write-Host "  tests FAILED ($failLine). Run: node --test .claude\tests\workflow.test.mjs" -ForegroundColor Yellow
  }
}

# --- 6. Remove this script ------------------------------------------------------------------------------------------

Remove-Item -LiteralPath $PSCommandPath -Force
Write-Host ''
Write-Host 'Deployed. deploy.ps1 has been removed.' -ForegroundColor Green
if ($upgrade) { Write-Host 'Merge any custom settings from .claude.old\workflow\config.json by hand, then delete .claude.old and CLAUDE.md.old.' }
Write-Host 'Start Claude Code (or the plan UI) from this folder.'
