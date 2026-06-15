import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { build, Platform } from "electron-builder";

const projectRoot = resolve(import.meta.dirname, "..");
const tempOutput = join(tmpdir(), "accio-switch-release");
const releaseOutput = join(projectRoot, "release");

rmSync(tempOutput, { recursive: true, force: true });

const artifacts = await build({
  targets: Platform.WINDOWS.createTarget("portable"),
  config: {
    directories: {
      output: tempOutput,
    },
  },
});

const portable = artifacts.find((artifact) => artifact.endsWith(".exe") && basename(artifact).startsWith("Accio-Switch-"));
if (!portable) {
  throw new Error(`Portable executable was not produced. Artifacts: ${artifacts.join(", ")}`);
}

mkdirSync(releaseOutput, { recursive: true });
const destination = join(releaseOutput, basename(portable));
copyFileSync(portable, destination);
console.log(`Portable executable copied to ${destination}`);
