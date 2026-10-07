/** PowerPoint keys: → ↓ PageDown Space forward; ← ↑ PageUp back; Home/End jump; Esc ends. */
export function keyStep(key: string): number | "first" | "last" | "end" | null {
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
    case "PageDown":
    case " ":
    case "Spacebar":
      return 1;
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
      return -1;
    case "Home":
      return "first";
    case "End":
      return "last";
    case "Escape":
      return "end";
    default:
      return null;
  }
}
