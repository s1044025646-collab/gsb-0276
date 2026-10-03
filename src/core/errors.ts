/** 带稳定错误码的应用错误，API 与 CLI 共用。 */
export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly httpStatus = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export type ErrorCode =
  | "INVALID_RANGE"
  | "INVALID_DIMENSIONS"
  | "INVALID_BUDGET"
  | "NOT_FOUND"
  | "INVALID_REGION"
  | "BAD_REQUEST";

export function errorBody(code: ErrorCode, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}
