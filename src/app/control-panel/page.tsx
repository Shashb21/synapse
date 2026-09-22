import { redirect } from "next/navigation";

/** Canonical control panel URL is `/control`. */
export default function ControlPanelRedirect() {
  redirect("/control");
}
