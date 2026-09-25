import { redirect } from "next/navigation";

/** The chaptered presentation is retired: Room is the presenter view over the real pages. */
export default function PresentationPage() {
  redirect("/room");
}
