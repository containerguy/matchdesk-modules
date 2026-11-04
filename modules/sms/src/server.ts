import { randomUUID } from "node:crypto";
import type { ModuleContext, ModuleUser } from "@matchdesk/module-sdk";
import { composeSms, normalizePhoneNumber } from "./message";
import type { SmsSettings } from "./settings";

const SEND_TIMEOUT_MS = 15_000;
const LOG_DAYS = 90;

type LogRow = { id: string; kind: string; status: string; error: string | null; created_at: string; username: string | null };

export function register(ctx: ModuleContext) {
  const settings = () => ctx.settings.get() as SmsSettings;
  const password = () => ctx.env("SMS_PASSWORD") ?? "";
  const configured = () => Boolean(settings().username && password());

  function sentToday() {
    const today = new Date().toISOString().slice(0, 10);
    const row = ctx.db
      .prepare("SELECT COUNT(*) AS count FROM sms_log WHERE status = 'sent' AND created_at >= ?")
      .get(`${today}T00:00:00.000Z`) as { count: number };
    return row.count;
  }

  function log(entry: { userId: string | null; mainEventId: string | null; kind: string; status: string; error?: string | null; gatewayId?: string | null }) {
    try {
      ctx.db
        .prepare(
          "INSERT INTO sms_log (id, user_id, main_event_id, kind, status, error, gateway_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(randomUUID(), entry.userId, entry.mainEventId, entry.kind, entry.status, entry.error ?? null, entry.gatewayId ?? null, new Date().toISOString());
    } catch (error) {
      // Das Protokoll darf eine Zustellung nie verhindern.
      ctx.log.error("SMS-Protokoll fehlgeschlagen", error);
    }
  }

  /** Eine SMS über das Gateway schicken. Wirft bei Fehlern, protokolliert immer. */
  async function deliver(phoneNumber: string, text: string, meta: { userId: string | null; mainEventId: string | null; kind: string }) {
    const current = settings();
    if (!configured()) {
      log({ ...meta, status: "failed", error: "nicht_eingerichtet" });
      throw new Error("SMS-Gateway ist nicht eingerichtet");
    }
    if (sentToday() >= current.dailyLimit) {
      log({ ...meta, status: "skipped", error: "tageslimit" });
      throw new Error("Tageslimit für SMS erreicht");
    }
    const body: Record<string, unknown> = { textMessage: { text }, phoneNumbers: [phoneNumber] };
    if (current.deviceId) body.deviceId = current.deviceId;
    try {
      const response = await ctx.http.fetch(current.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(`${current.username}:${password()}`).toString("base64")}`
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 120);
        throw new Error(`Gateway antwortet mit ${response.status}${detail ? `: ${detail}` : ""}`);
      }
      const result = (await response.json().catch(() => ({}))) as { id?: unknown };
      log({ ...meta, status: "sent", gatewayId: typeof result.id === "string" ? result.id : null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log({ ...meta, status: "failed", error: message.slice(0, 200) });
      throw error instanceof Error ? error : new Error(message);
    }
  }

  const phoneOf = (user: ModuleUser) => normalizePhoneNumber(user.phoneNumber ?? "", settings().countryCode);

  ctx.notifications.registerChannel({
    id: "sms",
    label: { de: "SMS", en: "Text message" },
    isAvailable: (user) => configured() && ctx.can(user, "sms.receive") && Boolean(phoneOf(user)),
    unavailableHint: {
      de: "Braucht eine Handynummer im Profil (z. B. 0171 1234567).",
      en: "Needs a mobile number in your profile."
    },
    send: async (user, message) => {
      const phone = phoneOf(user);
      if (!phone) throw new Error("Telefonnummer fehlt oder ist ungültig");
      const current = settings();
      await deliver(phone, composeSms(message, current), { userId: user.id, mainEventId: message.mainEventId, kind: "event_info" });
    }
  });

  ctx.router.get("/admin/status", (request, response) => {
    const user = ctx.currentUser(request);
    if (!user) return void response.status(401).json({ error: "nicht_angemeldet" });
    if (!ctx.can(user, "sms.manage")) return void response.status(403).json({ error: "recht_fehlt" });
    const recent = ctx.db
      .prepare(
        `SELECT l.id, l.kind, l.status, l.error, l.created_at, u.username
         FROM sms_log l LEFT JOIN users u ON u.id = l.user_id
         ORDER BY l.created_at DESC LIMIT 20`
      )
      .all() as LogRow[];
    response.json({
      configured: configured(),
      missing: [!settings().username ? "username" : null, !password() ? "password" : null].filter(Boolean),
      sentToday: sentToday(),
      dailyLimit: settings().dailyLimit,
      ownNumber: phoneOf(user),
      recent: recent.map((row) => ({
        id: row.id,
        kind: row.kind,
        status: row.status,
        error: row.error,
        createdAt: row.created_at,
        username: row.username
      }))
    });
  });

  // Test-SMS an die eigene Profilnummer, damit niemand über Matchdesk fremde Nummern beschreibt.
  ctx.router.post("/admin/test", async (request, response) => {
    if (!ctx.requireWrite(request, response)) return;
    const user = ctx.currentUser(request)!;
    if (!ctx.can(user, "sms.manage")) return void response.status(403).json({ error: "recht_fehlt" });
    const phone = phoneOf(user);
    if (!phone) return void response.status(400).json({ error: "telefonnummer_fehlt" });
    try {
      await deliver(phone, user.locale === "en" ? "Matchdesk: test message. Text messages work." : "Matchdesk: Test-SMS. Der SMS-Versand funktioniert.", {
        userId: user.id,
        mainEventId: null,
        kind: "test"
      });
      ctx.audit({ actor: user, action: "test_sent", summary: "Test-SMS an die eigene Nummer verschickt" });
      response.json({ ok: true });
    } catch (error) {
      response.status(502).json({ error: "sms_fehlgeschlagen", detail: error instanceof Error ? error.message : String(error) });
    }
  });

  const cleanup = () => {
    const cutoff = new Date(Date.now() - LOG_DAYS * 24 * 60 * 60 * 1000).toISOString();
    ctx.db.prepare("DELETE FROM sms_log WHERE created_at < ?").run(cutoff);
  };
  cleanup();
  ctx.schedule(6 * 60 * 60 * 1000, cleanup);

  if (!configured()) ctx.log.warn("SMS-Modul ohne Zugangsdaten: Benutzername in den Einstellungen, Passwort als MATCHDESK_SMS_PASSWORD");
}
