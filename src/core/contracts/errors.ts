import type { ContractErrorCode, ErrorContext, ReportingErrorShape } from './types.ts';

export class ReportingError extends Error {
  readonly code: ContractErrorCode;
  readonly stage: ReportingErrorShape['stage'];
  readonly context?: ErrorContext;
  readonly retryable?: boolean;

  constructor(input: ReportingErrorShape) {
    super(input.message);
    this.name = 'ReportingError';
    this.code = input.code;
    this.stage = input.stage;
    this.context = input.context;
    this.retryable = input.retryable;
  }

  toJSON(): ReportingErrorShape {
    return { code: this.code, message: this.message, stage: this.stage,
      ...(this.context ? { context: this.context } : {}),
      ...(this.retryable !== undefined ? { retryable: this.retryable } : {}) };
  }
}

export function asReportingError(error: unknown, fallback: ReportingErrorShape): ReportingError {
  if (error instanceof ReportingError) return error;
  return new ReportingError({ ...fallback, message: error instanceof Error ? error.message : String(error) });
}
