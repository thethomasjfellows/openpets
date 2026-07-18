export const codexHookReviewInstruction = [
  "OPENPETS CODEX SETUP - ONE FINAL APPROVAL",
  "If Codex updates first, wait. This window will restart it automatically.",
  "When 'Hooks need review' appears:",
  "- If it says exactly 6 hooks, choose '2. Trust all and continue.'",
  "- If it shows another number, choose '1. Review hooks' and approve only commands ending in --openpets-managed.",
  "If the review screen is not visible after Codex opens, type /hooks inside Codex.",
  "You are done when OpenPets returns to the front and says Connected.",
].join("\n");

export const codexHookReviewRestartInstruction = "Codex updated successfully. Restarting Codex in this same window so you can approve the OpenPets hooks...";

export interface CodexHookReviewLaunchInput {
  readonly platform: NodeJS.Platform;
  readonly codexCommand: string;
  readonly home: string;
  readonly path: string;
  readonly macCommandFile?: string;
  readonly terminal?: string;
  readonly windowsComSpec?: string;
  readonly windowsPowerShell?: string;
}

export interface CodexHookReviewLaunchPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly detached: boolean;
  readonly waitForExit: boolean;
  readonly windowsHide: boolean;
}

export function buildCodexHookReviewShellScript(input: Pick<CodexHookReviewLaunchInput, "codexCommand" | "home" | "path">): string {
  const codexCommand = validateLaunchValue(input.codexCommand, "Codex command");
  const home = validateLaunchValue(input.home, "Home path");
  const path = validateLaunchValue(input.path, "PATH", 32_768);
  const quotedCommand = quotePosix(codexCommand);
  return `cd ${quotePosix(home)} && export PATH=${quotePosix(path)} && printf '%s\\n\\n' ${quotePosix(codexHookReviewInstruction)}; while :; do openpets_codex_before="$(${quotedCommand} --version 2>/dev/null || true)"; ${quotedCommand}; openpets_codex_exit=$?; openpets_codex_after="$(${quotedCommand} --version 2>/dev/null || true)"; if [ -n "$openpets_codex_before" ] && [ -n "$openpets_codex_after" ] && [ "$openpets_codex_before" != "$openpets_codex_after" ]; then printf '\\n%s\\n\\n' ${quotePosix(codexHookReviewRestartInstruction)}; continue; fi; exit "$openpets_codex_exit"; done`;
}

export function buildCodexHookReviewCommandFile(input: Pick<CodexHookReviewLaunchInput, "codexCommand" | "home" | "path"> & { readonly commandFile: string }): string {
  const commandFile = validateLaunchValue(input.commandFile, "Command file");
  return `#!/bin/sh\nrm -f -- ${quotePosix(commandFile)}\n${buildCodexHookReviewShellScript(input)}\n`;
}

export function createCodexHookReviewLaunchPlans(input: CodexHookReviewLaunchInput): readonly CodexHookReviewLaunchPlan[] {
  const codexCommand = validateLaunchValue(input.codexCommand, "Codex command");
  const home = validateLaunchValue(input.home, "Home path");
  const path = validateLaunchValue(input.path, "PATH", 32_768);

  if (input.platform === "darwin") {
    const commandFile = validateLaunchValue(input.macCommandFile ?? "", "Command file");
    return [{
      command: "/usr/bin/open",
      args: ["-a", "Terminal", commandFile],
      detached: false,
      waitForExit: true,
      windowsHide: true,
    }];
  }

  if (input.platform === "win32") {
    const powerShell = validateLaunchValue(input.windowsPowerShell || "powershell.exe", "Windows PowerShell");
    const commandShell = validateLaunchValue(input.windowsComSpec || "cmd.exe", "Windows command shell");
    const powerShellScript = buildWindowsPowerShellScript(codexCommand, home);
    const fallbackScript = `cd /d ${quoteWindows(home)} && echo OpenPets Codex setup: approve the pending OpenPets hooks. && ${quoteWindows(codexCommand)}`;
    return [
      { command: powerShell, args: ["-NoLogo", "-NoProfile", "-NoExit", "-Command", powerShellScript], detached: true, waitForExit: false, windowsHide: false },
      { command: commandShell, args: ["/d", "/k", fallbackScript], detached: true, waitForExit: false, windowsHide: false },
    ];
  }

  if (input.platform === "linux") {
    const shellScript = buildCodexHookReviewShellScript({ codexCommand, home, path });
    const terminals = uniqueTerminals([normalizeTerminal(input.terminal), "x-terminal-emulator", "gnome-terminal", "konsole", "kitty", "alacritty", "xterm"]);
    return terminals.map((command) => ({
      command,
      args: linuxTerminalArgs(command, shellScript),
      detached: true,
      waitForExit: false,
      windowsHide: false,
    }));
  }

  return [];
}

function validateLaunchValue(value: string, label: string, maxLength = 4096): string {
  if (!value || value.length > maxLength || /[\r\n\0]/.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quoteWindows(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildWindowsPowerShellScript(codexCommand: string, home: string): string {
  const command = quotePowerShell(codexCommand);
  const instruction = quotePowerShell(codexHookReviewInstruction);
  const restartInstruction = quotePowerShell(codexHookReviewRestartInstruction);
  return `Set-Location -LiteralPath ${quotePowerShell(home)}; Write-Host ${instruction}; while ($true) { $before = ((& ${command} --version 2>$null | Out-String).Trim()); & ${command}; $status = $LASTEXITCODE; $after = ((& ${command} --version 2>$null | Out-String).Trim()); if ($before -and $after -and $before -ne $after) { Write-Host ${restartInstruction}; continue }; exit $status }`;
}

function normalizeTerminal(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4096 || /[\r\n\0]/.test(trimmed)) return undefined;
  if (trimmed.startsWith("/")) return trimmed.includes(" ") ? undefined : trimmed;
  return /^[A-Za-z0-9._+-]+$/.test(trimmed) ? trimmed : undefined;
}

function uniqueTerminals(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function linuxTerminalArgs(command: string, shellScript: string): readonly string[] {
  const name = command.split(/[\\/]/).pop()?.toLowerCase();
  if (name === "gnome-terminal") return ["--", "bash", "-lc", shellScript];
  if (name === "kitty") return ["bash", "-lc", shellScript];
  return ["-e", "bash", "-lc", shellScript];
}
