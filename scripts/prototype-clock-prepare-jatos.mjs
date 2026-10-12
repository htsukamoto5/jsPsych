import { execFileSync } from "node:child_process";
// Prepare a disposable JATOS study without modifying the adapter repository.
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sibling = resolve(process.argv[2] ?? resolve(root, "../jspsych-multiplayer"));
function sourceRevision(repo) {
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", `safe.directory=${repo.replaceAll("\\", "/")}`, "-C", repo, ...args],
      {
        encoding: "utf8",
        windowsHide: true,
      }
    ).trim();
  if (git("status", "--porcelain", "--untracked-files=normal")) {
    throw new Error(`Commit or isolate source changes before packaging: ${repo}`);
  }
  return { commit: git("rev-parse", "HEAD"), branch: git("branch", "--show-current") };
}
const sources = { jspsych: sourceRevision(root), multiplayer: sourceRevision(sibling) };
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const dirName = "shared-clock-prototype";
const output = resolve(root, "dist", dirName);
mkdirSync(output, { recursive: true });
const core = readFileSync(resolve(root, "packages/jspsych/dist/index.browser.js"), "utf8");
if (!core.includes("calibration_in_progress")) throw new Error("Build prototype core first");
writeFileSync(resolve(output, "jspsych.js"), core, "utf8");
const html = readFileSync(resolve(root, "examples/multiplayer-clock.html"), "utf8")
  .replace("../packages/jspsych/dist/index.browser.js", "jspsych.js")
  .replace("<head>", '<head>\n    <script src="jatos.js"></script>');
writeFileSync(resolve(output, "index.html"), html, "utf8");
const demo = readFileSync(resolve(root, "examples/multiplayer-clock.js"), "utf8").replace(
  'params.get("backend") === "jatos"',
  "true"
);
writeFileSync(resolve(output, "multiplayer-clock.js"), demo, "utf8");
copyFileSync(
  resolve(root, "examples/multiplayer-clock-schedule.js"),
  resolve(output, "multiplayer-clock-schedule.js")
);

// Build exactly the inspected TypeScript sources. Existing sibling dist was stale.
const files = {
  adapter: "packages/adapter-multiplayer-jatos/src/index.ts",
  "@jspsych-multiplayer/utils": "packages/utils/src/index.ts",
  "./sealed-key": "packages/adapter-multiplayer-jatos/src/sealed-key.ts",
};
const modules = Object.entries(files)
  .map(([id, path]) => {
    const source = readFileSync(resolve(sibling, path), "utf8");
    const code = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText;
    return `${JSON.stringify(id)}: function(require,module,exports) {\n${code}\n}`;
  })
  .join(",\n");
const bundle = `var jsPsychAdapterMultiplayerJatos = (() => {
  const modules = {${modules}}; const cache = {};
  function require(id) { if (cache[id]) return cache[id].exports;
    if (!modules[id]) throw new Error("Unexpected dependency: " + id);
    const module = cache[id] = { exports: {} }; modules[id](require,module,module.exports);
    return module.exports; }
  return require("adapter").default;
})();\n`;
writeFileSync(resolve(output, "adapter-multiplayer-jatos.js"), bundle, "utf8");
const metadata = {
  version: "3",
  data: {
    uuid: randomUUID(),
    title: "Shared clock prototype (disposable)",
    description:
      "Fixed-reference calibration, shared countdown and future software reveal. No paid study integration.",
    groupStudy: true,
    linearStudy: false,
    allowPreview: false,
    dirName,
    comments: "",
    jsonData: null,
    endRedirectUrl: null,
    studyEntryMsg: null,
    componentList: [
      {
        uuid: randomUUID(),
        title: "Clock demonstration",
        htmlFilePath: "index.html",
        reloadable: false,
        active: true,
        comments: "",
        jsonData: null,
      },
    ],
    batchList: [
      {
        uuid: randomUUID(),
        title: "Prototype two-member groups",
        active: true,
        maxActiveMembers: 2,
        maxTotalMembers: 2,
        maxTotalWorkers: null,
        allowedWorkerTypes: ["Jatos", "GeneralSingle", "GeneralMultiple"],
        comments: null,
        jsonData: null,
      },
    ],
  },
};
writeFileSync(resolve(root, "dist", `${dirName}.jas`), JSON.stringify(metadata, null, 2), "utf8");
const manifest = {
  generatedAtUtc: new Date().toISOString(),
  sources,
  environment: { node: process.version, platform: process.platform, typescript: ts.version },
  policy: {
    defaultMaxSampleAgeMs: 30000,
    explicitLongRoundMaxSampleAgeMs: 75000,
    maxUncertaintyMs: 50,
    modeledRelativeDriftPpm: 200,
    calibrationTimeoutMs: 10000,
    samples: 5,
    attempts: 8,
  },
  inputSha256: Object.fromEntries(
    Object.values(files).map((path) => [path, sha256(resolve(sibling, path))])
  ),
  assetSha256: Object.fromEntries(
    [
      "jspsych.js",
      "index.html",
      "multiplayer-clock.js",
      "multiplayer-clock-schedule.js",
      "adapter-multiplayer-jatos.js",
    ].map((path) => [path, sha256(resolve(output, path))])
  ),
  metadataSha256: sha256(resolve(root, "dist", `${dirName}.jas`)),
  validation: { realJatos: "pending", twoMachine: "pending", physicalDisplayOnset: "not measured" },
};
writeFileSync(resolve(output, "build-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
console.log(`Prepared ${output}\nMetadata: dist/${dirName}.jas`);
if (process.platform === "win32") {
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      resolve(root, "scripts/prototype-clock-archive.ps1"),
    ],
    {
      stdio: "inherit",
      windowsHide: true,
    }
  );
} else {
  execFileSync("python3", ["-m", "zipfile", "-c", `${dirName}.jzip`, `${dirName}.jas`, dirName], {
    cwd: resolve(root, "dist"),
    stdio: "inherit",
  });
}
const archive = {
  ...manifest,
  archive: `${dirName}.jzip`,
  archiveSha256: sha256(resolve(root, "dist", `${dirName}.jzip`)),
};
writeFileSync(
  resolve(root, "dist", `${dirName}.manifest.json`),
  JSON.stringify(archive, null, 2),
  "utf8"
);
console.log(`SHA-256: ${archive.archiveSha256}\nManifest: dist/${dirName}.manifest.json`);
