import type { ModuleNotification } from "@matchdesk/module-sdk";

/**
 * Telefonnummer aus dem Profil in internationales Format (E.164) bringen.
 * Leerzeichen, Striche, Schrägstriche und Klammern fallen weg, 00 wird +, eine führende 0 bekommt die Vorwahl.
 */
export function normalizePhoneNumber(raw: string, countryCode: string): string | null {
  let number = raw.trim().replace(/[\s\-/().]/g, "");
  if (!number) return null;
  if (number.startsWith("00")) number = `+${number.slice(2)}`;
  else if (number.startsWith("0")) number = `${countryCode}${number.slice(1)}`;
  else if (!number.startsWith("+")) return null;
  return /^\+[1-9]\d{6,14}$/.test(number) ? number : null;
}

/** SMS-Text: „Event: Betreff“, dann der gekürzte Text, auf Wunsch der Link zur App. */
export function composeSms(message: Pick<ModuleNotification, "eventName" | "subject" | "body" | "url">, options: { maxLength: number; includeLink: boolean }) {
  const header = `${message.eventName}: ${message.subject}`.replace(/\s+/g, " ").trim();
  const body = message.body
    .replace(/[*_`#>]+/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
  const link = options.includeLink && message.url ? message.url : null;
  const tail = link ? `\n${link}` : "";
  const room = options.maxLength - tail.length;
  if (header.length >= room) {
    // Ohne Platz für Text: lieber den Link weglassen als den Betreff abschneiden.
    return header.length > options.maxLength ? `${header.slice(0, options.maxLength - 1)}…` : header;
  }
  let text = body ? `${header}\n${body}` : header;
  if (text.length > room) text = `${text.slice(0, room - 1).trimEnd()}…`;
  return `${text}${tail}`;
}
