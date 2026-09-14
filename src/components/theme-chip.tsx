import Link from "next/link";
import {
  CLASS_STYLES,
  POSTURE_STYLES,
  themeStyle,
} from "@/lib/theme-style";
import type { CanonicalInsight } from "@/lib/schema";

export function ThemeChip({
  id,
  name,
  href,
  current,
}: {
  id: string;
  name: string;
  href?: string;
  current?: boolean;
}) {
  const s = themeStyle(id);
  const className = `inline-flex max-w-full items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium no-underline ${
    current ? "border-foreground/30" : "hover:border-foreground/20"
  }`;
  const style = {
    color: s.fg,
    backgroundColor: s.bg,
    borderColor: s.border,
  };
  if (href) {
    return (
      <Link href={href} className={className} style={style}>
        {name}
      </Link>
    );
  }
  return (
    <span className={className} style={style}>
      {name}
    </span>
  );
}

export function ClassChip({
  value,
}: {
  value: CanonicalInsight["classification"];
}) {
  const s = CLASS_STYLES[value];
  return (
    <span
      className="inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium"
      style={{ color: s.fg, backgroundColor: s.bg, borderColor: s.border }}
    >
      {s.label}
    </span>
  );
}

export function PostureChip({ posture }: { posture: string }) {
  const s = POSTURE_STYLES[posture] ?? POSTURE_STYLES.EMPTY!;
  return (
    <span
      className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium"
      style={{ color: s.fg, backgroundColor: s.bg }}
    >
      {s.label}
    </span>
  );
}
