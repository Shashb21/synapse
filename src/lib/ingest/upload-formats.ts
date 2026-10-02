/**
 * The file formats a customer can add as a source (KAN-68), shared by the Add a source form
 * and the ingest action so both refuse the same things with the same words. Text files are
 * sent as text; the rest are sent as base64 and parsed by S1.
 */

export const TEXT_EXTENSIONS = [".txt", ".md", ".markdown"] as const;

/** Binary formats S1 can extract, by extension, with the mime S0 records. */
export const BINARY_FORMATS = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;

/** Old Office formats S1 cannot read, and the format to save them as. */
const LEGACY_FORMATS: Record<string, string> = { ".doc": ".docx", ".ppt": ".pptx", ".xls": ".xlsx" };

/**
 * 3 MB of file is about 4 MB once base64-encoded, which keeps the JSON body under Vercel's
 * 4.5 MB request limit.
 */
export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

export const UPLOAD_ACCEPT = [...Object.keys(BINARY_FORMATS), ...TEXT_EXTENSIONS].join(",");

export const UPLOAD_FORMATS_LABEL = "PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx), .txt or .md";

export const UNSUPPORTED_FORMAT = `Choose a ${UPLOAD_FORMATS_LABEL} file, or paste the text below.`;

export const TOO_LARGE = `That file is over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB. Split it, or paste the part you need below.`;

export type UploadKind = { kind: "text" } | { kind: "binary"; mime: string } | { kind: "refused"; reason: string };

function extensionOf(filename: string): string {
  const match = filename.toLowerCase().match(/\.[a-z0-9]+$/);
  return match ? match[0] : "";
}

/** How a file with this name is sent, or why it is refused. */
export function uploadKindOf(filename: string): UploadKind {
  const ext = extensionOf(filename);
  if ((TEXT_EXTENSIONS as readonly string[]).includes(ext)) return { kind: "text" };
  const mime = BINARY_FORMATS[ext as keyof typeof BINARY_FORMATS];
  if (mime) return { kind: "binary", mime };
  const modern = LEGACY_FORMATS[ext];
  if (modern) {
    return { kind: "refused", reason: `${ext} is an old Office format. Save it as ${modern} and choose it again.` };
  }
  return { kind: "refused", reason: UNSUPPORTED_FORMAT };
}
