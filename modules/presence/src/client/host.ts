import type { ModuleClientHost } from "@matchdesk/module-sdk";

let current: ModuleClientHost | null = null;

export function setHost(host: ModuleClientHost) {
  current = host;
}

export function host(): ModuleClientHost {
  if (!current) throw new Error("Modul „Spielt gerade“: Host fehlt");
  return current;
}
