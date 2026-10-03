import fs from 'fs'
import path from 'path'

// Minimaler, abhaengigkeitsfreier Datei-Logger fuer den Main-Prozess.
// Bewusst kein zusaetzliches npm-Paket: Der Umfang (ein Log-File,
// einfache Rotation bei Groessen-Limit) rechtfertigt keine externe
// Abhaengigkeit. Der Renderer-Prozess loggt NICHT in dieses File
// (Sicherheits-Minimierung, siehe Entscheidungs-Memo Punkt 12.15) -
// dort wird ausschliesslich die DevTools-Konsole verwendet.

const MAX_LOG_SIZE_BYTES = 2 * 1024 * 1024 // 2 MB

export class FileLogger {
  private readonly logFile: string

  constructor(logDir: string, fileName = 'main.log') {
    fs.mkdirSync(logDir, { recursive: true })
    this.logFile = path.join(logDir, fileName)
    this.rotateIfNeeded()
  }

  private rotateIfNeeded(): void {
    try {
      const stat = fs.statSync(this.logFile)
      if (stat.size > MAX_LOG_SIZE_BYTES) {
        const backupFile = `${this.logFile}.1`
        fs.rmSync(backupFile, { force: true })
        fs.renameSync(this.logFile, backupFile)
      }
    } catch {
      // Datei existiert noch nicht - kein Problem beim ersten Start.
    }
  }

  private write(level: 'INFO' | 'WARN' | 'ERROR', message: string, meta?: unknown): void {
    this.rotateIfNeeded()
    const timestamp = new Date().toISOString()
    const metaText = meta !== undefined ? ` ${safeStringify(meta)}` : ''
    const line = `[${timestamp}] [${level}] ${message}${metaText}\n`
    try {
      fs.appendFileSync(this.logFile, line, { encoding: 'utf-8' })
    } catch {
      // Wenn selbst das Logging fehlschlaegt, darf die App nicht abstuerzen.
    }
  }

  info(message: string, meta?: unknown): void {
    this.write('INFO', message, meta)
  }

  warn(message: string, meta?: unknown): void {
    this.write('WARN', message, meta)
  }

  error(message: string, meta?: unknown): void {
    this.write('ERROR', message, meta)
  }
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}\n${value.stack ?? ''}`
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
