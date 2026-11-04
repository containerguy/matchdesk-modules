import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { build as esbuild, type Plugin } from "esbuild";
import { z } from "zod";
import { MATCHDESK_MODULE_API, moduleManifestSchema, type ModuleManifest } from "./manifest";
import { createTarGz } from "./tar";

/**
 * Baut ein Modulpaket aus einem Modulordner:
 *
 *   module.json        Manifest ohne `version` und `matchdeskApi`
 *   package.json       `version` des Moduls
 *   src/server.ts      -> server.mjs (alle Abhängigkeiten gebündelt, nur Node-Builtins extern)
 *   src/client.tsx     -> client.mjs (React kommt zur Laufzeit vom Kern)
 *   src/settings.ts    -> `settings` (zod) wird zum JSON-Schema im Manifest
 *   migrations/, uninstall.sql, i18n/, assets/ werden unverändert übernommen
 */

export class BuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildError";
  }
}

export type BuildResult = {
  manifest: ModuleManifest;
  file: string;
  fileName: string;
  sha256: string;
  size: number;
  files: string[];
};

const REACT_SHIM = `const R = globalThis.__matchdesk && globalThis.__matchdesk.React;
if (!R) throw new Error("Matchdesk stellt React nicht bereit (globalThis.__matchdesk fehlt).");
export default R;
export const Children = R.Children, Component = R.Component, Fragment = R.Fragment, PureComponent = R.PureComponent,
  StrictMode = R.StrictMode, Suspense = R.Suspense, cloneElement = R.cloneElement, createContext = R.createContext,
  createElement = R.createElement, createRef = R.createRef, forwardRef = R.forwardRef, isValidElement = R.isValidElement,
  lazy = R.lazy, memo = R.memo, startTransition = R.startTransition, use = R.use, useCallback = R.useCallback,
  useContext = R.useContext, useDebugValue = R.useDebugValue, useDeferredValue = R.useDeferredValue,
  useEffect = R.useEffect, useId = R.useId, useImperativeHandle = R.useImperativeHandle,
  useInsertionEffect = R.useInsertionEffect, useLayoutEffect = R.useLayoutEffect, useMemo = R.useMemo,
  useReducer = R.useReducer, useRef = R.useRef, useState = R.useState, useSyncExternalStore = R.useSyncExternalStore,
  useTransition = R.useTransition;`;

const JSX_SHIM = `import R from "react";
function withKey(props, key) { return key === undefined ? props : Object.assign({}, props, { key }); }
export const Fragment = R.Fragment;
export function jsx(type, props, key) { return R.createElement(type, withKey(props, key)); }
export const jsxs = jsx;
export const jsxDEV = jsx;`;

const REACT_DOM_SHIM = `const D = globalThis.__matchdesk && globalThis.__matchdesk.ReactDOM;
if (!D) throw new Error("Matchdesk stellt ReactDOM nicht bereit.");
export default D;
export const createPortal = D.createPortal, flushSync = D.flushSync;`;

/** React, ReactDOM und die JSX-Runtime kommen vom Kern, damit es nur eine React-Instanz gibt. */
function sharedReactPlugin(): Plugin {
  const shims: Record<string, string> = {
    react: REACT_SHIM,
    "react/jsx-runtime": JSX_SHIM,
    "react/jsx-dev-runtime": JSX_SHIM,
    "react-dom": REACT_DOM_SHIM
  };
  return {
    name: "matchdesk-shared-react",
    setup(build) {
      build.onResolve({ filter: /^(react|react\/jsx-runtime|react\/jsx-dev-runtime|react-dom)$/ }, (args) => ({
        path: args.path,
        namespace: "matchdesk-shared"
      }));
      build.onResolve({ filter: /^react-dom\/client$/ }, () => ({
        errors: [{ text: "Module rendern nicht selbst: react-dom/client ist nicht erlaubt." }]
      }));
      build.onLoad({ filter: /.*/, namespace: "matchdesk-shared" }, (args) => ({
        contents: shims[args.path],
        loader: "js",
        resolveDir: process.cwd()
      }));
    }
  };
}

function nativeAddonGuard(): Plugin {
  return {
    name: "matchdesk-no-native",
    setup(build) {
      build.onLoad({ filter: /\.node$/ }, (args) => ({
        errors: [{ text: `Native Addons sind in Modulen nicht erlaubt: ${args.path}` }]
      }));
    }
  };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new BuildError(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function findEntry(dir: string, base: string) {
  for (const ext of [".ts", ".tsx", ".mts", ".js", ".mjs", ".jsx"]) {
    const candidate = path.join(dir, "src", `${base}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function walk(dir: string, prefix: string, out: Array<{ path: string; data: Buffer }>) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) walk(full, relative, out);
    else if (entry.isFile()) out.push({ path: relative, data: fs.readFileSync(full) });
    else throw new BuildError(`Nur normale Dateien erlaubt: ${full}`);
  }
}

async function bundle(entry: string, kind: "server" | "client") {
  const result = await esbuild({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: kind === "server" ? "node" : "browser",
    target: kind === "server" ? "node22" : "es2022",
    jsx: "automatic",
    minify: kind === "client",
    legalComments: "inline",
    logLevel: "silent",
    // Server: Abhängigkeiten werden gebündelt, nur Node-Builtins bleiben extern.
    external: kind === "server" ? ["node:*"] : [],
    banner:
      kind === "server"
        ? { js: 'import { createRequire as __mdCreateRequire } from "node:module"; const require = __mdCreateRequire(import.meta.url);' }
        : undefined,
    plugins: kind === "client" ? [sharedReactPlugin(), nativeAddonGuard()] : [nativeAddonGuard()]
  }).catch((error: { errors?: Array<{ text: string; location?: { file: string; line: number } | null }> }) => {
    const details = (error.errors ?? []).map((item) => `${item.location ? `${item.location.file}:${item.location.line}: ` : ""}${item.text}`);
    throw new BuildError(`Bündeln von ${path.basename(entry)} fehlgeschlagen:\n${details.join("\n") || String(error)}`);
  });
  return Buffer.from(result.outputFiles[0].contents);
}

/** Lädt `settings` (zod) aus src/settings.ts und wandelt es in ein JSON-Schema. */
async function settingsJsonSchema(entry: string) {
  const bundled = await esbuild({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
    external: ["zod"]
  });
  // Neben der Quelle ablegen, damit Node `zod` aus den node_modules des Moduls auflöst
  // (outDir kann außerhalb des Repos liegen, z. B. $RUNNER_TEMP).
  const tmp = path.join(path.dirname(entry), `.settings-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(tmp, bundled.outputFiles[0].contents);
  try {
    const loaded = (await import(pathToFileURL(tmp).href)) as { settings?: unknown };
    if (!(loaded.settings instanceof z.ZodType)) {
      throw new BuildError("src/settings.ts muss `export const settings = z.object({...})` exportieren.");
    }
    const schema = z.toJSONSchema(loaded.settings as z.ZodType, { io: "input" }) as Record<string, unknown>;
    delete schema.$schema;
    // Rundreise prüfen: Der Kern liest das Schema mit z.fromJSONSchema.
    z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
    return schema;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export async function buildModule(moduleDir: string, options: { outDir?: string } = {}): Promise<BuildResult> {
  const dir = path.resolve(moduleDir);
  const outDir = path.resolve(options.outDir ?? path.join(dir, "dist"));
  fs.mkdirSync(outDir, { recursive: true });

  const pkg = readJson(path.join(dir, "package.json")) as { version?: string };
  const source = readJson(path.join(dir, "module.json")) as Record<string, unknown>;
  if ("version" in source || "matchdeskApi" in source) {
    throw new BuildError("module.json enthält weder version (kommt aus package.json) noch matchdeskApi (kommt vom SDK).");
  }

  const files: Array<{ path: string; data: Buffer }> = [];
  const serverEntry = findEntry(dir, "server");
  const clientEntry = findEntry(dir, "client");
  const settingsEntry = findEntry(dir, "settings");

  if (serverEntry) files.push({ path: "server.mjs", data: await bundle(serverEntry, "server") });
  if (clientEntry) files.push({ path: "client.mjs", data: await bundle(clientEntry, "client") });

  const draft: Record<string, unknown> = {
    ...source,
    version: pkg.version,
    matchdeskApi: MATCHDESK_MODULE_API,
    ...(serverEntry ? { server: "server.mjs" } : {}),
    ...(clientEntry ? { client: "client.mjs" } : {})
  };
  if (settingsEntry) {
    if (source.settings) throw new BuildError("Einstellungen entweder in module.json oder in src/settings.ts, nicht beides.");
    draft.settings = await settingsJsonSchema(settingsEntry);
  }

  const parsed = moduleManifestSchema.safeParse(draft);
  if (!parsed.success) {
    throw new BuildError(
      `Manifest ungültig:\n${parsed.error.issues.map((issue) => `- ${issue.path.join(".") || "(Wurzel)"}: ${issue.message}`).join("\n")}`
    );
  }
  const manifest = parsed.data;

  const migrationsDir = path.join(dir, "migrations");
  if (fs.existsSync(migrationsDir)) {
    for (const name of fs.readdirSync(migrationsDir)) {
      if (!/^\d{4}_[a-z0-9_-]+\.sql$/.test(name)) {
        throw new BuildError(`Migration ${name}: Name im Format 0001_beschreibung.sql`);
      }
    }
  }
  if (manifest.tables.length > 0 && !fs.existsSync(path.join(dir, "uninstall.sql"))) {
    throw new BuildError("Module mit Tabellen brauchen eine uninstall.sql.");
  }

  walk(migrationsDir, "migrations", files);
  walk(path.join(dir, "i18n"), "i18n", files);
  walk(path.join(dir, "assets"), "assets", files);
  if (fs.existsSync(path.join(dir, "uninstall.sql"))) {
    files.push({ path: "uninstall.sql", data: fs.readFileSync(path.join(dir, "uninstall.sql")) });
  }
  if (fs.existsSync(path.join(dir, "openapi.yaml"))) {
    files.push({ path: "openapi.yaml", data: fs.readFileSync(path.join(dir, "openapi.yaml")) });
  }
  files.unshift({ path: "manifest.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) });

  const archive = createTarGz(files);
  const fileName = `${manifest.id}-${manifest.version}.tgz`;
  const file = path.join(outDir, fileName);
  fs.writeFileSync(file, archive);
  const sha256 = createHash("sha256").update(archive).digest("hex");
  fs.writeFileSync(`${file}.sha256`, `${sha256}  ${fileName}\n`);
  return { manifest, file, fileName, sha256, size: archive.length, files: files.map((entry) => entry.path) };
}
