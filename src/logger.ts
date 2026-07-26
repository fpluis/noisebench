/**
 * Small shared logger. Full-detail JSON lines go to `logs/`, short summaries to
 * stdout. Import the singleton `logger` anywhere, the way `console` is used.
 */
import fs from "fs";
import path from "path";

const LOGS_DIR = path.resolve(process.cwd(), "logs");
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

class RotatingFileWriter {
  private filePath: string;
  private stream: fs.WriteStream | null = null;
  private bytesWritten = 0;

  constructor(fileName: string) {
    this.filePath = path.join(LOGS_DIR, fileName);
  }

  private ensureStream(): fs.WriteStream {
    if (this.stream) return this.stream;
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    try {
      this.bytesWritten = fs.statSync(this.filePath).size;
    } catch {
      this.bytesWritten = 0;
    }
    this.stream = fs.createWriteStream(this.filePath, { flags: "a" });
    return this.stream;
  }

  private rotate(): void {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
    try {
      if (fs.existsSync(this.filePath)) {
        fs.renameSync(this.filePath, `${this.filePath}.1`);
      }
    } catch {
      // Keep appending if rotation fails (e.g. locked file on Windows).
    }
    this.bytesWritten = 0;
  }

  writeLine(record: Record<string, unknown>): void {
    this.ensureStream();
    if (this.bytesWritten >= MAX_FILE_BYTES) this.rotate();
    const buffer = `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`;
    this.ensureStream().write(buffer);
    this.bytesWritten += Buffer.byteLength(buffer);
  }
}

const extractErrorCode = (error: unknown): number | string | undefined => {
  const e = error as any;
  return (
    e?.code ??
    e?.error?.code ??
    e?.statusCode ??
    e?.status ??
    e?.response?.status ??
    undefined
  );
};

const serializeError = (error: unknown): Record<string, unknown> => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: extractErrorCode(error),
    };
  }
  let raw: unknown = error;
  try {
    raw = JSON.parse(JSON.stringify(error));
  } catch {
    raw = String(error);
  }
  return { code: extractErrorCode(error), raw };
};

class Logger {
  private errorWriter = new RotatingFileWriter("errors.log");
  private seen = new Set<string>();

  logError(
    shortMsg: string,
    error: unknown,
    context: Record<string, unknown> = {},
  ): void {
    const serialized = serializeError(error);
    this.errorWriter.writeLine({ shortMsg, context, ...serialized });

    const scope = context.model ?? context.forecaster ?? "global";
    const code = serialized.code ?? "";
    const key = `${scope}|${code}|${shortMsg}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    console.error(`[${scope}]${code ? ` (${code})` : ""} ${shortMsg}`);
  }
}

export const logger = new Logger();
