import JSZip from "jszip";
import "@/modules";
import { apiErrorResponse, requireCustomerContext } from "@/modules/auth/api-guard";
import { CLIENT_DEMO_PACK } from "@/lib/demo/client-pack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The demo's input documents as one ZIP (KAN-139): the same seven files demo
 * mode accepts, under their demo filenames, ready to upload in a client demo.
 * Signed-in users only.
 */
export async function GET(request: Request) {
  try {
    await requireCustomerContext();
    // ?file=<name>: one document on its own, as text.
    const name = new URL(request.url).searchParams.get("file");
    if (name) {
      const file = CLIENT_DEMO_PACK.find((f) => f.filename === name);
      if (!file) return Response.json({ error: `No demo file called ${name}.` }, { status: 404 });
      return new Response(file.text, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": `attachment; filename="${file.filename}"`,
          "cache-control": "no-store",
        },
      });
    }
    const zip = new JSZip();
    for (const file of CLIENT_DEMO_PACK) zip.file(file.filename, file.text);
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
