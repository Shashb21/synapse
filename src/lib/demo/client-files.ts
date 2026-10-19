import { CLIENT_DEMO_PACK } from "./client-pack";
import type { DemoSourceFile } from "@/lib/iegp/demo-pack";

const squash = (text: string) => text.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
const BY_TEXT = new Map(CLIENT_DEMO_PACK.map((file) => [squash(file.text), file]));

/** The client demo document this upload is (same text, whitespace aside), or null (KAN-138). */
export function clientDemoFileFor(text: string): DemoSourceFile | null {
  return BY_TEXT.get(squash(text)) ?? null;
}

/** Why a client-demo workspace refused an upload. */
export const DEMO_UPLOAD_REFUSED = (filename: string) =>
  `${filename} is not one of the demo files. This workspace is a client demo that runs on the seven Velmara demo documents only, so nothing was uploaded and no model was called. Use "Download demo files" to get them, or ingest them from the list above.`;
