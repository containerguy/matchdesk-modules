import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Browser, type FrameLocator, type Page, test } from "@playwright/test";
import { buildModule } from "../packages/module-sdk/src/build";
import { freePort, startProxy } from "./support/proxy";

/**
 * Pflicht-Test für die Spiele-Anbindung, von Anfang bis Ende:
 * Hauptmenü „Spiele“ → Spieleauswahl → Billard → Herausforderung → beide spielen eingebettet
 * (kein neuer Tab) → ein Stoß kommt beim Gegner an → Aufgabe → das Ergebnis steht in Matchdesk.
 *
 * Es laufen echte Server: Matchdesk (aus MATCHDESK_DIR, mit dem frisch gebauten arena-Modul),
 * der Billard-Server (aus BILLIARD_DIR, unter /game-servers/billiard) und davor ein Reverse Proxy
 * in der Rolle des Nginx Proxy Manager, damit Matchdesk und Spiel dieselbe Adresse haben.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const MATCHDESK_DIR = path.resolve(process.env.MATCHDESK_DIR ?? path.join(repoRoot, "../Matchdesk"));
const BILLIARD_DIR = path.resolve(process.env.BILLIARD_DIR ?? path.join(repoRoot, "../matchdesk-billiard"));
const BILLIARD_PATH = "/game-servers/billiard";
const SHIFT_DIR = path.resolve(process.env.SHIFT_DIR ?? path.join(repoRoot, "../matchdesk-shift"));
const SHIFT_PATH = "/game-servers/shift";
const API_KEY = `e2e-key-${randomUUID()}`;
const WEBHOOK_SECRET = `e2e-secret-${randomUUID()}`;
const SHIFT_API_KEY = `e2e-shift-key-${randomUUID()}`;
const SHIFT_WEBHOOK_SECRET = `e2e-shift-secret-${randomUUID()}`;

let tempDir: string;
let matchdeskServer: http.Server;
let closeMatchdesk: () => Promise<void>;
let billiard: ChildProcess;
let shift: ChildProcess;
let closeProxy: () => Promise<void>;
let baseUrl: string;
const originalCwd = process.cwd();

async function waitForHttp(url: string, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server startet noch.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${url} antwortet nicht`);
}

async function login(page: Page, username: string) {
  await page.goto(`${baseUrl}/#login`);
  await page.getByLabel("Username oder E-Mail").fill(username);
  await page.getByRole("button", { name: "Code senden" }).click();
  await expect(page.getByText("Code wurde per E-Mail versendet.")).toBeVisible();
  await page.getByLabel("Einmalcode").fill("123456");
  const deviceName = page.getByLabel("Gerätename");
  if (await deviceName.isVisible()) await deviceName.fill("Browser");
  await page.getByRole("button", { name: "Einloggen" }).click();
  await page.goto(`${baseUrl}/#login/konto`);
  await expect(page.getByRole("region", { name: "Aktuelle Anmeldung" })).toContainText(username);
}

async function createUser(page: Page, username: string) {
  await page.goto(`${baseUrl}/#admin`);
  const adminPanel = page.getByLabel("Adminbereich");
  await adminPanel.getByLabel("Username").fill(username);
  await adminPanel.getByLabel("E-Mail").fill(`${username}@example.test`);
  await adminPanel.getByLabel("Rolle").first().selectOption("user");
  await adminPanel.getByRole("button", { name: "User anlegen" }).click();
  await expect(adminPanel.getByText(`${username}@example.test`)).toBeVisible();
}

async function playerPage(browser: Browser, username: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, username);
  return page;
}

/** Hauptmenü „Spiele“ → Spieleauswahl → Billard. Alles im selben Tab. */
async function openBilliardLobby(page: Page) {
  await page.goto(`${baseUrl}/#`);
  await page.getByRole("link", { name: "Spiele" }).first().click();
  await expect(page).toHaveURL(/#games$/);
  await expect(page.getByRole("heading", { name: "Spiele" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Billard/ }).getByRole("img", { name: "Billard-Logo" })).toBeVisible();
  await page.getByRole("link", { name: /Billard/ }).click();
  await expect(page).toHaveURL(/#games\/arena\/billiard$/);
  await expect(page.getByRole("heading", { name: "Billard" })).toBeVisible();
}

/** Lobby → „Tisch öffnen“: Mitspieler herausfordern oder gegen den Computer. */
async function openTable(page: Page) {
  await page.getByRole("link", { name: "Tisch öffnen" }).click();
  await expect(page).toHaveURL(/#games\/arena\/billiard\/table$/);
  await expect(page.getByRole("heading", { name: "Tisch öffnen" })).toBeVisible();
}

const BREAK_HINT = "Weiße Kugel links der Kopflinie setzen";

function table(page: Page): FrameLocator {
  return page.frameLocator('iframe[title="Spieltisch"]');
}

/** Zahl der fertig ausgewerteten Stöße, wie das eingebettete Spiel sie anzeigt. */
async function shotCount(page: Page) {
  return Number(await table(page).locator(".controls").getAttribute("data-shots"));
}

test.beforeAll(async () => {
  for (const [name, dir] of [
    ["MATCHDESK_DIR", path.join(MATCHDESK_DIR, "dist/index.html")],
    ["BILLIARD_DIR", path.join(BILLIARD_DIR, "apps/client/dist/index.html")],
    ["SHIFT_DIR", path.join(SHIFT_DIR, "apps/client/dist/index.html")]
  ]) {
    if (!fs.existsSync(dir)) throw new Error(`${name}: ${dir} fehlt. Erst bauen (siehe README, Abschnitt E2E).`);
  }

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matchdesk-games-e2e-"));
  const built = await buildModule(path.join(repoRoot, "modules/arena"), { outDir: path.join(tempDir, "packages") });

  const matchdeskPort = await freePort();
  const billiardPort = await freePort();
  const shiftPort = await freePort();

  // Billard-Server, wie im Betrieb unter einem Unterpfad.
  billiard = spawn(process.execPath, ["--import", "tsx", "apps/server/src/index.ts"], {
    cwd: BILLIARD_DIR,
    env: {
      ...process.env,
      PORT: String(billiardPort),
      BASE_PATH: BILLIARD_PATH,
      INTEGRATION_API_KEY: API_KEY,
      INTEGRATION_WEBHOOK_SECRET: WEBHOOK_SECRET
    },
    stdio: ["ignore", "inherit", "inherit"]
  });
  await waitForHttp(`http://127.0.0.1:${billiardPort}${BILLIARD_PATH}/health`);

  // Dreierschub-Server, ebenso unter einem Unterpfad, mit eigenen Schlüsseln.
  shift = spawn(process.execPath, ["--import", "tsx", "apps/server/src/index.ts"], {
    cwd: SHIFT_DIR,
    env: {
      ...process.env,
      PORT: String(shiftPort),
      BASE_PATH: SHIFT_PATH,
      INTEGRATION_API_KEY: SHIFT_API_KEY,
      INTEGRATION_WEBHOOK_SECRET: SHIFT_WEBHOOK_SECRET
    },
    stdio: ["ignore", "inherit", "inherit"]
  });
  await waitForHttp(`http://127.0.0.1:${shiftPort}${SHIFT_PATH}/health`);

  // Matchdesk im Testprozess. Der Kern liefert dist/ relativ zum Arbeitsverzeichnis aus.
  Object.assign(process.env, {
    MATCHDESK_DB_PATH: path.join(tempDir, "matchdesk.sqlite"),
    MATCHDESK_MODULES_DIR: path.join(tempDir, "modules"),
    MATCHDESK_ADMIN_PHONE: "+491701234567",
    MATCHDESK_ADMIN_USERNAME: "hauptadmin",
    MATCHDESK_ADMIN_EMAIL: "hauptadmin@example.test",
    MATCHDESK_MAIL_MODE: "console",
    MATCHDESK_DEV_LOGIN_CODE: "123456",
    MATCHDESK_BILLIARD_API_KEY: API_KEY,
    MATCHDESK_BILLIARD_WEBHOOK_SECRET: WEBHOOK_SECRET,
    MATCHDESK_SHIFT_API_KEY: SHIFT_API_KEY,
    MATCHDESK_SHIFT_WEBHOOK_SECRET: SHIFT_WEBHOOK_SECRET
  });
  delete process.env.MATCHDESK_STORAGE_BACKEND;
  delete process.env.MATCHDESK_VAPID_PUBLIC_KEY;
  delete process.env.MATCHDESK_VAPID_PRIVATE_KEY;
  process.chdir(MATCHDESK_DIR);

  const { bootstrapAdmin } = (await import(path.join(MATCHDESK_DIR, "src/server/db/bootstrap-admin.ts"))) as {
    bootstrapAdmin: () => Promise<unknown>;
  };
  const { createMatchdeskApp } = (await import(path.join(MATCHDESK_DIR, "src/server/app.ts"))) as {
    createMatchdeskApp: () => Promise<{
      app: { listen: (port: number, host: string) => http.Server };
      modules: { installBundled: (buffer: Buffer, input: { settings: Record<string, unknown> }) => Promise<boolean> };
      close: () => Promise<void>;
    }>;
  };
  await bootstrapAdmin();
  const started = await createMatchdeskApp();
  closeMatchdesk = started.close;
  await started.modules.installBundled(fs.readFileSync(built.file), {
    settings: {
      callbackBaseUrl: `http://127.0.0.1:${matchdeskPort}`,
      billiardApiUrl: `http://127.0.0.1:${billiardPort}${BILLIARD_PATH}`,
      billiardPath: `${BILLIARD_PATH}/`,
      shiftApiUrl: `http://127.0.0.1:${shiftPort}${SHIFT_PATH}`,
      shiftPath: `${SHIFT_PATH}/`
    }
  });
  matchdeskServer = started.app.listen(matchdeskPort, "127.0.0.1");
  await new Promise<void>((resolve) => matchdeskServer.once("listening", resolve));

  // Vorne der Proxy (Rolle des Nginx Proxy Manager).
  const proxy = await startProxy([
    { prefix: `${BILLIARD_PATH}/`, port: billiardPort },
    { prefix: `${SHIFT_PATH}/`, port: shiftPort }
  ], matchdeskPort);
  closeProxy = proxy.close;
  baseUrl = `http://127.0.0.1:${proxy.port}`;
});

test.afterAll(async () => {
  await closeProxy?.();
  if (matchdeskServer) {
    // Offene Echtzeit-Verbindungen (SSE) würden close() sonst ewig warten lassen.
    const closed = new Promise<void>((resolve) => matchdeskServer.close(() => resolve()));
    matchdeskServer.closeAllConnections();
    await closed;
  }
  await closeMatchdesk?.();
  billiard?.kill();
  shift?.kill();
  process.chdir(originalCwd);
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

test("Spiele im Hauptmenü: herausfordern, eingebettet Billard spielen, Ergebnis in Matchdesk", async ({ browser, page }) => {
  await login(page, "hauptadmin");
  await createUser(page, "anna");
  await createUser(page, "bob");

  const anna = await playerPage(browser, "anna");
  const bob = await playerPage(browser, "bob");

  // Anna: Hauptmenü → Spieleauswahl → Billard → Tisch öffnen → Bob herausfordern.
  await openBilliardLobby(anna);
  await openTable(anna);
  await anna.getByLabel("Gegner").selectOption({ label: "bob" });
  await anna.getByRole("button", { name: "Herausfordern" }).click();
  await expect(anna).toHaveURL(/#games\/arena\/billiard\/match\/[\w-]+$/);
  const matchUrl = anna.url();

  // Bob: derselbe Weg, die offene Partie steht in seiner Lobby.
  await openBilliardLobby(bob);
  await bob.getByRole("link", { name: "Zum Tisch" }).click();
  await expect(bob).toHaveURL(matchUrl);

  // Kein neuer Tab: beide Kontexte haben genau eine Seite, das Spiel steckt im iframe.
  expect(anna.context().pages()).toHaveLength(1);
  expect(bob.context().pages()).toHaveLength(1);
  for (const player of [anna, bob]) {
    await expect(player.locator('iframe[title="Spieltisch"]')).toHaveAttribute("src", new RegExp(`^${BILLIARD_PATH}/\\?embed=1&seat=`));
    await expect(table(player).getByLabel(/Billardtisch in Draufsicht/)).toBeVisible();
  }

  // Wer hat den Anstoß?
  let breaker: Page | null = null;
  await expect
    .poll(
      async () => {
        for (const player of [anna, bob]) {
          if (await table(player).locator(".controls .hint", { hasText: BREAK_HINT }).isVisible()) breaker = player;
        }
        return breaker !== null;
      },
      { timeout: 20_000 }
    )
    .toBe(true);
  const shooter = breaker as unknown as Page;
  const other = shooter === anna ? bob : anna;
  const otherName = other === anna ? "anna" : "bob";
  await expect(table(other).getByText("Dein Gegner ist am Zug.")).toBeVisible();

  // Weiße Kugel links der Kopflinie setzen.
  const canvas = table(shooter).locator("canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Tisch nicht sichtbar");
  await shooter.mouse.click(box.x + box.width * 0.16, box.y + box.height * 0.5);
  await expect(table(shooter).getByText(/^Zielen:/)).toBeVisible();

  // Stoßstärke über den Regler, dann „Stoß“.
  await table(shooter)
    .locator("#power")
    .evaluate((input: HTMLInputElement) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "80");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  await table(shooter).getByRole("button", { name: "Stoß", exact: true }).click();

  // Der Stoß kommt beim Gegner an: dort zählt der Tisch einen ausgewerteten Stoß.
  await expect.poll(() => shotCount(other), { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(table(other).locator(".controls .hint", { hasText: BREAK_HINT })).toHaveCount(0);

  // Warten, bis die Kugeln liegen, dann gibt der Anstoßende auf.
  await expect(table(shooter).getByText("Kugeln rollen …")).toHaveCount(0, { timeout: 30_000 });
  await table(shooter).getByRole("button", { name: "Aufgeben und Tisch verlassen" }).click();

  // Das Ergebnis landet über den signierten Webhook in Matchdesk, sichtbar bei beiden.
  for (const player of [other, shooter]) {
    await expect(player.getByText(`Gewonnen: ${otherName}`).first()).toBeVisible({ timeout: 30_000 });
  }
  await other.goto(`${baseUrl}/#games/arena/billiard`);
  await expect(other.getByRole("heading", { name: "Letzte Ergebnisse" })).toBeVisible();
  await expect(other.getByText(`Gewonnen: ${otherName}`)).toBeVisible();

  await anna.context().close();
  await bob.context().close();
});

test("Tisch öffnen gegen den Computer: eingebettete Partie, der Computer stößt selbst", async ({ browser, page }) => {
  await login(page, "hauptadmin");
  await createUser(page, "carla");
  const carla = await playerPage(browser, "carla");
  await openBilliardLobby(carla);
  await openTable(carla);
  await carla.getByLabel("Stufe").selectOption({ label: "Leicht" });
  await carla.getByRole("button", { name: "Partie starten" }).click();
  await expect(carla).toHaveURL(/#games\/arena\/billiard\/computer\/easy$/);
  await expect(carla.getByText("Gegen den Computer (Leicht)")).toBeVisible();
  expect(carla.context().pages()).toHaveLength(1);
  await expect(carla.locator('iframe[title="Spieltisch"]')).toHaveAttribute("src", new RegExp(`^${BILLIARD_PATH}/\\?embed=1&solo=easy&name=carla$`));

  const frame = table(carla);
  await expect(frame.locator(".player .name").nth(0)).toContainText("carla");
  await expect(frame.locator(".player .name").nth(1)).toContainText("Computer (Leicht)");

  // Ungültiger Anstoß (Dreieck verfehlt): danach ist der Computer dran und stößt selbst an.
  await expect(frame.locator(".controls .hint", { hasText: BREAK_HINT })).toBeVisible();
  const canvas = frame.locator("canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Tisch nicht sichtbar");
  await carla.mouse.click(box.x + box.width * 0.16, box.y + box.height * 0.5);
  await expect(frame.getByText(/^Zielen:/)).toBeVisible();
  // Zielen nach oben an die Bande, am Dreieck vorbei.
  await carla.mouse.move(box.x + box.width * 0.16, box.y + box.height * 0.1);
  await frame
    .locator("#power")
    .evaluate((input: HTMLInputElement) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "20");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  await frame.getByRole("button", { name: "Stoß", exact: true }).click();
  await expect(frame.locator(".log li").last()).toContainText("Computer (Leicht) stößt an", { timeout: 30_000 });
  // Der Computer stößt selbst: zweiter ausgewerteter Stoß, danach ist carla wieder am Zug.
  await expect.poll(() => shotCount(carla), { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
  await expect(frame.locator(".player").nth(0)).toContainText("Am Zug", { timeout: 60_000 });

  // Zurück führt wieder zu „Tisch öffnen“.
  await carla.getByRole("link", { name: /Zurück/ }).click();
  await expect(carla).toHaveURL(/#games\/arena\/billiard\/table$/);
  await carla.context().close();
});

/** Hauptmenü „Spiele“ → Spieleauswahl → Dreierschub. Alles im selben Tab. */
async function openShiftLobby(page: Page) {
  await page.goto(`${baseUrl}/#`);
  await page.getByRole("link", { name: "Spiele" }).first().click();
  await expect(page).toHaveURL(/#games$/);
  await expect(page.getByRole("link", { name: /Dreierschub/ }).getByRole("img", { name: "Dreierschub-Logo" })).toBeVisible();
  await page.getByRole("link", { name: /Dreierschub/ }).click();
  await expect(page).toHaveURL(/#games\/arena\/shift$/);
  await expect(page.getByRole("heading", { name: "Dreierschub" })).toBeVisible();
}

/** Zahl der ausgewerteten Züge, wie das eingebettete Spiel sie anzeigt. */
async function shiftMoves(page: Page) {
  return Number(await table(page).locator(".board").getAttribute("data-moves"));
}

test("Dreierschub: herausfordern, eingebettet schieben, Ergebnis in Matchdesk", async ({ browser, page }) => {
  await login(page, "hauptadmin");
  await createUser(page, "dora");
  await createUser(page, "emil");
  const dora = await playerPage(browser, "dora");
  const emil = await playerPage(browser, "emil");

  await openShiftLobby(dora);
  await dora.getByRole("link", { name: "Tisch öffnen" }).click();
  await expect(dora).toHaveURL(/#games\/arena\/shift\/table$/);
  await dora.getByLabel("Gegner").selectOption({ label: "emil" });
  await dora.getByRole("button", { name: "Herausfordern" }).click();
  await expect(dora).toHaveURL(/#games\/arena\/shift\/match\/[\w-]+$/);
  const matchUrl = dora.url();

  await openShiftLobby(emil);
  await emil.getByRole("link", { name: "Zum Tisch" }).click();
  await expect(emil).toHaveURL(matchUrl);

  expect(dora.context().pages()).toHaveLength(1);
  expect(emil.context().pages()).toHaveLength(1);
  for (const player of [dora, emil]) {
    await expect(player.locator('iframe[title="Spieltisch"]')).toHaveAttribute("src", new RegExp(`^${SHIFT_PATH}/\\?embed=1&seat=`));
    await expect(table(player).getByRole("grid", { name: "Spielfeld" })).toBeVisible();
  }

  // Wer ist am Zug? Der schiebt einmal, der andere sieht den Zug.
  let mover: Page | null = null;
  await expect
    .poll(
      async () => {
        for (const player of [dora, emil]) {
          if (await table(player).locator("p.hint", { hasText: /^Du bist dran/ }).isVisible()) mover = player;
        }
        return mover !== null;
      },
      { timeout: 20_000 }
    )
    .toBe(true);
  const pusher = mover as unknown as Page;
  const other = pusher === dora ? emil : dora;
  const otherName = other === dora ? "dora" : "emil";
  await table(pusher).locator('.arrow[data-move="left-2"]').click();
  await expect.poll(() => shiftMoves(other), { timeout: 20_000 }).toBe(1);
  await expect(table(other).locator("p.hint", { hasText: /^Du bist dran/ })).toBeVisible({ timeout: 20_000 });

  // Wer geschoben hat, gibt auf; das Ergebnis kommt über den signierten Webhook in Matchdesk an.
  await table(pusher).getByRole("button", { name: "Aufgeben und Tisch verlassen" }).click();
  for (const player of [other, pusher]) {
    await expect(player.getByText(`Gewonnen: ${otherName}`).first()).toBeVisible({ timeout: 30_000 });
  }
  await other.goto(`${baseUrl}/#games/arena/shift`);
  await expect(other.getByText(`Gewonnen: ${otherName}`)).toBeVisible();

  await dora.context().close();
  await emil.context().close();
});

test("Dreierschub gegen den Computer: eingebettet, der Computer schiebt selbst", async ({ browser, page }) => {
  await login(page, "hauptadmin");
  await createUser(page, "fiona");
  const fiona = await playerPage(browser, "fiona");
  await openShiftLobby(fiona);
  await fiona.getByRole("link", { name: "Tisch öffnen" }).click();
  await fiona.getByLabel("Stufe").selectOption({ label: "Schwer" });
  await fiona.getByRole("button", { name: "Partie starten" }).click();
  await expect(fiona).toHaveURL(/#games\/arena\/shift\/computer\/hard$/);
  await expect(fiona.locator('iframe[title="Spieltisch"]')).toHaveAttribute("src", new RegExp(`^${SHIFT_PATH}/\\?embed=1&solo=hard&name=fiona$`));
  const frame = table(fiona);
  await expect(frame.locator(".player .name").nth(1)).toContainText("Computer (Schwer)");
  await frame.locator('.arrow[data-move="top-1"]').click();
  await expect.poll(() => shiftMoves(fiona), { timeout: 20_000 }).toBe(2);
  await expect(frame.locator(".log li").filter({ hasText: /^Computer \(Schwer\): / })).toHaveCount(1);
  await fiona.context().close();
});
