import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AgentError } from "../shared/errors";

interface AudioEntry { path: string; mime: string; bytes: number; createdAt: number; }

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const AUDIO_TTL_MS = 10 * 60 * 1000;

export class AudioCache {
  private entries = new Map<string, AudioEntry>();

  constructor(private readonly dir: string) {}

  async save(buffer: Buffer, mimeHeader: string): Promise<{ id: string; url: string; bytes: number }> {
    if (buffer.length > MAX_AUDIO_BYTES) {
      throw new AgentError("AUDIO_TOO_LARGE", "Audio file is larger than 10MB.");
    }
    const mime = normalizeAudioMime(mimeHeader);
    if (!mime || !looksLikeAudio(buffer, mime)) {
      throw new AgentError("AUDIO_UNSUPPORTED", "Unsupported audio data (expected WAV, MP3 or OGG).");
    }
    const id = randomUUID();
    const filePath = path.join(this.dir, id + extensionFor(mime));
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(filePath, buffer);
    this.entries.set(id, { path: filePath, mime, bytes: buffer.length, createdAt: Date.now() });
    await this.cleanup();
    return { id, url: "/audio/" + id, bytes: buffer.length };
  }

  async get(id: string): Promise<{ path: string; mime: string; bytes: number } | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > AUDIO_TTL_MS) {
      this.entries.delete(id);
      await fs.unlink(entry.path).catch(() => undefined);
      return null;
    }
    return { path: entry.path, mime: entry.mime, bytes: entry.bytes };
  }

  async cleanup(): Promise<void> {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (now - entry.createdAt > AUDIO_TTL_MS) {
        this.entries.delete(id);
        await fs.unlink(entry.path).catch(() => undefined);
      }
    }
  }
}

function normalizeAudioMime(value: string): string | null {
  const mime = value.split(";")[0].trim().toLowerCase();
  if (mime === "audio/wav" || mime === "audio/wave" || mime === "audio/x-wav") return "audio/wav";
  if (mime === "audio/mpeg" || mime === "audio/mp3") return "audio/mpeg";
  if (mime === "audio/ogg" || mime === "application/ogg") return "audio/ogg";
  return null;
}

function extensionFor(mime: string): string {
  if (mime === "audio/wav") return ".wav";
  if (mime === "audio/mpeg") return ".mp3";
  return ".ogg";
}

function looksLikeAudio(buffer: Buffer, mime: string): boolean {
  if (buffer.length < 4) return false;
  if (mime === "audio/wav") {
    return buffer.toString("ascii", 0, 4) === "RIFF" && buffer.length >= 12 && buffer.toString("ascii", 8, 12) === "WAVE";
  }
  if (mime === "audio/ogg") return buffer.toString("ascii", 0, 4) === "OggS";
  if (mime === "audio/mpeg") {
    return (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0);
  }
  return false;
}
