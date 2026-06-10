export class AsyncPipelineError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AsyncPipelineError";
    this.code = code;
    this.details = details;
  }
}

export function pipelineError(code: string, message: string, details?: unknown): AsyncPipelineError {
  return new AsyncPipelineError(code, message, details);
}
