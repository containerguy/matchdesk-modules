import type { ModuleNotification } from "@matchdesk/module-sdk";

/** Telegram erlaubt 4096 Zeichen pro Nachricht; etwas Luft für die HTML-Auszeichnung. */
const TEXT_LIMIT = 3800;

export function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Nachricht im HTML-Modus von Telegram: fetter Kopf, Text als Klartext, Link zur App. */
export function composeTelegram(message: Pick<ModuleNotification, "eventName" | "subject" | "body" | "url">, options: { includeLink: boolean }) {
  const header = `${message.eventName}: ${message.subject}`.replace(/\s+/g, " ").trim();
  let body = message.body.trim();
  if (body.length > TEXT_LIMIT) body = `${body.slice(0, TEXT_LIMIT - 1).trimEnd()}…`;
  const parts = [`<b>${escapeHtml(header)}</b>`];
  if (body) parts.push(escapeHtml(body));
  if (options.includeLink && message.url && /^https?:\/\//.test(message.url)) {
    parts.push(`<a href="${escapeHtml(message.url).replace(/"/g, "&quot;")}">Matchdesk</a>`);
  }
  return parts.join("\n\n");
}
