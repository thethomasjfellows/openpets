#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  createReadStream,
  createWriteStream as createNodeWriteStream,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";

import { computeWakeBuildInputDigest } from "./build-input-digest.mjs";

const wakeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = join(wakeRoot, "openpets-voice-wake.lock.json");
const lock = JSON.parse(await readFile(lockPath, "utf8"));
const cacheRoot = join(wakeRoot, ".cache");
const archiveRoot = join(cacheRoot, "downloads");
const extractRoot = join(cacheRoot, "extracted");
const buildRoot = join(wakeRoot, "build");
const bundleParent = join(wakeRoot, "bundle");
const nativeRoot = join(wakeRoot, "native");

const requestedTarget = valueAfter("--target") ?? hostPlatformId();
if (!Object.hasOwn(lock.runtimes, requestedTarget)) {
  throw new Error(`Unsupported wake target: ${requestedTarget}`);
}
assertBuildableOnHost(requestedTarget);
await rm(join(bundleParent, `${requestedTarget}.smoke.json`), { force: true });
const buildInputSha256 = await computeWakeBuildInputDigest();

const runtime = lock.runtimes[requestedTarget];
const downloadable = [
  lock.assets.sherpaHeader,
  lock.assets.sentencepiece,
  lock.assets.nlohmannJson,
  lock.assets.keywordModel,
  lock.assets.vadModel,
  ...Object.values(lock.assets.licenses),
  runtime,
];

await mkdir(archiveRoot, { recursive: true });
await mkdir(extractRoot, { recursive: true });
for (const asset of downloadable) await downloadVerified(asset);

const sentencepieceExtract = await extractVerified(lock.assets.sentencepiece);
const jsonExtract = await extractVerified(lock.assets.nlohmannJson);
const modelExtract = await extractVerified(lock.assets.keywordModel);
const runtimeExtract = await extractVerified(runtime);

const sentencepieceSource = join(sentencepieceExtract, lock.assets.sentencepiece.root);
const keywordModelRoot = join(modelExtract, lock.assets.keywordModel.root);
const runtimeRoot = join(runtimeExtract, runtime.root);
await assertDirectory(sentencepieceSource, "SentencePiece source");
await assertDirectory(keywordModelRoot, "keyword model");
await assertDirectory(runtimeRoot, "Sherpa runtime");

const jsonInclude = await findContainingDirectory(jsonExtract, join("nlohmann", "json.hpp"));
const runtimeInclude = join(runtimeRoot, "include", "sherpa-onnx", "c-api");
await mkdir(runtimeInclude, { recursive: true });
await copyFile(
  join(archiveRoot, lock.assets.sherpaHeader.fileName),
  join(runtimeInclude, "c-api.h"),
);

const targetBuildRoot = join(buildRoot, requestedTarget);
await mkdir(targetBuildRoot, { recursive: true });

const configureArgs = [
  "-S",
  nativeRoot,
  "-B",
  targetBuildRoot,
  "-DCMAKE_BUILD_TYPE=Release",
  `-DOPENPETS_SHERPA_ONNX_ROOT=${runtimeRoot}`,
  `-DOPENPETS_SENTENCEPIECE_SOURCE=${sentencepieceSource}`,
  `-DOPENPETS_NLOHMANN_JSON_INCLUDE=${jsonInclude}`,
];
if (requestedTarget.startsWith("darwin-")) {
  configureArgs.push(`-DCMAKE_OSX_ARCHITECTURES=${runtime.cmakeArch}`);
}
if (requestedTarget.startsWith("win32-")) {
  configureArgs.push("-A", runtime.cmakeArch);
}
run("cmake", configureArgs);
run("cmake", ["--build", targetBuildRoot, "--config", "Release", "--parallel"]);

const helperFileName = requestedTarget.startsWith("win32-")
  ? "openpets-wake-helper.exe"
  : "openpets-wake-helper";
const helperBuildPath = requestedTarget.startsWith("win32-")
  ? join(targetBuildRoot, "Release", helperFileName)
  : join(targetBuildRoot, helperFileName);
await assertFile(helperBuildPath, "native wake helper");

const bundleRoot = join(bundleParent, requestedTarget);
await safeReset(bundleRoot);
await mkdir(bundleRoot, { recursive: true });

const manifestFiles = [];
const helperRelative = join("bin", helperFileName);
await copyIntoBundle(helperBuildPath, helperRelative, "helper", "openpets-helper");
if (!requestedTarget.startsWith("win32-")) {
  await chmod(join(bundleRoot, helperRelative), 0o755);
}

const runtimeLibraryPaths = [];
for (const fileName of runtime.runtimeLibraries) {
  const source = join(runtimeRoot, "lib", fileName);
  const destination = join(
    requestedTarget.startsWith("win32-") ? "bin" : "lib",
    fileName,
  );
  await copyIntoBundle(source, destination, "runtime-library", `sherpa-runtime-${requestedTarget}`);
  runtimeLibraryPaths.push(toPosix(destination));
}

const model = lock.assets.keywordModel;
const modelDestinations = {
  encoder: ["models/kws/encoder.onnx", "kws-encoder"],
  decoder: ["models/kws/decoder.onnx", "kws-decoder"],
  joiner: ["models/kws/joiner.onnx", "kws-joiner"],
  bpeModel: ["models/kws/bpe.model", "kws-bpe-model"],
  tokens: ["models/kws/tokens.txt", "kws-tokens"],
};
for (const [key, [destination, role]] of Object.entries(modelDestinations)) {
  await copyIntoBundle(
    join(keywordModelRoot, model.files[key]),
    destination,
    role,
    "kws-gigaspeech-3.3m",
  );
}
await copyIntoBundle(
  join(archiveRoot, lock.assets.vadModel.fileName),
  "models/vad/silero_vad.onnx",
  "vad-model",
  "silero-vad",
);

await copyIntoBundle(
  join(keywordModelRoot, model.files.notice),
  "licenses/kws-model-README.md",
  "notice",
  "kws-gigaspeech-3.3m",
);
const licenseSourceIds = {
  sherpaOnnx: `sherpa-runtime-${requestedTarget}`,
  onnxRuntime: `sherpa-runtime-${requestedTarget}`,
  sileroVad: "silero-vad",
};
for (const [id, license] of Object.entries(lock.assets.licenses)) {
  await copyIntoBundle(
    join(archiveRoot, license.fileName),
    join("licenses", license.fileName),
    "license",
    licenseSourceIds[id],
  );
}
await copyIntoBundle(
  join(sentencepieceSource, "LICENSE"),
  "licenses/sentencepiece-APACHE-2.0.txt",
  "license",
  "sentencepiece",
);
const jsonLicense = await findFile(jsonExtract, "LICENSE.MIT");
await copyIntoBundle(
  jsonLicense,
  "licenses/nlohmann-json-MIT.txt",
  "license",
  "nlohmann-json",
);
await copyIntoBundle(
  join(wakeRoot, "THIRD_PARTY_NOTICES.md"),
  "THIRD_PARTY_NOTICES.md",
  "notice",
  "openpets-helper",
);

const sources = [
  {
    id: "openpets-helper",
    version: lock.bundleVersion,
    url: "https://github.com/alvinunreal/openpets",
    sha256: await sha256(join(bundleRoot, helperRelative)),
    license: "MIT",
  },
  sourceRecord("sherpa-runtime-" + requestedTarget, runtime, "Apache-2.0"),
  sourceRecord("kws-gigaspeech-3.3m", model, "Apache-2.0"),
  sourceRecord("silero-vad", lock.assets.vadModel, "MIT"),
  sourceRecord("sentencepiece", lock.assets.sentencepiece, "Apache-2.0"),
  sourceRecord("nlohmann-json", lock.assets.nlohmannJson, "MIT"),
];
const provenance = {
  version: 1,
  generatedAt: "deterministic",
  target: requestedTarget,
  sherpaOnnxVersion: lock.sherpaOnnxVersion,
  buildInputSha256,
  sources,
};
const provenancePath = join(bundleRoot, "openpets-voice-wake.provenance.json");
await writeFile(provenancePath, JSON.stringify(provenance, null, 2) + "\n", "utf8");
manifestFiles.push(await describeFile(
  provenancePath,
  "openpets-voice-wake.provenance.json",
  "provenance",
  "openpets-helper",
));

manifestFiles.sort((left, right) => left.path.localeCompare(right.path));
const manifest = {
  version: 2,
  runtime: "sherpa-onnx",
  sherpaOnnxVersion: lock.sherpaOnnxVersion,
    protocolVersion: 2,
  bundleId: "openpets-sherpa",
  bundleVersion: lock.bundleVersion,
  modelId: model.modelId,
  buildInputSha256,
  platforms: {
    [requestedTarget]: {
      helper: toPosix(helperRelative),
      runtimeLibraries: runtimeLibraryPaths,
    },
  },
  keyword: {
    encoder: "models/kws/encoder.onnx",
    decoder: "models/kws/decoder.onnx",
    joiner: "models/kws/joiner.onnx",
    bpeModel: "models/kws/bpe.model",
    tokens: "models/kws/tokens.txt",
  },
  vad: { model: "models/vad/silero_vad.onnx" },
  sources,
  files: manifestFiles,
};
await writeFile(
  join(bundleRoot, "openpets-voice-wake.manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
  "utf8",
);

console.log(`Prepared verified wake bundle: ${bundleRoot}`);

async function downloadVerified(asset) {
  const destination = join(archiveRoot, asset.fileName);
  if (await fileMatches(destination, asset.sha256)) return destination;

  await mkdir(dirname(destination), { recursive: true });
  const partial = destination + ".partial";
  await rm(partial, { force: true });
  console.log(`Downloading ${asset.fileName}...`);
  const response = await fetch(asset.url, {
    redirect: "follow",
    headers: { "User-Agent": "OpenPets-voice-wake-builder" },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed for ${asset.fileName}: HTTP ${response.status}`);
  }
  await pipeline(response.body, createNodeWriteStream(partial, { flags: "wx" }));
  if (!(await fileMatches(partial, asset.sha256))) {
    await rm(partial, { force: true });
    throw new Error(`Checksum mismatch for ${asset.fileName}`);
  }
  await rm(destination, { force: true });
  await rename(partial, destination);
  return destination;
}

async function extractVerified(asset) {
  const destination = join(extractRoot, asset.sha256);
  const marker = join(destination, ".complete");
  if (await isFile(marker)) return destination;
  await safeReset(destination);
  await mkdir(destination, { recursive: true });
  run("tar", ["-xf", join(archiveRoot, asset.fileName), "-C", destination]);
  await writeFile(marker, asset.sha256 + "\n", "utf8");
  return destination;
}

async function copyIntoBundle(source, relativePath, role, sourceId) {
  await assertFile(source, relativePath);
  const normalized = toPosix(relativePath);
  const destination = join(bundleRoot, ...normalized.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  if (
    requestedTarget.startsWith("darwin-") &&
    (role === "helper" || role === "runtime-library")
  ) {
    run("codesign", ["--force", "--sign", "-", destination]);
  }
  manifestFiles.push(await describeFile(destination, normalized, role, sourceId));
}

async function describeFile(absolutePath, relativePath, role, sourceId) {
  const info = await stat(absolutePath);
  return {
    role,
    path: toPosix(relativePath),
    sha256: await sha256(absolutePath),
    bytes: info.size,
    sourceId,
  };
}

async function fileMatches(path, expected) {
  try {
    return (await sha256(path)) === expected.toLowerCase();
  } catch {
    return false;
  }
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function findContainingDirectory(root, relativeFile) {
  const found = await findFile(root, relativeFile);
  const segments = relativeFile.split(sep);
  let value = dirname(found);
  for (let index = 1; index < segments.length; index += 1) value = dirname(value);
  return value;
}

async function findFile(root, suffix) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".complete") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFile(path, suffix).catch(() => null);
      if (nested) return nested;
    } else if (entry.isFile() && (entry.name === suffix || path.endsWith(suffix))) {
      return path;
    }
  }
  throw new Error(`Could not find ${suffix} under extracted asset.`);
}

async function assertDirectory(path, label) {
  const info = await lstat(path).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Missing ${label}.`);
  }
}

async function assertFile(path, label) {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile()) throw new Error(`Missing ${label}.`);
}

async function isFile(path) {
  return (await lstat(path).catch(() => null))?.isFile() === true;
}

async function safeReset(path) {
  const absolute = resolve(path);
  const allowed = [buildRoot, bundleParent, extractRoot].some((root) => {
    const child = relative(resolve(root), absolute);
    return child.length > 0 && child !== ".." && !child.startsWith(".." + sep);
  });
  if (!allowed) throw new Error(`Refusing to reset unsafe generated path: ${absolute}`);
  await rm(absolute, { recursive: true, force: true });
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: wakeRoot,
    env: { ...process.env },
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}`);
  }
}

function sourceRecord(id, asset, license) {
  return {
    id,
    version: id.startsWith("sherpa-runtime-")
      ? lock.sherpaOnnxVersion
      : id === "sentencepiece"
        ? "0.2.1"
        : id === "nlohmann-json"
          ? "3.12.0"
          : asset.modelId ?? "pinned",
    url: asset.url,
    sha256: asset.sha256,
    license,
  };
}

function hostPlatformId() {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : "";
  if (!["darwin", "win32", "linux"].includes(process.platform) || !arch) {
    throw new Error("This host cannot build the wake helper.");
  }
  return `${process.platform}-${arch}`;
}

function assertBuildableOnHost(target) {
  const [platform, arch] = target.split("-");
  if (platform !== process.platform) {
    throw new Error(`Native helper target ${target} must be built on ${platform}; current host is ${process.platform}.`);
  }
  if (platform !== "darwin" && arch !== process.arch) {
    throw new Error(`Native helper target ${target} must be built on matching architecture ${arch}.`);
  }
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function toPosix(path) {
  return path.split(sep).join("/");
}
