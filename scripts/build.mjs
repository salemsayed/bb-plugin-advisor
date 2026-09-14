import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const manifest = readJson("package.json");
const builderVersion = manifest.devDependencies["bb-app"];
const sdkVersion = manifest.devDependencies["@get-bb/plugin-sdk"];

function checkNoVendoredSdk() {
  for (const directory of ["types", "vendor"]) {
    assert.ok(
      !existsSync(join(root, directory)),
      `Unexpected ${directory}/: Advisor uses the npm SDK, not vendored declarations.`,
    );
  }
}

checkNoVendoredSdk();
for (const dependency of ["bb-app", "@get-bb/plugin-sdk"]) {
  assert.equal(
    readJson(`node_modules/${dependency}/package.json`).version,
    manifest.devDependencies[dependency],
    `${dependency} must match its exact package.json pin. Run npm ci.`,
  );
}

// BB entrypoints normally re-exec BB_CLI. Builds must use the locked builder,
// even when npm is launched inside a newer (or older) desktop BB session.
const env = { ...process.env };
delete env.BB_CLI;
for (const args of [["plugin", "types", "--check"], ["plugin", "build"]]) {
  const result = spawnSync(
    process.execPath,
    [join(root, "node_modules/bb-app/dist/bb.js"), ...args],
    { cwd: root, env, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

checkNoVendoredSdk();
for (const entry of ["app", "server"]) {
  const metadata = readJson(`dist/${entry}.meta.json`);
  assert.equal(metadata.sdkVersion, sdkVersion, `${entry} SDK version drifted.`);
  assert.equal(metadata.builtWith.pluginSdkVersion, sdkVersion);
  assert.equal(metadata.builtWith.bbVersion, builderVersion, `${entry} builder version drifted.`);
}
console.log(`Verified BB ${builderVersion} / SDK ${sdkVersion}; no vendored SDK files.`);
