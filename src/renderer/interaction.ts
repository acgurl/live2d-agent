import type { Capabilities } from "../shared/protocol";
import type { ModelConfig } from "../shared/config";
import type { DragPayload } from "./types";

export interface InteractionCallbacks {
  dragWindow(payload: DragPayload): void;
  gaze(x: number, y: number): void;
  releaseGaze(): void;
}

export interface InteractionOptions {
  /** Hover gaze can be disabled through config.behavior.gazeFollow. */
  gazeEnabled?: () => boolean;
  /** Window dragging can be disabled while a modal is open. */
  dragEnabled?: () => boolean;
}

export interface ResolvedHitAction {
  motion: { group: string; index?: number } | null;
  expression: string | null;
  say: string | null;
  source: "config" | "fallback" | "none";
}

const DRAG_THRESHOLD_PX = 5;
const GAZE_MIN_INTERVAL_MS = 40;
const HIT_SUPPRESS_MS = 350;

/**
 * Turns pointer input on #stage-wrap into window drags, hover gaze and taps.
 *
 * The model library itself listens on document for pointer events and emits
 * "hit" on tap; after a window drag we briefly mark hits as suppressed so the
 * drag that moved the window never triggers a tap action.
 */
export class InteractionController {
  private readonly element: HTMLElement;
  private readonly callbacks: InteractionCallbacks;
  private readonly options: InteractionOptions;
  private attached = false;
  private activePointerId: number | null = null;
  private dragging = false;
  private pointerStart = { x: 0, y: 0, screenX: 0, screenY: 0 };
  private suppressHitUntil = 0;
  private lastGazeAt = 0;
  private lastGazeX = Number.NaN;
  private lastGazeY = Number.NaN;

  private readonly onPointerDown = (event: PointerEvent): void => this.handlePointerDown(event);
  private readonly onPointerMove = (event: PointerEvent): void => this.handlePointerMove(event);
  private readonly onPointerUp = (event: PointerEvent): void => this.handlePointerEnd(event);
  private readonly onPointerCancel = (event: PointerEvent): void => this.handlePointerEnd(event);
  private readonly onPointerLeave = (): void => {
    if (this.activePointerId !== null) return;
    this.lastGazeX = Number.NaN;
    this.lastGazeY = Number.NaN;
    this.callbacks.releaseGaze();
  };
  private readonly onWindowBlur = (): void => {
    this.endDrag();
    this.callbacks.releaseGaze();
  };

  constructor(element: HTMLElement, callbacks: InteractionCallbacks, options: InteractionOptions = {}) {
    this.element = element;
    this.callbacks = callbacks;
    this.options = options;
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.element.addEventListener("pointerdown", this.onPointerDown);
    this.element.addEventListener("pointermove", this.onPointerMove);
    this.element.addEventListener("pointerup", this.onPointerUp);
    this.element.addEventListener("pointercancel", this.onPointerCancel);
    this.element.addEventListener("pointerleave", this.onPointerLeave);
    window.addEventListener("blur", this.onWindowBlur);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.element.removeEventListener("pointerdown", this.onPointerDown);
    this.element.removeEventListener("pointermove", this.onPointerMove);
    this.element.removeEventListener("pointerup", this.onPointerUp);
    this.element.removeEventListener("pointercancel", this.onPointerCancel);
    this.element.removeEventListener("pointerleave", this.onPointerLeave);
    window.removeEventListener("blur", this.onWindowBlur);
    this.endDrag();
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  /** True for a short window after a drag ends; tap actions should be ignored. */
  hitsSuppressed(): boolean {
    return performance.now() < this.suppressHitUntil;
  }

  private handlePointerDown(event: PointerEvent): void {
    if (!event.isPrimary || event.button !== 0) return;
    if (this.options.dragEnabled && !this.options.dragEnabled()) return;
    if (this.activePointerId !== null) return;
    this.activePointerId = event.pointerId;
    this.dragging = false;
    this.pointerStart = { x: event.clientX, y: event.clientY, screenX: event.screenX, screenY: event.screenY };
    try {
      this.element.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is best-effort; dragging still works inside the window.
    }
    this.callbacks.dragWindow({ phase: "start", screenX: event.screenX, screenY: event.screenY });
  }

  private handlePointerMove(event: PointerEvent): void {
    if (this.activePointerId !== null) {
      if (event.pointerId !== this.activePointerId) return;
      if (!this.dragging) {
        const dx = event.clientX - this.pointerStart.x;
        const dy = event.clientY - this.pointerStart.y;
        if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
        this.dragging = true;
        document.body.classList.add("dragging");
      }
      this.callbacks.dragWindow({ phase: "move", screenX: event.screenX, screenY: event.screenY });
      return;
    }
    if (this.options.gazeEnabled && !this.options.gazeEnabled()) return;
    const now = performance.now();
    if (now - this.lastGazeAt < GAZE_MIN_INTERVAL_MS) return;
    const rect = this.element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = clampGaze(((event.clientX - rect.left) / rect.width) * 2 - 1);
    const y = clampGaze(-(((event.clientY - rect.top) / rect.height) * 2 - 1));
    if (Math.abs(x - this.lastGazeX) < 0.01 && Math.abs(y - this.lastGazeY) < 0.01) return;
    this.lastGazeAt = now;
    this.lastGazeX = x;
    this.lastGazeY = y;
    this.callbacks.gaze(x, y);
  }

  private handlePointerEnd(event: PointerEvent): void {
    if (this.activePointerId === null || event.pointerId !== this.activePointerId) return;
    const wasDragging = this.dragging;
    this.callbacks.dragWindow({ phase: "end", screenX: event.screenX, screenY: event.screenY });
    if (wasDragging) this.suppressHitUntil = performance.now() + HIT_SUPPRESS_MS;
    try {
      if (this.element.hasPointerCapture(event.pointerId)) this.element.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    this.activePointerId = null;
    this.dragging = false;
    document.body.classList.remove("dragging");
  }

  private endDrag(): void {
    if (this.activePointerId !== null) {
      this.callbacks.dragWindow({ phase: "end", screenX: this.pointerStart.screenX, screenY: this.pointerStart.screenY });
    }
    this.activePointerId = null;
    this.dragging = false;
    document.body.classList.remove("dragging");
  }
}

/**
 * Resolves the action for a tap on a model hit area.
 *
 * Priority: modelConfig.hitActions[hitAreaName] first, then the conventional
 * TapHead/TapBody motion groups (with the area name picking head vs body).
 */
export function resolveHitAction(hitAreaName: string, modelConfig: ModelConfig, capabilities: Capabilities): ResolvedHitAction {
  const configured = modelConfig.hitActions?.[hitAreaName];
  const fallback = fallbackMotion(hitAreaName, capabilities);
  if (!configured) {
    if (!fallback) return { motion: null, expression: null, say: null, source: "none" };
    return { motion: fallback, expression: null, say: null, source: "fallback" };
  }
  const motion = configured.motion
    ? { group: configured.motion.group, index: configured.motion.index }
    : fallback;
  const action: ResolvedHitAction = {
    motion,
    expression: configured.expression ?? null,
    say: configured.say ?? null,
    source: "config",
  };
  return action;
}

function fallbackMotion(hitAreaName: string, capabilities: Capabilities): { group: string; index?: number } | null {
  const headLike = /head|kao|atama/i.test(hitAreaName);
  const candidates = headLike
    ? ["TapHead", "FlickHead", "Tap", "Tap@Body", "Flick"]
    : ["TapBody", "Tap@Body", "Tap", "Flick@Body", "Flick"];
  const groups = new Set(capabilities.motions.map((motion) => motion.group));
  for (const group of candidates) {
    if (groups.has(group)) return { group };
  }
  return null;
}

function clampGaze(value: number): number {
  if (value < -1) return -1;
  if (value > 1) return 1;
  return value;
}
