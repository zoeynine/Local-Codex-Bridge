import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { VERSION, UPSTREAM_LAUNCHER_VERSION } from "../src/version.js";

const rootFile = (relativePath: string): string =>
  fileURLToPath(new URL(`../../${relativePath}`, import.meta.url));

test("package, platform and changelog version anchors match the canonical code version", () => {
  const packageJson = JSON.parse(readFileSync(rootFile("package.json"), "utf8")) as {
    version?: unknown;
  };
  const packageLock = JSON.parse(readFileSync(rootFile("package-lock.json"), "utf8")) as {
    version?: unknown;
    packages?: Record<string, { version?: unknown }>;
  };
  const infoPlist = readFileSync(
    rootFile("Start Mac Codex Bridge.app/Contents/Info.plist"),
    "utf8",
  );
  const changelog = readFileSync(rootFile("CHANGELOG.md"), "utf8");
  for (const readme of ["README.md", "README.zh-CN.md"]) {
    assert.ok(readFileSync(rootFile(readme), "utf8").includes(`**Current release: V${VERSION}**`), `${readme} current release drifted`);
  }
  const escapedVersion = VERSION.replace(/\./g, "\\.");
  const launcherVersion = UPSTREAM_LAUNCHER_VERSION.replace(/\./g, "\\.");
  const buildVersion = UPSTREAM_LAUNCHER_VERSION.split(".").join("");

  assert.equal(packageJson.version, VERSION, "package.json version drifted");
  assert.equal(packageLock.version, VERSION, "package-lock.json root version drifted");
  assert.equal(
    packageLock.packages?.[""]?.version,
    VERSION,
    "package-lock.json packages[''] version drifted",
  );
  assert.match(
    infoPlist,
    new RegExp(`<key>CFBundleShortVersionString</key>\\s*<string>${launcherVersion}</string>`),
    "macOS short version drifted",
  );
  assert.match(
    infoPlist,
    new RegExp(`<key>CFBundleVersion</key>\\s*<string>${buildVersion}</string>`),
    "macOS build version drifted",
  );
  assert.match(
    changelog,
    new RegExp(`当前本地候选版本为 \\*\\*V${escapedVersion}\\*\\*`),
    "CHANGELOG current-version marker drifted",
  );
  assert.match(
    changelog,
    new RegExp(`^## V${escapedVersion}[^\\r\\n]*\\r?\\n\\r?\\n- `, "m"),
    "CHANGELOG has no populated section heading for the canonical version",
  );
});
