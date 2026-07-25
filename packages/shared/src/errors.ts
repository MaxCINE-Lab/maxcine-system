export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, string[]>
  ) {
    super(message);
  }
}

export const forbidden = (message = 'You do not have permission to perform this action') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Resource not found') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (message: string) => new AppError(409, 'CONFLICT', message);
export const badRequest = (message: string, details?: Record<string, string[]>) => new AppError(400, 'VALIDATION_ERROR', message, details);
