# matchdesk-modules

Offizielle Modul-Quelle für [Matchdesk](https://github.com/containerguy/Matchdesk) (Mitspielzentrale).
Hier liegen das Modul-SDK, die offiziellen Module und die Index-Datei `matchdesk-source.json`,
aus der Matchdesk unter **Admin › Module** Module anzeigt, installiert und Updates empfiehlt.

```
packages/module-sdk/   @matchdesk/module-sdk: Typen, Build-Werkzeug, Testhilfe, CLI
modules/<id>/          ein Ordner pro Modul (Beispiel: modules/hallo)
matchdesk-source.json  Index aller veröffentlichten Versionen mit Prüfsumme (wird von der Pipeline gepflegt)
```

## Schnellstart

```bash
npm ci
npm test            # alle Tests (SDK und Module)
npm run typecheck
npm run build       # baut alle Module nach dist/<id>-<version>.tgz (+ .sha256)
npm run matchdesk-module -- build modules/hallo
```

Node 22 oder neuer.

## Aufbau eines Moduls

```
modules/<id>/
  package.json        name, version (die Modulversion), Abhängigkeiten
  module.json         Manifest ohne version und matchdeskApi
  src/server.ts       export function register(ctx: ModuleContext) { ... }
  src/client.tsx      export default function (host) { return { Page, Admin }; }
  src/settings.ts     export const settings = z.object({ ... })   (optional)
  migrations/         0001_beschreibung.sql, 0002_... (nur Tabellen mit Präfix <id>_)
  uninstall.sql       entfernt alle <id>_-Tabellen (Pflicht, sobald es Tabellen gibt)
  i18n/de.json, en.json
  assets/             statische Dateien (optional)
  test/               Vitest-Tests mit createTestModule
```

Regeln, die Build und Kern prüfen:

- Modul-ID: `[a-z][a-z0-9]{1,31}`, keine Unterstriche. Tabellen heißen `<id>_…`, Rechte `<id>.…`.
- Der Server wird mit allen Abhängigkeiten zu einer Datei `server.mjs` gebündelt, nur `node:*` bleibt extern.
  Native Addons (`.node`) sind nicht erlaubt; für die Datenbank nimmt das Modul `ctx.db`.
- Der Client bekommt React vom Kern (`react`, `react/jsx-runtime`, `react-dom` werden ersetzt).
  `react-dom/client` ist verboten, Module rendern nicht selbst.
- Einstellungen stehen entweder in `src/settings.ts` (zod, wird zum JSON-Schema) oder als JSON-Schema in
  `module.json`, nicht beides. Matchdesk baut daraus das Formular unter Admin › Module.
- Geheimnisse (`secrets` im Manifest) liest das Modul mit `ctx.env(name)`; nicht angemeldete Namen werfen einen Fehler.

### Rechte

Module melden ihre Rechte im Manifest an, vergeben werden sie im Kern (pro Benutzer, global oder pro Event):

```json
"permissions": [
  { "key": "hallo.view", "label": { "de": "Pinnwand ansehen", "en": "View board" }, "defaultRoles": ["user"] },
  { "key": "hallo.post", "label": { "de": "Notizen anheften", "en": "Pin notes" }, "defaultRoles": ["organizer"], "scopable": true }
]
```

`defaultRoles` nennt die niedrigste Rolle, höhere Rollen erben das Recht; Admins dürfen immer alles.
Im Server prüft das Modul mit `ctx.can(user, "hallo.post", { mainEventId })`.

### Server-Kontext `ctx`

`router` (Express, gemountet unter `/api/m/<id>`), `currentUser(req)`, `requireWrite(req, res)`, `can`,
`settings.get()`, `env`, `db`, `audit`, `push.toUsers`, `realtime.broadcast`, `http.fetch`, `schedule`,
`on` (Kern-Ereignisse) und `onStop`. Die Typen stehen in `packages/module-sdk/src/index.ts`.
CSRF für schreibende Anfragen prüft der Kern vor dem Modul.

### Testen

```ts
import { createTestModule } from "@matchdesk/module-sdk/testing";
import path from "node:path";
import request from "supertest";
import { register } from "../src/server";

const mod = await createTestModule({ moduleDir: path.resolve(import.meta.dirname, ".."), register });
await request(mod.app).get("/api/m/hallo/notes").set("x-test-user", "anna").expect(200);
mod.grant("anna", "hallo.post", "event-1");
await mod.stop();
```

Die Testhilfe baut SQLite im Speicher mit den Kerntabellen `users`, `main_events`, `game_events`, spielt die
Migrationen des Moduls ein und zeichnet Push, Realtime und Audit auf (`mod.pushes`, `mod.broadcasts`, `mod.audits`).

## Veröffentlichen

1. Version in `modules/<id>/package.json` erhöhen und auf `main` mergen (CI baut und testet jeden PR).
2. Tag `<id>-v<version>` pushen, z. B. `git tag hallo-v1.0.0 && git push origin hallo-v1.0.0`.
3. Die Pipeline `.github/workflows/release.yml` baut das Paket, prüft die Version gegen den Tag, legt ein
   GitHub-Release mit `.tgz` und `.sha256` an und trägt die Version mit Prüfsumme in `matchdesk-source.json`
   auf `main` ein.

Eine veröffentlichte Version wird nie überschrieben: `index-add` lehnt dieselbe Version mit anderer Prüfsumme ab.
Matchdesk zeigt neue Versionen als Update-Empfehlung, eingespielt wird per Knopf.

## Eigene Modul-Quellen

Jedes Git-Repo mit einer `matchdesk-source.json` im Wurzelverzeichnis kann in Matchdesk als Quelle eingetragen
werden. Am einfachsten forkt man dieses Repo oder übernimmt SDK und Pipeline. Pakete müssen über HTTPS erreichbar
sein; für private Repos nennt man in Matchdesk den Namen einer Umgebungsvariablen `MATCHDESK_SOURCE_TOKEN_…`,
deren Token nur an den Host der Quelle geschickt wird. Drittquellen zeigt Matchdesk mit deutlicher Warnung an.

## Lizenz

GPL-3.0, wie Matchdesk.
