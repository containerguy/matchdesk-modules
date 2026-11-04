/** Pizza-relevant: Grund mit Präfix `pizza_` oder unbekannter Grund (lieber einmal zu viel laden). */
export function isPizzaReason(reason: string | null): boolean {
  return reason === null || reason.startsWith("pizza_");
}
