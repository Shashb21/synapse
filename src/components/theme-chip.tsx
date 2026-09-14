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
  const className = `inline-flex max-w-full items-center rounded-full border px-2.5 py-1 text-xs font-medium no-underline transition ${
    current ? "opacity-70" : "hover:brightness-125"
  }`;
  const style = {
    color: s.fg,
    backgroundColor: s.bg,
    borderColor: s.border,
  };
  if (href && !current) {
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
      className="inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold"
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
      className="inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold"
      style={{ color: s.fg, backgroundColor: s.bg }}
    >
      {s.label}
    </span>
  );
}
