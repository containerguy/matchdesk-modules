import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import React from "react";
import * as ReactDOM from "react-dom";
import { renderToStaticMarkup } from "react-dom/server";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildModule, BuildError } from "../src/build";
import { moduleManifestSchema } from "../src/manifest";
import { addRelease } from "../src/source-index";
import { readTarGz } from "../src/tar";
import { createTestModule } from "../src/testing";

const root = path.resolve(import.meta.dirname, "../../..");
const halloDir = path.join(root, "modules/hallo");
const temps: string[] = [];

function tempDir() {
  const dir = path.join(os.tmpdir(), `md-sdk-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  delete (globalThis as { __matchdesk?: unknown }).__matchdesk;
});

function fakeModule(files: Record<string, string>) {
  const dir = tempDir();
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

describe("matchdesk-module build", () => {
  it("baut das Hallo-Modul zu einem Paket, das der Kern annimmt", async () => {
    const out = tempDir();
    const result = await buildModule(halloDir, { outDir: out });
    const archive = fs.readFileSync(result.file);
    expect(createHash("sha256").update(archive).digest("hex")).toBe(result.sha256);
    expect(fs.readFileSync(`${result.file}.sha256`, "utf8")).toBe(`${result.sha256}  hallo-1.0.1.tgz\n`);

    const entries = readTarGz(archive);
    expect(entries.map((entry) => entry.path).sort()).toEqual(
      ["client.mjs", "i18n/de.json", "i18n/en.json", "manifest.json", "migrations/0001_notes.sql", "server.mjs", "uninstall.sql"].sort()
    );
    const manifest = moduleManifestSchema.parse(JSON.parse(entries.find((entry) => entry.path === "manifest.json")!.data.toString()));
    expect(manifest).toEqual(
      expect.objectContaining({ id: "hallo", version: "1.0.1", matchdeskApi: 1, server: "server.mjs", client: "client.mjs" })
    );
    // Einstellungen aus zod: der Kern liest sie mit z.fromJSONSchema und füllt Vorgaben
    const validator = z.fromJSONSchema(manifest.settings as Parameters<typeof z.fromJSONSchema>[0]);
    expect(validator.safeParse({ greeting: "Hi", maxNotes: 5, notifyOnPost: true }).success).toBe(true);
    expect(validator.safeParse({ greeting: "", maxNotes: 5, notifyOnPost: true }).success).toBe(false);
    expect((manifest.settings as { properties: Record<string, { default?: unknown }> }).properties.maxNotes.default).toBe(20);

    // Gleiches Paket bei gleichem Quelltext (Prüfsumme bleibt stabil)
    const again = await buildModule(halloDir, { outDir: tempDir() });
    expect(again.sha256).toBe(result.sha256);
  });

  it("bündelt React nicht mit, sondern nimmt es vom Kern", async () => {
    const out = tempDir();
    const result = await buildModule(halloDir, { outDir: out });
    const client = readTarGz(fs.readFileSync(result.file)).find((entry) => entry.path === "client.mjs")!.data.toString();
    expect(client).not.toContain("react.production");
    expect(client).not.toContain("__SECRET_INTERNALS");
    const file = path.join(out, "client-test.mjs");
    fs.writeFileSync(file, client);
    (globalThis as { __matchdesk?: unknown }).__matchdesk = { React, ReactDOM, matchdeskApi: 1 };
    const factory = (await import(pathToFileURL(file).href)).default as (host: unknown) => { Page: React.ComponentType<Record<string, unknown>> };
    const definition = factory({
      id: "hallo",
      version: "1.0.0",
      matchdeskApi: 1,
      React,
      locale: "de",
      t: (key: string) => key,
      api: () => new Promise(() => undefined),
      onRealtime: () => () => undefined
    });
    expect(renderToStaticMarkup(React.createElement(definition.Page, { path: "", subPath: "", user: { id: "u", username: "anna", role: "user" }, permissions: [] }))).toContain("…");
  });

  it("liefert ein lauffähiges server.mjs", async () => {
    const out = tempDir();
    const result = await buildModule(halloDir, { outDir: out });
    const server = readTarGz(fs.readFileSync(result.file)).find((entry) => entry.path === "server.mjs")!.data;
    const file = path.join(out, "server-test.mjs");
    fs.writeFileSync(file, server);
    const { register } = await import(pathToFileURL(file).href);
    const module = await createTestModule({ moduleDir: halloDir, register });
    const response = await request(module.app).get("/api/m/hallo/notes").set("x-test-user", "anna").expect(200);
    expect(response.body.greeting).toBe("Hallo und willkommen!");
    await module.stop();
  });

  it("meldet Fehler im Modul verständlich", async () => {
    const withVersion = fakeModule({
      "package.json": JSON.stringify({ version: "1.0.0" }),
      "module.json": JSON.stringify({ id: "kaputt", name: "Kaputt", version: "1.0.0" })
    });
    await expect(buildModule(withVersion, { outDir: tempDir() })).rejects.toThrow(/weder version/);

    const badPermission = fakeModule({
      "package.json": JSON.stringify({ version: "1.0.0" }),
      "module.json": JSON.stringify({ id: "kaputt", name: "Kaputt", permissions: [{ key: "andere.recht", label: "x" }] })
    });
    await expect(buildModule(badPermission, { outDir: tempDir() })).rejects.toThrow(/muss mit kaputt\. beginnen/);

    const noUninstall = fakeModule({
      "package.json": JSON.stringify({ version: "1.0.0" }),
      "module.json": JSON.stringify({ id: "kaputt", name: "Kaputt", tables: ["kaputt_daten"] }),
      "migrations/0001_init.sql": "CREATE TABLE kaputt_daten (id TEXT);"
    });
    await expect(buildModule(noUninstall, { outDir: tempDir() })).rejects.toThrow(/uninstall\.sql/);

    const reactDomClient = fakeModule({
      "package.json": JSON.stringify({ version: "1.0.0" }),
      "module.json": JSON.stringify({ id: "kaputt", name: "Kaputt" }),
      "src/client.tsx": 'import { createRoot } from "react-dom/client"; export default () => ({ x: createRoot });'
    });
    await expect(buildModule(reactDomClient, { outDir: tempDir() })).rejects.toBeInstanceOf(BuildError);

    const badMigration = fakeModule({
      "package.json": JSON.stringify({ version: "1.0.0" }),
      "module.json": JSON.stringify({ id: "kaputt", name: "Kaputt" }),
      "migrations/init.sql": "SELECT 1;"
    });
    await expect(buildModule(badMigration, { outDir: tempDir() })).rejects.toThrow(/0001_beschreibung/);
  });
});

describe("Index-Datei", () => {
  const manifest = moduleManifestSchema.parse({ id: "hallo", name: "Hallo", version: "1.0.0", matchdeskApi: 1 });

  it("trägt Versionen sortiert ein und lehnt veränderte Pakete ab", () => {
    const base = { matchdeskSource: 1 as const, modules: [] };
    const first = addRelease(base, { manifest, url: "https://x/hallo-v1.0.0/hallo-1.0.0.tgz", sha256: "a".repeat(64) });
    const second = addRelease(first, {
      manifest: { ...manifest, version: "1.1.0" },
      url: "https://x/hallo-v1.1.0/hallo-1.1.0.tgz",
      sha256: "b".repeat(64)
    });
    expect(second.modules[0].versions.map((version) => version.version)).toEqual(["1.1.0", "1.0.0"]);
    expect(addRelease(second, { manifest, url: "egal", sha256: "a".repeat(64) })).toBe(second);
    expect(() => addRelease(second, { manifest, url: "egal", sha256: "c".repeat(64) })).toThrow(/unveränderlich/);
  });
});
