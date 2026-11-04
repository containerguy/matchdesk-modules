import { AppError } from "../../http/errors";

export const PIZZA_MAX_LINES_PER_ORDER = 3;
export const PIZZA_MIN_QTY = 1;
export const PIZZA_MAX_QTY = 3;
export const PIZZA_NOTE_MAX_LEN = 200;

export class PizzaOrderLimitError extends AppError {
  constructor(code: string, message: string) {
    super(code, message, 400);
  }
}

export interface ExistingLineSummary {
  id: string;
}

export function assertCanAddLine(existingLines: ExistingLineSummary[]) {
  if (existingLines.length >= PIZZA_MAX_LINES_PER_ORDER) {
    throw new PizzaOrderLimitError(
      "max_lines_exceeded",
      `Maximal ${PIZZA_MAX_LINES_PER_ORDER} Positionen pro Bestellung erlaubt`
    );
  }
}

export function assertValidQty(qty: number) {
  if (!Number.isInteger(qty) || qty < PIZZA_MIN_QTY || qty > PIZZA_MAX_QTY) {
    throw new PizzaOrderLimitError(
      "invalid_qty",
      `Menge muss zwischen ${PIZZA_MIN_QTY} und ${PIZZA_MAX_QTY} liegen`
    );
  }
}

export function assertValidNote(note: string | null | undefined) {
  if (note == null) return;
  if (note.length > PIZZA_NOTE_MAX_LEN) {
    throw new PizzaOrderLimitError(
      "note_too_long",
      `Notiz darf höchstens ${PIZZA_NOTE_MAX_LEN} Zeichen lang sein`
    );
  }
}

export function normalizeNote(note: string | null | undefined): string | null {
  if (note == null) return null;
  const trimmed = note.trim();
  return trimmed.length === 0 ? null : trimmed;
}
