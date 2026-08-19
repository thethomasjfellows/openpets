import { spawn } from "node:child_process";
import { homedir } from "node:os";

import type { CodexCommandResult, CodexCommandRunner } from "./types.js";

const maxOutputBytes = 256 * 1024;

export const defaultCodexCommandRunner: CodexCommandRunner = async (
  command,
  args,
  options = {},
) =>
  new Promise<CodexCommandResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, status: null, stdout, stderr, error: "Command timed out." });
    }, options.timeoutMs ?? 10_000);

    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      return Buffer.byteLength(next, "utf8") > maxOutputBytes
        ? next.slice(-maxOutputBytes)
        : next;
    };
    const finish = (result: CodexCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) =>
      finish({ ok: false, status: null, stdout, stderr, error: error.message }),
    );
    child.once("close", (status) =>
      finish({ ok: status === 0, status, stdout, stderr }),
    );
  });

export function sanitizeCommandSummary(result: CodexCommandResult): string {
  const text = result.error || result.stderr || result.stdout || "Command failed.";
  return text
    .replaceAll(homedir(), "~")
    .replace(/(?:[A-Za-z]:)?[\\/][^\s"']{2,}/g, "<path>")
    .replace(/bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer <redacted>")
    .replace(/\b(api[_-]?key|secret|password|token)\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}
