import type { ErrorCode, ErrorPayload } from "../shared/errors";

/**
 * An error raised by the renderer that maps directly onto the shared protocol
 * error codes. The viewer turns this into a CommandResponse error body.
 */
export class RendererError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "RendererError";
    this.code = code;
    this.details = details;
  }
}

export function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError");
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function toErrorPayload(error: unknown): ErrorPayload {
  if (error instanceof RendererError) {
    return error.details === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, details: error.details };
  }
  return { code: "INTERNAL", message: errorMessage(error) };
}

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/**
 * Rejects with a RendererError when the given promise does not settle in time.
 * The timer is always cleared so a late settle does not hold the event loop.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string, details?: unknown): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new RendererError("TIMEOUT", message, details));
    }, timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}
