import type Database from "better-sqlite3";

const IMAGE_PDF_EXT = /\.(png|jpe?g|gif|webp|pdf)$/i;

export type EvalFile = {
  path: string;
  mime: string;
  content: Buffer;
};

export function isImageOrPdfPath(path: string): boolean {
  return IMAGE_PDF_EXT.test(path);
}

export function mimeFromPath(path: string): string | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lower.endsWith(".gif")) {
    return "image/gif";
  }
  if (lower.endsWith(".webp")) {
    return "image/webp";
  }
  if (lower.endsWith(".pdf")) {
    return "application/pdf";
  }
  return null;
}

export function contentFromSample(content: string): Buffer {
  const trimmed = content.trim();
  if (/^[A-Za-z0-9+/]+=*$/.test(trimmed) && trimmed.length >= 16) {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length > 0) {
      return decoded;
    }
  }
  return Buffer.from(content);
}

export function insertEvalFile(
  db: Database.Database,
  file: { evalId: string; path: string; mime: string; content: Buffer },
): void {
  db.prepare(
    `INSERT OR REPLACE INTO eval_files (eval_id, path, mime, content)
     VALUES (?, ?, ?, ?)`,
  ).run(file.evalId, file.path, file.mime, file.content);
}

export function listEvalFiles(
  db: Database.Database,
  evalId: string,
): EvalFile[] {
  const rows = db
    .prepare(`SELECT path, mime, content FROM eval_files WHERE eval_id = ?`)
    .all(evalId) as Array<{ path: string; mime: string; content: Buffer }>;
  return rows.map((row) => ({
    path: row.path,
    mime: row.mime,
    content: Buffer.isBuffer(row.content)
      ? row.content
      : Buffer.from(row.content ?? []),
  }));
}

export function getEvalFile(
  db: Database.Database,
  evalId: string,
  path: string,
): EvalFile | null {
  const row = db
    .prepare(
      `SELECT path, mime, content FROM eval_files WHERE eval_id = ? AND path = ?`,
    )
    .get(evalId, path) as
    | { path: string; mime: string; content: Buffer }
    | undefined;
  if (!row) {
    return null;
  }
  return {
    path: row.path,
    mime: row.mime,
    content: Buffer.isBuffer(row.content)
      ? row.content
      : Buffer.from(row.content ?? []),
  };
}

export function attachImagePdfFiles(
  db: Database.Database,
  evalIds: string[],
  files: Array<{ path: string; content?: string }>,
): void {
  const imagePdf = files.filter((f) => isImageOrPdfPath(f.path));
  if (imagePdf.length === 0 || evalIds.length === 0) {
    return;
  }
  for (const evalId of evalIds) {
    for (const file of imagePdf) {
      const mime = mimeFromPath(file.path);
      if (!mime) {
        continue;
      }
      insertEvalFile(db, {
        evalId,
        path: file.path,
        mime,
        content:
          file.content != null && file.content.length > 0
            ? contentFromSample(file.content)
            : Buffer.alloc(0),
      });
    }
  }
}
