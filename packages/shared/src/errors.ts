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

export const forbidden = (message = '你没有权限执行此操作') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (message = '未找到相关内容') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (message: string) => new AppError(409, 'CONFLICT', message);
export const badRequest = (message: string, details?: Record<string, string[]>) => new AppError(400, 'VALIDATION_ERROR', message, details);
