import type { Response } from "express";

export class AppError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function handleDomainError(error: unknown, response: Response): boolean {
  if (error instanceof AppError) {
    response.status(error.status).json({ error: error.code });
    return true;
  }
  return false;
}
