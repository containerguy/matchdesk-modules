#!/usr/bin/env -S npx tsx
import fs from "node:fs";
import path from "node:path";
import { buildModule, BuildError } from "./build";
import { createHash } from "node:crypto";
import { addRelease, describeModule, readIndex, writeIndex } from "./source-index";
import { moduleManifestSchema } from "./manifest";
import { readTarGz } from "./tar";

/**
 * matchdesk-module build <modulordner> [--out dist]
 * matchdesk-module build-all [--modules modules] [--out dist]
 * matchdesk-module release <modulordner> --expect-version 1.2.3 [--out dist]
 *     baut für einen Release-Tag und prüft die Version gegen den Tag
 * matchdesk-module index-add dist/<id>-<version>.tgz --url-base <URL> [--index matchdesk-source.json]
 *     trägt ein veröffentlichtes Paket in die Index-Datei ein
 */

function option(args: string[], name: string, fallback?: string) {
  const position = args.indexOf(name);
  if (position >= 0 && args[position + 1]) return args[position + 1];
  return fallback;
}

async function main(argv: string[]) {
  const [command, ...args] = argv;
  const positional = args.filter((arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"));

  if (command === "build") {
    if (!positional[0]) throw new BuildError("Aufruf: matchdesk-module build <modulordner>");
    const result = await buildModule(positional[0], { outDir: option(args, "--out") });
    console.log(`${describeModule(result.manifest)} -> ${result.file}\nsha256 ${result.sha256} (${result.size} Bytes)`);
    return;
  }

  if (command === "build-all") {
    const modulesDir = path.resolve(option(args, "--modules", "modules")!);
    const outDir = path.resolve(option(args, "--out", "dist")!);
    const dirs = fs
      .readdirSync(modulesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(modulesDir, entry.name, "module.json")))
      .map((entry) => path.join(modulesDir, entry.name));
    for (const dir of dirs) {
      const result = await buildModule(dir, { outDir });
      console.log(`${describeModule(result.manifest)} -> ${result.fileName} sha256 ${result.sha256}`);
    }
    return;
  }

  if (command === "release") {
    // Baut das Modul für einen Release-Tag <id>-v<version> und prüft, dass Tag und package.json passen.
    if (!positional[0]) throw new BuildError("Aufruf: matchdesk-module release <modulordner> --expect-version x.y.z");
    const expected = option(args, "--expect-version");
    const result = await buildModule(positional[0], { outDir: option(args, "--out", "dist") });
    if (expected && expected !== result.manifest.version) {
      throw new BuildError(`Tag nennt Version ${expected}, package.json hat ${result.manifest.version}.`);
    }
    console.log(`${describeModule(result.manifest)} -> ${result.file}\nsha256 ${result.sha256}`);
    return;
  }

  if (command === "index-add") {
    // Trägt ein veröffentlichtes Paket in die Index-Datei ein (Manifest und Prüfsumme aus dem Paket).
    if (!positional[0]) throw new BuildError("Aufruf: matchdesk-module index-add <paket.tgz> --url-base <url>");
    const indexFile = path.resolve(option(args, "--index", "matchdesk-source.json")!);
    const urlBase = option(args, "--url-base");
    if (!urlBase) throw new BuildError("--url-base fehlt (z. B. https://github.com/<owner>/<repo>/releases/download)");
    const archive = fs.readFileSync(positional[0]);
    const manifestEntry = readTarGz(archive).find((entry) => entry.path === "manifest.json");
    if (!manifestEntry) throw new BuildError("Paket ohne manifest.json");
    const manifest = moduleManifestSchema.parse(JSON.parse(manifestEntry.data.toString("utf8")));
    const tag = `${manifest.id}-v${manifest.version}`;
    const sha256 = createHash("sha256").update(archive).digest("hex");
    const index = addRelease(readIndex(indexFile), {
      manifest,
      url: `${urlBase.replace(/\/+$/, "")}/${tag}/${path.basename(positional[0])}`,
      sha256,
      changelog: option(args, "--changelog")
    });
    writeIndex(indexFile, index);
    console.log(`${describeModule(manifest)} eingetragen in ${indexFile}\nsha256 ${sha256}`);
    return;
  }

  if (command === "check-index") {
    const indexFile = path.resolve(positional[0] ?? "matchdesk-source.json");
    const index = readIndex(indexFile);
    console.log(`${indexFile}: ${index.modules.length} Module, ${index.modules.reduce((sum, module) => sum + module.versions.length, 0)} Versionen`);
    return;
  }

  throw new BuildError("Befehle: build <ordner> | build-all | release <ordner> --expect-version x.y.z | index-add <paket.tgz> --url-base <url> | check-index [datei]");
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
