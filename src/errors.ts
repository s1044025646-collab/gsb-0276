export type ErrorCode =
  | 'INVALID_JSON'
  | 'VALIDATION_ERROR'
  | 'INVALID_RANGE'
  | 'INVALID_DIMENSIONS'
  | 'BUDGET_EXCEEDED'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const invalidRange = (message: string, details?: Record<string, unknown>) =>
  new AppError('INVALID_RANGE', 400, message, details);

export const invalidDimensions = (message: string, details?: Record<string, unknown>) =>
  new AppError('INVALID_DIMENSIONS', 400, message, details);

export const budgetExceeded = (message: string, details?: Record<string, unknown>) =>
  new AppError('BUDGET_EXCEEDED', 400, message, details);

export const validationError = (message: string, details?: Record<string, unknown>) =>
  new AppError('VALIDATION_ERROR', 400, message, details);

export const notFound = (message: string) => new AppError('NOT_FOUND', 404, message);
