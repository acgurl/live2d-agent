export const ERROR_CODES = [
  "APP_NOT_RUNNING",
  "NOT_READY",
  "CORE_MISSING",
  "MODEL_MISSING",
  "MODEL_LOAD_FAILED",
  "MODEL_INVALID",
  "UNSUPPORTED_MODEL",
  "UNKNOWN_EXPRESSION",
  "UNKNOWN_MOTION",
  "UNKNOWN_PARAMETER",
  "OUT_OF_RANGE",
  "FEATURE_UNAVAILABLE",
  "AUDIO_UNSUPPORTED",
  "AUDIO_TOO_LARGE",
  "TTS_UNAVAILABLE",
  "TIMEOUT",
  "BUSY",
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "RATE_LIMITED",
  "WINDOW_HIDDEN",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export class AgentError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly httpStatus: number;

  constructor(code: ErrorCode, message: string, options?: { details?: unknown; httpStatus?: number; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AgentError";
    this.code = code;
    this.details = options?.details;
    this.httpStatus = options?.httpStatus ?? defaultStatus(code);
  }
}

function defaultStatus(code: ErrorCode): number {
  switch (code) {
    case "UNAUTHORIZED":
      return 401;
    case "RATE_LIMITED":
      return 429;
    case "BUSY":
      return 409;
    case "TIMEOUT":
      return 504;
    case "INTERNAL":
      return 500;
    default:
      return 400;
  }
}

export function isAgentError(value: unknown): value is AgentError {
  return value instanceof AgentError;
}

export function errorPayload(error: unknown): ErrorPayload {
  if (isAgentError(error)) {
    return { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "INTERNAL", message };
}

export function errorFromPayload(payload: ErrorPayload): AgentError {
  return new AgentError(payload.code, payload.message, { details: payload.details });
}
