import { redirect } from "next/navigation";
import { ROOM_ENABLED } from "@/lib/room/enabled";

/** The chaptered presentation is retired: Room is the presenter view over the real pages. */
export default function PresentationPage() {
  redirect(ROOM_ENABLED ? "/room" : "/");
}
