#!/usr/bin/env node
import { runCodexHookFromStdin } from "./hooks.js";

async function main(): Promise<void> {
  const [command] = process.argv.slice(2).filter((arg) => arg !== "--openpets-managed");
  if (command === "hook") {
    await runCodexHookFromStdin();
    return;
  }
  process.stderr.write("Usage: open-pets-codex hook --openpets-managed\n");
  process.exitCode = 2;
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
