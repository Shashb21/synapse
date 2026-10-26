/**
 * Filename eligibility and user-facing format copy for Accuracy source uploads.
 * This module is shared by the upload API and browser form, so it has no server dependencies.
 */

const SUPPORTED_EXTENSIONS = [".pptx", ".docx", ".xlsx", ".xls", ".pdf", ".txt", ".md"];
const SUPPORTED_EXTENSION_SET = new Set(SUPPORTED_EXTENSIONS);

export const ACCURACY_UPLOAD_ACCEPT = SUPPORTED_EXTENSIONS.join(",");
export const ACCURACY_UPLOAD_FORMATS_LABEL = "PPTX, DOCX, XLSX, XLS, PDF, TXT, or Markdown (.md)";

/**
 * Return the validation message for an unsupported Accuracy upload filename.
 *
 * Parameters
 * ----------
 * filename : string
 *     Client-provided filename. Only the final extension determines eligibility.
 *
 * Returns
 * -------
 * string | null
 *     Conversion guidance or supported extensions when ineligible; otherwise null.
 *     Eligibility does not guarantee that the file contents can be parsed.
 */
export function accuracyUploadFormatError(filename: string): string | null {
  const dotIndex = filename.lastIndexOf(".");
  const extension = dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : "";
  if (extension === ".ppt") {
    return "Legacy .ppt files are not supported. Save the file as .pptx and upload it again.";
  }
  if (SUPPORTED_EXTENSION_SET.has(extension)) return null;
  return `Unsupported file format. Supported extensions: ${SUPPORTED_EXTENSIONS.join(", ")}.`;
}
