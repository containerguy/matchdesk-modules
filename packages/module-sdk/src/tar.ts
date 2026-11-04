import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * Kleiner tar.gz-Leser und -Schreiber für Modulpakete.
 *
 * Bewusst ohne Abhängigkeit: Pakete enthalten nur normale Dateien und Ordner. Symlinks,
 * Hardlinks, Geräte und Pfade außerhalb des Pakets werden abgelehnt.
 */

export type TarEntry = { path: string; data: Buffer };

export class PackageFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageFormatError";
  }
}

const BLOCK = 512;

export type ReadTarLimits = {
  maxFiles?: number;
  maxUnpackedBytes?: number;
};

function readString(buffer: Buffer, offset: number, length: number) {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end >= 0 ? end : slice.length).toString("utf8");
}

function readOctal(buffer: Buffer, offset: number, length: number) {
  const text = readString(buffer, offset, length).trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) {
    throw new PackageFormatError("Ungültige Größenangabe im Paket.");
  }
  return Number.parseInt(text, 8);
}

/** Prüft einen Pfad aus dem Archiv und gibt ihn normalisiert (mit `/`) zurück. */
export function sanitizeEntryPath(raw: string): string {
  const unified = raw.replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified)) {
    throw new PackageFormatError(`Absoluter Pfad im Paket: ${raw}`);
  }
  const normalized = path.posix.normalize(unified).replace(/\/+$/, "");
  if (normalized === "." || normalized === "") {
    return "";
  }
  if (normalized === ".." || normalized.startsWith("../") || normalized.split("/").includes("..")) {
    throw new PackageFormatError(`Pfad außerhalb des Pakets: ${raw}`);
  }
  return normalized;
}

function parsePax(data: Buffer) {
  const result: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const length = Number.parseInt(data.subarray(offset, space).toString("utf8"), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) {
      result[record.slice(0, equals)] = record.slice(equals + 1);
    }
    offset += length;
  }
  return result;
}

export function readTarGz(archive: Buffer, limits: ReadTarLimits = {}): TarEntry[] {
  const maxFiles = limits.maxFiles ?? 2000;
  const maxUnpacked = limits.maxUnpackedBytes ?? 100 * 1024 * 1024;
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: maxUnpacked + 1024 * 1024 });
  } catch {
    throw new PackageFormatError("Paket ist kein gültiges .tgz-Archiv.");
  }

  const entries: TarEntry[] = [];
  let offset = 0;
  let unpacked = 0;
  let pendingPath: string | undefined;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const name = readString(header, 0, 100);
    const prefix = header.subarray(257, 263).toString("latin1").startsWith("ustar") ? readString(header, 345, 155) : "";
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) {
      throw new PackageFormatError("Paket ist abgeschnitten.");
    }
    const data = tar.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x") {
      const pax = parsePax(data);
      if (pax.path) pendingPath = pax.path;
      continue;
    }
    if (type === "g") {
      continue;
    }
    if (type === "L") {
      pendingPath = readString(data, 0, data.length);
      continue;
    }

    const fullName = pendingPath ?? (prefix ? `${prefix}/${name}` : name);
    pendingPath = undefined;

    if (type === "5") {
      sanitizeEntryPath(fullName);
      continue;
    }
    if (type !== "0" && type !== "\0" && type !== "7") {
      throw new PackageFormatError(`Nicht erlaubter Eintrag im Paket (Typ ${type}): ${fullName}`);
    }

    const entryPath = sanitizeEntryPath(fullName);
    if (!entryPath) continue;
    unpacked += size;
    if (unpacked > maxUnpacked) {
      throw new PackageFormatError("Paket ist entpackt zu groß.");
    }
    entries.push({ path: entryPath, data: Buffer.from(data) });
    if (entries.length > maxFiles) {
      throw new PackageFormatError("Paket enthält zu viele Dateien.");
    }
  }

  return stripCommonRoot(entries);
}

/** npm pack legt alles unter `package/` ab; diesen gemeinsamen Ordner entfernen wir. */
function stripCommonRoot(entries: TarEntry[]): TarEntry[] {
  if (entries.length === 0) return entries;
  if (entries.some((entry) => entry.path === "manifest.json")) return entries;
  const first = entries[0].path.split("/")[0];
  if (!entries.every((entry) => entry.path.startsWith(`${first}/`))) return entries;
  return entries.map((entry) => ({ ...entry, path: entry.path.slice(first.length + 1) }));
}

function writeOctal(header: Buffer, value: number, offset: number, length: number) {
  header.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length, "latin1");
}

/** Erzeugt ein ustar-Archiv (gzip). Wird für Tests und das Build-Werkzeug des SDK genutzt. */
export function createTarGz(files: Array<{ path: string; data: Buffer | string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const entryPath = sanitizeEntryPath(file.path);
    const data = typeof file.data === "string" ? Buffer.from(file.data, "utf8") : file.data;
    const header = Buffer.alloc(BLOCK, 0);
    let name = entryPath;
    let prefix = "";
    if (Buffer.byteLength(name) > 100) {
      const cut = entryPath.lastIndexOf("/", 155);
      prefix = entryPath.slice(0, cut);
      name = entryPath.slice(cut + 1);
      if (cut <= 0 || Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) {
        throw new PackageFormatError(`Pfad zu lang: ${entryPath}`);
      }
    }
    header.write(name, 0, 100, "utf8");
    writeOctal(header, 0o644, 100, 8);
    writeOctal(header, 0, 108, 8);
    writeOctal(header, 0, 116, 8);
    writeOctal(header, data.length, 124, 12);
    writeOctal(header, 0, 136, 12);
    header.fill(0x20, 148, 156);
    header.write("0", 156, 1, "latin1");
    header.write("ustar\0", 257, 6, "latin1");
    header.write("00", 263, 2, "latin1");
    header.write(prefix, 345, 155, "utf8");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "latin1");
    blocks.push(header, data);
    const padding = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (padding) blocks.push(Buffer.alloc(padding, 0));
  }
  blocks.push(Buffer.alloc(BLOCK * 2, 0));
  return gzipSync(Buffer.concat(blocks));
}
