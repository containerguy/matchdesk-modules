import { host } from "../host";
import type { MessageKey } from "./catalog/index";

export type TFunction = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** Texte kommen aus i18n/de.json und en.json des Moduls (über den Host). */
export function useI18n(): { locale: "de" | "en"; t: TFunction } {
  const current = host();
  return { locale: current.locale.startsWith("en") ? "en" : "de", t: current.t };
}
