import { redirect } from "next/navigation";

/** The matrix is Prioritize now; keep the old route for bookmarks. */
export default function MatrixPage() {
  redirect("/?place=plan");
}
