#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

import { computeWakeBuildInputDigest } from "./build-input-digest.mjs";

const wakeRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const lock = JSON.parse(
  await readFile(join(wakeRoot, "openpets-voice-wake.lock.json"), "utf8"),
);
const target = valueAfter("--target") ?? hostPlatformId();
if (
  target !== hostPlatformId() &&
  !(process.platform === "darwin" && target.startsWith("darwin-"))
) {
  throw new Error("Native wake smoke tests must run on their target operating system.");
}

const bundleRoot = join(wakeRoot, "bundle", target);
const manifest = JSON.parse(
  await readFile(
    join(bundleRoot, "openpets-voice-wake.manifest.json"),
    "utf8",
  ),
);
const platform = manifest.platforms[target];
if (!platform) throw new Error(`Wake bundle does not contain ${target}.`);
const buildInputSha256 = await computeWakeBuildInputDigest();
if (manifest.buildInputSha256 !== buildInputSha256) {
  throw new Error("Wake bundle was not prepared from the current helper build inputs.");
}

const helper = join(bundleRoot, ...platform.helper.split("/"));
  const args = [
    "--protocol",
    "2",
  "--kws-encoder",
  bundlePath(manifest.keyword.encoder),
  "--kws-decoder",
  bundlePath(manifest.keyword.decoder),
  "--kws-joiner",
  bundlePath(manifest.keyword.joiner),
  "--kws-bpe-model",
  bundlePath(manifest.keyword.bpeModel),
  "--kws-tokens",
  bundlePath(manifest.keyword.tokens),
  "--vad-model",
  bundlePath(manifest.vad.model),
];

await verifyUnsupportedPhraseRecovery();
await verifyConfiguredPhraseReadiness(
  "HEY PEDRO",
  Array.from({ length: 15 }, (_, index) => index % 2 === 0 ? "HAY PEDRO" : "HEY PAY DRO"),
);

const child = spawn(helper, args, {
  cwd: bundleRoot,
  env: helperEnvironment(),
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
let stdout = "";
let stderr = "";
const events = [];
let parseFailure = null;
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  while (true) {
    const newline = stdout.indexOf("\n");
    if (newline < 0) break;
    const line = stdout.slice(0, newline).replace(/\r$/, "");
    stdout = stdout.slice(newline + 1);
    try {
      const event = JSON.parse(line);
      assert.equal(event.version, 2);
      events.push(event);
    } catch (error) {
      parseFailure = error;
    }
  }
});
child.stderr.on("data", (chunk) => {
  stderr = (stderr + chunk).slice(-8_192);
});

try {
  // The official fixture says “LIGHT UP”. Keep that only as an optional
  // learned variant so this smoke proves protocol v2 aliases reach native KWS.
  await writeCommand({ version: 2, type: "configure", phrase: "TURN ON THE LIGHT", variants: ["LIGHT UP"] });
  await waitFor(() => events.some((event) => event.type === "ready"), 60_000);

  const fixture = join(
    wakeRoot,
    ".cache",
    "extracted",
    lock.assets.keywordModel.sha256,
    lock.assets.keywordModel.root,
    lock.assets.keywordModel.files.positiveFixture,
  );
  const wav = decodeMonoPcm16(await readFile(fixture));
  assert.equal(wav.sampleRate, 16_000, "official KWS fixture must be 16 kHz");
  for (let offset = 0; offset < wav.samples.length; offset += 320) {
    await writePcm(wav.samples.subarray(offset, Math.min(offset + 320, wav.samples.length)));
  }
  const silence = new Float32Array(16_000);
  for (let offset = 0; offset < silence.length; offset += 320) {
    await writePcm(silence.subarray(offset, offset + 320));
  }

  await waitFor(() => events.some((event) => event.type === "keyword"), 20_000);
  await waitFor(
    () => events.some((event) => event.type === "vad" && event.state === "speech-start"),
    20_000,
  );
  await waitFor(
    () => events.some((event) => event.type === "vad" && event.state === "speech-end"),
    20_000,
  );

  const keywordCount = events.filter((event) => event.type === "keyword").length;
    await writeCommand({ version: 2, type: "reset" });
  for (let offset = 0; offset < silence.length; offset += 320) {
    await writePcm(silence.subarray(offset, offset + 320));
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  assert.equal(
    events.filter((event) => event.type === "keyword").length,
    keywordCount,
    "silence after reset must not trigger the keyword",
  );

  await writeCommand({ version: 2, type: "stop" });
  child.stdin.end();
  const [code, signal] = await once(child, "exit");
  assert.equal(signal, null);
  assert.equal(code, 0, `helper exit failed; stderr: ${stderr}`);
  assert.equal(parseFailure, null);
  assert.equal(
    events.some((event) => event.type === "error"),
    false,
    `helper emitted an error: ${JSON.stringify(events)}`,
  );
  await writeFile(
    join(wakeRoot, "bundle", `${target}.smoke.json`),
    `${JSON.stringify({
      version: 1,
      target,
      manifestSha256: await sha256(join(bundleRoot, "openpets-voice-wake.manifest.json")),
      helperSha256: await sha256(helper),
      buildInputSha256,
      testedPlatform: process.platform,
      testedArch: process.arch,
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  console.log(
    `Native wake smoke passed for ${target}: unsupported-phrase recovery, HEY PEDRO readiness with 15 alternatives, keyword, VAD start/end, reset, silence, stop.`,
  );
} catch (error) {
  try {
    child.kill("SIGKILL");
  } catch {
  }
  throw error;
}

async function verifyUnsupportedPhraseRecovery() {
  const probe = spawn(helper, args, {
    cwd: bundleRoot,
    env: helperEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let probeStdout = "";
  let probeStderr = "";
  probe.stdout.setEncoding("utf8");
  probe.stderr.setEncoding("utf8");
  probe.stdout.on("data", (chunk) => { probeStdout = (probeStdout + chunk).slice(-8_192); });
  probe.stderr.on("data", (chunk) => { probeStderr = (probeStderr + chunk).slice(-8_192); });
  probe.stdin.end(JSON.stringify({ version: 2, type: "configure", phrase: "\u{10FFFF}", variants: [] }) + "\n");
  const [code, signal] = await once(probe, "exit");
  assert.equal(signal, null);
  assert.equal(code, 2, `unsupported phrase exit failed; stderr: ${probeStderr}`);
  const lines = probeStdout.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, `unsupported phrase output was invalid: ${probeStdout}`);
  const event = JSON.parse(lines[0]);
  assert.equal(event.version, 2);
  assert.equal(event.type, "error");
  assert.equal(event.code, "phrase-not-supported");
}

async function verifyConfiguredPhraseReadiness(phrase, variants = []) {
  const probe = spawn(helper, args, {
    cwd: bundleRoot,
    env: helperEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let probeStdout = "";
  let probeStderr = "";
  probe.stdout.setEncoding("utf8");
  probe.stderr.setEncoding("utf8");
  probe.stdout.on("data", (chunk) => { probeStdout = (probeStdout + chunk).slice(-8_192); });
  probe.stderr.on("data", (chunk) => { probeStderr = (probeStderr + chunk).slice(-8_192); });
  probe.stdin.end(
    JSON.stringify({ version: 2, type: "configure", phrase, variants }) + "\n"
      + JSON.stringify({ version: 2, type: "stop" }) + "\n",
  );
  const [code, signal] = await once(probe, "exit");
  assert.equal(signal, null);
  assert.equal(code, 0, `${phrase} readiness probe failed; stderr: ${probeStderr}`);
  const events = probeStdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(events.some((event) => event.version === 2 && event.type === "ready"), true, `${phrase} did not become ready`);
  assert.equal(events.some((event) => event.type === "error"), false, `${phrase} emitted an error`);
}

async function writePcm(samples) {
  const bytes = Buffer.allocUnsafe(samples.length * 4);
  for (let index = 0; index < samples.length; index += 1) {
    bytes.writeFloatLE(samples[index], index * 4);
  }
  await writeCommand({
    version: 2,
    type: "pcm",
    sampleRate: 16_000,
    channels: 1,
    format: "f32le",
    capturedAt: Date.now(),
    samplesBase64: bytes.toString("base64"),
  });
}

async function writeCommand(command) {
  const line = JSON.stringify(command) + "\n";
  if (child.stdin.write(line, "utf8")) return;
  await once(child.stdin, "drain");
}

async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  while (!predicate()) {
    if (parseFailure) throw parseFailure;
    if (child.exitCode !== null) {
      throw new Error(`Wake helper exited early with ${child.exitCode}; stderr: ${stderr}`);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `Timed out waiting for helper event. Events: ${JSON.stringify(events)}; stderr: ${stderr}`,
      );
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

function decodeMonoPcm16(buffer) {
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(buffer.toString("ascii", 8, 12), "WAVE");
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const bytes = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      format = {
        encoding: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bits: buffer.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      data = buffer.subarray(start, start + bytes);
    }
    offset = start + bytes + (bytes % 2);
  }
  assert.ok(format && data, "fixture WAV chunks are missing");
  assert.deepEqual(
    { encoding: format.encoding, channels: format.channels, bits: format.bits },
    { encoding: 1, channels: 1, bits: 16 },
  );
  const samples = new Float32Array(data.length / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = data.readInt16LE(index * 2) / 32_768;
  }
  return { sampleRate: format.sampleRate, samples };
}

function bundlePath(relativePath) {
  return join(bundleRoot, ...relativePath.split("/"));
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function helperEnvironment() {
  const env = { LANG: "C", LC_ALL: "C" };
  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
  } else if (process.env.TMPDIR) {
    env.TMPDIR = process.env.TMPDIR;
  }
  return env;
}

function hostPlatformId() {
  if (!["darwin", "win32", "linux"].includes(process.platform)) {
    throw new Error("Unsupported smoke-test host.");
  }
  if (!["x64", "arm64"].includes(process.arch)) {
    throw new Error("Unsupported smoke-test architecture.");
  }
  return `${process.platform}-${process.arch}`;
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? null : process.argv[index + 1];
}
