import fs from "node:fs";
import { compareVersions, localize, sourceIndexSchema, type ModuleManifest, type SourceIndex } from "./manifest";

export function readIndex(file: string): SourceIndex {
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { matchdeskSource: 1, modules: [] };
  return sourceIndexSchema.parse(raw);
}

export function writeIndex(file: string, index: SourceIndex) {
  fs.writeFileSync(file, `${JSON.stringify(sourceIndexSchema.parse(index), null, 2)}\n`);
}

/**
 * Trägt eine veröffentlichte Version in die Index-Datei ein. Dieselbe Version mit anderer
 * Prüfsumme wird abgelehnt: Matchdesk verlässt sich darauf, dass Versionen unveränderlich sind.
 */
export function addRelease(
  index: SourceIndex,
  input: { manifest: ModuleManifest; url: string; sha256: string; publishedAt?: string; changelog?: string }
): SourceIndex {
  const { manifest } = input;
  const modules = [...index.modules];
  const position = modules.findIndex((module) => module.id === manifest.id);
  const existing = position >= 0 ? modules[position] : undefined;
  const already = existing?.versions.find((version) => version.version === manifest.version);
  if (already) {
    if (already.sha256 !== input.sha256) {
      throw new Error(
        `${manifest.id} ${manifest.version} ist schon mit anderer Prüfsumme veröffentlicht. Versionen sind unveränderlich, bitte Version erhöhen.`
      );
    }
    return index;
  }
  const entry = {
    version: manifest.version,
    matchdeskApi: manifest.matchdeskApi,
    url: input.url,
    sha256: input.sha256,
    publishedAt: input.publishedAt ?? new Date().toISOString(),
    ...(input.changelog ? { changelog: input.changelog.slice(0, 4000) } : {})
  };
  const updated = {
    id: manifest.id,
    name: manifest.name,
    ...(manifest.description ? { description: manifest.description } : {}),
    versions: [...(existing?.versions ?? []), entry].sort((a, b) => compareVersions(b.version, a.version))
  };
  if (position >= 0) modules[position] = updated;
  else modules.push(updated);
  modules.sort((a, b) => a.id.localeCompare(b.id));
  return { ...index, modules };
}

export function describeModule(manifest: ModuleManifest) {
  return `${manifest.id} ${manifest.version} (${localize(manifest.name, "de")})`;
}
