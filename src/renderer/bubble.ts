import type { AppConfig } from "../shared/config";

export interface BubbleShowOptions {
  /** Overrides config.bubble.ttlMs for this message. */
  autoHideMs?: number;
  /** When false the text is shown at once instead of typed out. Defaults to true. */
  typewriter?: boolean;
}

type BubbleConfig = AppConfig["bubble"];

const TYPE_INTERVAL_MS = 18;

/**
 * Owns the #bubble DOM node.
 *
 * - Only ever writes through textContent (never innerHTML).
 * - Truncates to config.bubble.maxChars (by code points, so surrogate pairs
 *   are never split) and appends an ellipsis when truncated.
 * - Types text out one character at a time, then auto-hides after the TTL.
 */
export class Bubble {
  private readonly root: HTMLElement;
  private readonly textEl: HTMLElement;
  private config: BubbleConfig;
  private typingTimer: number | null = null;
  private hideTimer: number | null = null;
  private displayText = "";
  private shownChars = 0;
  private idleWaiters: Array<() => void> = [];

  /** Fired whenever visibility or text changes, so the viewer can refresh state. */
  onChange: (() => void) | null = null;

  constructor(root: HTMLElement, textEl: HTMLElement, config: BubbleConfig) {
    this.root = root;
    this.textEl = textEl;
    this.config = config;
  }

  configure(config: BubbleConfig): void {
    this.config = config;
    if (!config.enabled) this.hide();
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  get text(): string | null {
    return this.visible && this.displayText.length > 0 ? this.displayText : null;
  }

  get typing(): boolean {
    return this.typingTimer !== null;
  }

  show(input: string, options: BubbleShowOptions = {}): string {
    const text = this.truncate(input);
    this.cancelTimers();
    this.resolveIdle();
    if (!this.config.enabled || text.length === 0) {
      this.hide();
      return text;
    }
    this.displayText = text;
    this.shownChars = 0;
    this.textEl.textContent = "";
    this.root.hidden = false;
    this.onChange?.();
    if (options.typewriter === false) {
      this.finishTyping(options);
      return text;
    }
    this.typingTimer = window.setInterval(() => {
      this.shownChars += 1;
      if (this.shownChars >= text.length) {
        this.finishTyping(options);
        return;
      }
      this.textEl.textContent = text.slice(0, this.shownChars);
    }, TYPE_INTERVAL_MS);
    return text;
  }

  hide(): void {
    const wasVisible = !this.root.hidden || this.displayText.length > 0;
    this.cancelTimers();
    this.displayText = "";
    this.shownChars = 0;
    this.textEl.textContent = "";
    this.root.hidden = true;
    this.resolveIdle();
    if (wasVisible) this.onChange?.();
  }

  /** Schedules auto-hide for the current message without changing its text. */
  autoHideIn(ms: number): void {
    if (this.root.hidden) return;
    if (this.hideTimer !== null) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    const ttl = Math.max(0, ms);
    if (ttl <= 0) return;
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = null;
      this.hide();
    }, ttl);
  }

  /** Resolves once the current message is fully typed out, hidden, or replaced. */
  whenIdle(): Promise<void> {
    if (this.typingTimer === null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private truncate(input: string): string {
    const normalized = String(input ?? "").replace(/\r\n/g, "\n").trim();
    const max = Math.max(1, this.config.maxChars);
    const chars = Array.from(normalized);
    if (chars.length <= max) return normalized;
    if (max === 1) return "\u2026";
    return chars.slice(0, max - 1).join("") + "\u2026";
  }

  private finishTyping(options: BubbleShowOptions): void {
    if (this.typingTimer !== null) {
      window.clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
    this.textEl.textContent = this.displayText;
    this.shownChars = this.displayText.length;
    this.resolveIdle();
    this.onChange?.();
    this.scheduleHide(options.autoHideMs);
  }

  private scheduleHide(autoHideMs?: number): void {
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    const ttl = autoHideMs !== undefined ? Math.max(0, autoHideMs) : Math.max(0, this.config.ttlMs);
    if (ttl <= 0) return;
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = null;
      this.hide();
    }, ttl);
  }

  private cancelTimers(): void {
    if (this.typingTimer !== null) {
      window.clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
    if (this.hideTimer !== null) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  private resolveIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
