import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("function packaging excludes environment files while preserving traced runtime files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cmpri-function-packaging-"));
  try {
    const entry = path.join(root, ".next", "server", "app", "api", "test", "route.js");
    const manifest = path.join(root, ".vercel", "output", "functions", "test.func", ".vc-config.json");
    await mkdir(path.dirname(entry), { recursive: true });
    await mkdir(path.dirname(manifest), { recursive: true });
    await writeFile(entry, "");
    await writeFile(path.join(root, ".env.local"), "TEST_ONLY=not-a-secret");
    await writeFile(path.join(root, ".env.example"), "TEST_ONLY=placeholder");
    await writeFile(path.join(root, "runtime.js"), "export const test = true;");
    await writeFile(`${entry}.nft.json`, JSON.stringify({
      files: [".env.local", ".env.example", "runtime.js"].map((file) =>
        path.relative(path.dirname(entry), path.join(root, file))),
    }));
    await writeFile(manifest, JSON.stringify({
      filePathMap: {
        ".next/server/app/api/test/route.js": ".next/server/app/api/test/route.js",
        ".env.local": ".env.local",
        ".env.example": ".env.example",
      },
    }));
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("../scripts/prepare-vercel-output.mjs", import.meta.url)),
    ], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(await readFile(manifest, "utf8"));
    assert.equal(output.filePathMap[".env.local"], undefined);
    assert.equal(output.filePathMap[".env.example"], undefined);
    assert.equal(output.filePathMap["runtime.js"], "runtime.js");
    assert.equal(JSON.parse(result.stdout).unresolvedReferences, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Room Operations extraction packages matching Linux image binaries without altering other functions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cmpri-room-image-packaging-"));
  try {
    const functions = path.join(root, ".vercel", "output", "functions");
    const sharpRoot = path.join(root, "node_modules", "sharp");
    await mkdir(sharpRoot, { recursive: true });
    await writeFile(path.join(sharpRoot, "package.json"), JSON.stringify({
      optionalDependencies: {
        "@img/sharp-linux-x64": "0.35.5",
        "@img/sharp-libvips-linux-x64": "1.3.4",
      },
    }));
    const original = { filePathMap: { "node_modules/sharp/package.json": "node_modules/sharp/package.json" } };
    const names = ["api/room-operations/extract.func", "api/room-operations/extract.rsc.func", "unrelated.func"];
    for (const name of names) {
      await mkdir(path.join(functions, name), { recursive: true });
      await writeFile(path.join(functions, name, ".vc-config.json"), JSON.stringify(name === "unrelated.func" ? original : {
        filePathMap: { ...original.filePathMap, ".next/node_modules/sharp-test": ".next/node_modules/sharp-test" },
      }));
    }
    const command = [fileURLToPath(new URL("../scripts/prepare-vercel-output.mjs", import.meta.url))];
    let result = spawnSync(process.execPath, command, { cwd: root, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Room Operations extraction requires @img\/sharp-linux-x64/);

    for (const [name, version] of [["sharp-linux-x64", "0.35.5"], ["sharp-libvips-linux-x64", "1.3.4"]]) {
      const packageRoot = path.join(root, "node_modules", "@img", name);
      await mkdir(packageRoot, { recursive: true });
      await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ version, os: ["linux"], cpu: ["x64"] }));
      await writeFile(path.join(packageRoot, "runtime.bin"), "linux-test-fixture");
    }
    const sharpLink = path.join(root, ".next", "node_modules", "sharp-test");
    await mkdir(path.dirname(sharpLink), { recursive: true });
    await symlink(sharpRoot, sharpLink, process.platform === "win32" ? "junction" : "dir");
    result = spawnSync(process.execPath, command, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await lstat(sharpLink)).isSymbolicLink(), false);
    assert.deepEqual(JSON.parse(await readFile(path.join(sharpLink, "package.json"), "utf8")),
      JSON.parse(await readFile(path.join(sharpRoot, "package.json"), "utf8")));
    for (const name of names.slice(0, 2)) {
      const output = JSON.parse(await readFile(path.join(functions, name, ".vc-config.json"), "utf8"));
      assert.equal(output.filePathMap["node_modules/@img/sharp-linux-x64/runtime.bin"], "node_modules/@img/sharp-linux-x64/runtime.bin");
      assert.equal(output.filePathMap["node_modules/@img/sharp-libvips-linux-x64/runtime.bin"], "node_modules/@img/sharp-libvips-linux-x64/runtime.bin");
      assert.equal(output.filePathMap[".next/node_modules/sharp-test"], undefined);
      assert.equal(output.filePathMap[".next/node_modules/sharp-test/package.json"], ".next/node_modules/sharp-test/package.json");
    }
    assert.deepEqual(JSON.parse(await readFile(path.join(functions, "unrelated.func", ".vc-config.json"), "utf8")), original);

    await writeFile(path.join(root, "node_modules", "@img", "sharp-linux-x64", "package.json"),
      JSON.stringify({ version: "0.0.0", os: ["linux"], cpu: ["x64"] }));
    result = spawnSync(process.execPath, command, { cwd: root, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Incompatible Room Operations extraction dependency/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
