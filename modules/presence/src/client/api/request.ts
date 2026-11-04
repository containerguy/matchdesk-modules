import { ApiError } from "../errors/errors";
import { host } from "../host";

const MODULE_PREFIX = "/api/m/presence";

/**
 * Wie `requestJson` im Kern: Modul-Pfade laufen über `host.api` (CSRF macht der Kern),
 * andere Kern-Pfade (z. B. /api/main-events) werden nur gelesen.
 */
export async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  if (url.startsWith(MODULE_PREFIX)) {
    return host().api<T>(url.slice(MODULE_PREFIX.length) || "/", options);
  }
  if (options?.method && options.method !== "GET") {
    throw new Error(`Modul „Spielt gerade“ schreibt nicht auf Kern-Pfade: ${url}`);
  }
  const response = await fetch(url, { credentials: "include", headers: { "Content-Type": "application/json" } });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError({ code: body.error ?? "request_failed", status: response.status, body });
  }
  return response.json() as Promise<T>;
}
