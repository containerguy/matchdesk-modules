/** Ausschnitt aus GET /api/main-events des Kerns. */
export type MainEvent = {
  id: string;
  name: string;
  status: "planned" | "running" | "ended";
};
