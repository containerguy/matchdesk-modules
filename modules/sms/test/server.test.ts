import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestModule, type TestModule } from "@matchdesk/module-sdk/testing";
import { composeSms, normalizePhoneNumber } from "../src/message";
import { register } from "../src/server";

const moduleDir = path.resolve(import.meta.dirname, "..");
let module: TestModule | undefined;

type Call = { url: string; init: RequestInit };

function stubGateway(status = 202) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(status < 300 ? { id: `msg-${calls.length}`, state: "Pending" } : { message: "kaputt" }), {
        status,
        headers: { "Content-Type": "application/json" }
      });
    })
  );
  return calls;
}

async function start(options: { settings?: Record<string, unknown>; password?: string | null } = {}) {
  module = await createTestModule({
    moduleDir,
    register,
    settings: { username: "gateway-user", ...options.settings },
    secrets: options.password === null ? {} : { SMS_PASSWORD: options.password ?? "geheim" },
    users: [
      { username: "admin", role: "admin", phoneNumber: "+49 170 1111111" },
      { username: "anna", phoneNumber: "0171 / 234 56 78" },
      { username: "max", phoneNumber: "" }
    ]
  });
  module.db.prepare("INSERT INTO main_events (id, name) VALUES ('event-1', 'Test-LAN')").run();
  return module;
}

afterEach(async () => {
  await module?.stop();
  module = undefined;
  vi.unstubAllGlobals();
});

describe("Telefonnummern und SMS-Text", () => {
  it("bringt Nummern ins internationale Format", () => {
    expect(normalizePhoneNumber("0171 / 234 56 78", "+49")).toBe("+491712345678");
    expect(normalizePhoneNumber("0043 664 1234567", "+49")).toBe("+436641234567");
    expect(normalizePhoneNumber("+49 (0)171-2345678".replace("(0)", ""), "+49")).toBe("+491712345678");
    expect(normalizePhoneNumber("171234", "+49")).toBeNull();
    expect(normalizePhoneNumber("", "+49")).toBeNull();
    expect(normalizePhoneNumber("012", "+49")).toBeNull();
  });

  it("kürzt den Text und hängt den Link an", () => {
    const text = composeSms(
      { eventName: "LAN", subject: "Pizza", body: "**Bitte** bis 18 Uhr bestellen. ".repeat(20), url: "https://md.example/#e" },
      { maxLength: 120, includeLink: true }
    );
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text.startsWith("LAN: Pizza\nBitte bis 18 Uhr")).toBe(true);
    expect(text.endsWith("…\nhttps://md.example/#e")).toBe(true);
    expect(composeSms({ eventName: "LAN", subject: "Kurz", body: "", url: "https://x" }, { maxLength: 120, includeLink: false })).toBe(
      "LAN: Kurz"
    );
  });
});

describe("Modul SMS", () => {
  it("schickt Event-Infos über das Gateway an die Profilnummer", async () => {
    const calls = stubGateway();
    const mod = await start({ settings: { deviceId: "handy-1" } });
    expect(await mod.notify("sms", "anna", { subject: "Pizza", body: "Bestellung bis 18 Uhr" })).toBe("sent");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.sms-gate.app/3rdparty/v1/messages");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("gateway-user:geheim").toString("base64")}`
    );
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      textMessage: { text: "Test-LAN: Pizza\nBestellung bis 18 Uhr\nhttps://matchdesk.example.test/#main-events" },
      phoneNumbers: ["+491712345678"],
      deviceId: "handy-1"
    });
    const log = mod.db.prepare("SELECT status, gateway_id, user_id FROM sms_log").all();
    expect(log).toEqual([{ status: "sent", gateway_id: "msg-1", user_id: mod.userId("anna") }]);
  });

  it("ist ohne Nummer, ohne Zugangsdaten oder ohne Recht nicht erreichbar", async () => {
    stubGateway();
    let mod = await start();
    expect(await mod.notify("sms", "max")).toBe("unavailable");
    await mod.stop();

    mod = await start({ password: null });
    expect(await mod.notify("sms", "anna")).toBe("unavailable");
    await mod.stop();

    // Recht sms.receive per Rolle weggenommen: Kanal erreicht Anna nicht mehr.
    mod = await start();
    mod.manifest.permissions.find((permission) => permission.key === "sms.receive")!.defaultRoles = [];
    expect(await mod.notify("sms", "anna")).toBe("unavailable");
    mod.grant("anna", "sms.receive");
    expect(await mod.notify("sms", "anna")).toBe("sent");
  });

  it("meldet Gateway-Fehler als fehlgeschlagen und hält das Tageslimit ein", async () => {
    stubGateway(401);
    let mod = await start();
    expect(await mod.notify("sms", "anna")).toMatch(/Gateway antwortet mit 401/);
    expect(mod.db.prepare("SELECT status FROM sms_log").all()).toEqual([{ status: "failed" }]);
    await mod.stop();

    const calls = stubGateway();
    mod = await start({ settings: { dailyLimit: 1 } });
    expect(await mod.notify("sms", "anna")).toBe("sent");
    expect(await mod.notify("sms", "admin")).toBe("Tageslimit für SMS erreicht");
    expect(calls).toHaveLength(1);
  });

  it("zeigt Admins den Stand und schickt eine Test-SMS an die eigene Nummer", async () => {
    const calls = stubGateway();
    const mod = await start();
    await request(mod.app).get("/api/m/sms/admin/status").set("x-test-user", "anna").expect(403);
    await request(mod.app).post("/api/m/sms/admin/test").set("x-test-user", "anna").expect(403);

    await request(mod.app).post("/api/m/sms/admin/test").set("x-test-user", "admin").send({}).expect(200);
    expect(JSON.parse(String(calls[0].init.body)).phoneNumbers).toEqual(["+491701111111"]);
    expect(mod.audits[0]).toEqual(expect.objectContaining({ action: "sms.test_sent" }));

    const status = (await request(mod.app).get("/api/m/sms/admin/status").set("x-test-user", "admin").expect(200)).body;
    expect(status).toEqual(
      expect.objectContaining({ configured: true, sentToday: 1, dailyLimit: 100, ownNumber: "+491701111111" })
    );
    expect(status.recent).toEqual([expect.objectContaining({ kind: "test", status: "sent", username: "admin" })]);
  });

  it("räumt beim Deinstallieren alle eigenen Tabellen weg", async () => {
    const mod = await start();
    mod.db.exec(fs.readFileSync(path.join(moduleDir, "uninstall.sql"), "utf8"));
    const left = mod.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sms\\_%' ESCAPE '\\'").all();
    expect(left).toEqual([]);
  });
});
