import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildCodexHookReviewCommandFile, buildCodexHookReviewShellScript, createCodexHookReviewLaunchPlans } from "../src/codex-hook-review.js";

describe("Codex hook review terminal launch", () => {
  it("opens a short-lived command file in macOS Terminal without Automation access", () => {
    const commandFile = "/tmp/openpets-codex-review.command";
    const [plan] = createCodexHookReviewLaunchPlans({ platform: "darwin", codexCommand: "/opt/homebrew/bin/codex", home: "/Users/example", path: "/opt/homebrew/bin:/usr/bin", macCommandFile: commandFile });
    assert.equal(plan?.command, "/usr/bin/open");
    const commandText = plan?.args.join(" ") ?? "";
    assert.match(commandText, /Terminal/);
    assert.match(commandText, /openpets-codex-review\.command/);
    const contents = buildCodexHookReviewCommandFile({ codexCommand: "/opt/homebrew/bin/codex", home: "/Users/example", path: "/opt/homebrew/bin:/usr/bin", commandFile });
    assert.match(contents, /\/hooks/);
    assert.match(contents, /rm -f/);
    assert.doesNotMatch(contents, /hooks\.state/);
  });

  it("opens a visible interactive command window on Windows", () => {
    const plans = createCodexHookReviewLaunchPlans({ platform: "win32", codexCommand: "codex.cmd", home: "C:\\Users\\Example", path: "C:\\Tools", windowsComSpec: "C:\\Windows\\System32\\cmd.exe", windowsPowerShell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" });
    const [plan, fallback] = plans;
    assert.equal(plan?.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.match(plan?.args.join(" ") ?? "", /Restarting Codex/);
    assert.equal(plan?.detached, true);
    assert.equal(plan?.windowsHide, false);
    assert.equal(fallback?.command, "C:\\Windows\\System32\\cmd.exe");
  });

  it("prefers a configured Linux terminal and provides safe fallbacks", () => {
    const plans = createCodexHookReviewLaunchPlans({ platform: "linux", codexCommand: "codex", home: "/home/example", path: "/usr/local/bin:/usr/bin", terminal: "kitty" });
    assert.equal(plans[0]?.command, "kitty");
    assert.ok(plans.some((plan) => plan.command === "x-terminal-emulator"));
    assert.match(plans[0]?.args.join(" ") ?? "", /\/hooks/);
  });

  it("rejects command injection characters that require a second shell line", () => {
    assert.throws(() => buildCodexHookReviewShellScript({ codexCommand: "codex\nrm -rf /", home: "/home/example", path: "/usr/bin" }), /invalid/);
  });

  it("quotes apostrophes in user paths without creating a second command", () => {
    const script = buildCodexHookReviewShellScript({ codexCommand: "codex", home: "/Users/O'Neil", path: "/usr/bin" });
    assert.match(script, /O'\\''Neil/);
    assert.doesNotMatch(script, /hooks\.state/);
  });

  it("restarts Codex in the same shell when a self-update changes its version", { skip: process.platform === "win32" }, () => {
    const root = mkdtempSync(join(tmpdir(), "openpets-codex-review-test-"));
    try {
      const fakeCodex = join(root, "codex");
      writeFileSync(join(root, "version"), "codex 1\n");
      writeFileSync(join(root, "launches"), "0\n");
      writeFileSync(fakeCodex, `#!/bin/sh
if [ "$1" = "--version" ]; then cat "$OPENPETS_TEST_ROOT/version"; exit 0; fi
launches=$(cat "$OPENPETS_TEST_ROOT/launches")
launches=$((launches + 1))
printf '%s\\n' "$launches" > "$OPENPETS_TEST_ROOT/launches"
if [ "$launches" -eq 1 ]; then printf 'codex 2\\n' > "$OPENPETS_TEST_ROOT/version"; fi
exit 0
`);
      chmodSync(fakeCodex, 0o700);
      const script = buildCodexHookReviewShellScript({ codexCommand: fakeCodex, home: root, path: "/usr/bin:/bin" });
      execFileSync("/bin/sh", ["-c", script], { env: { ...process.env, OPENPETS_TEST_ROOT: root } });
      assert.equal(readFileSync(join(root, "launches"), "utf8").trim(), "2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
