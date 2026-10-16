import JSZip from "jszip";
import "@/modules";
import { apiErrorResponse, requireCustomerContext } from "@/modules/auth/api-guard";
import { DEMO_PACK } from "@/lib/iegp/demo-pack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The demo's input documents as one ZIP (KAN-139): the same seven files demo
 * mode accepts, under their demo filenames, ready to upload in a client demo.
 * Signed-in users only.
 */
export async function GET() {
  try {
    await requireCustomerContext();
    const zip = new JSZip();
    for (const file of DEMO_PACK) zip.file(file.filename, file.text);
    const body = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
    return new Response(body, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="velmara-demo-files.zip"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
