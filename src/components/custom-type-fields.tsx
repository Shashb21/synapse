"use client";

import { useId, useState } from "react";
import {
  CUSTOM_TYPE_COLORS,
  CUSTOM_TYPE_LABEL_MAX,
  type CustomTacticType,
} from "@/lib/iegp/custom-tactic-type";
import { cn } from "@/lib/utils";

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * "+ Custom type" from the design (KAN-51): a name and a colour on top of the standard type.
 * Posts `custom_type_label` and `custom_type_color` with the surrounding form. A name already
 * used in the workspace takes that type's colour, so one name keeps one colour.
 */
export function CustomTypeFields({
  initial = null,
  inUse = [],
  clearable = false,
}: {
  initial?: CustomTacticType | null;
  inUse?: CustomTacticType[];
  /** Editing an existing tactic: turning it off posts a blank name, which clears the custom type. */
  clearable?: boolean;
}) {
  const listId = useId();
  const [on, setOn] = useState(Boolean(initial));
  const [label, setLabel] = useState(initial?.label ?? "");
  const [color, setColor] = useState<string>(initial?.color ?? CUSTOM_TYPE_COLORS[0]);
  const validColor = HEX.test(color);

  function pickLabel(next: string) {
    setLabel(next);
    const known = inUse.find((row) => row.label.toLowerCase() === next.trim().toLowerCase());
    if (known) setColor(known.color);
  }

  if (!on) {
    return (
      <div className="grid gap-1">
        {clearable && initial ? <input type="hidden" name="custom_type_label" value="" /> : null}
        <button
          type="button"
          onClick={() => setOn(true)}
          className="justify-self-start rounded-md border border-border bg-muted px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
        >
          + Custom type
        </button>
      </div>
    );
  }

  return (
    <fieldset className="grid gap-2 rounded-md border border-primary/30 bg-primary/5 p-2">
      <legend className="px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        Custom type
      </legend>
      <input type="hidden" name="custom_type_color" value={color} />
      <div className="flex items-center gap-2">
        <input
          name="custom_type_label"
          aria-label="Custom type name"
          required
          maxLength={CUSTOM_TYPE_LABEL_MAX}
          list={listId}
          placeholder="Custom type name…"
          value={label}
          onChange={(event) => pickLabel(event.target.value)}
          className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-card px-2.5 text-sm"
        />
        <datalist id={listId}>
          {inUse.map((row) => (
            <option key={row.label} value={row.label} />
          ))}
        </datalist>
        <button
          type="button"
          onClick={() => setOn(false)}
          className="shrink-0 rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-[11px] font-medium text-indigo-800 dark:text-indigo-300"
        >
          ← Standard type
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1" role="radiogroup" aria-label="Custom type colour">
        {CUSTOM_TYPE_COLORS.map((swatch) => (
          <button
            key={swatch}
            type="button"
            role="radio"
            aria-checked={color.toLowerCase() === swatch}
            aria-label={swatch}
            onClick={() => setColor(swatch)}
            className={cn(
              "size-[18px] rounded border-2",
              color.toLowerCase() === swatch ? "border-foreground" : "border-transparent",
            )}
            style={{ backgroundColor: swatch }}
          />
        ))}
        <input
          aria-label="Custom type colour (hex)"
          value={color}
          onChange={(event) => setColor(event.target.value.trim())}
          className={cn(
            "ml-1 h-6 w-20 rounded border bg-card px-1.5 font-mono text-[11px]",
            validColor ? "border-input" : "border-destructive",
          )}
        />
      </div>
      {!validColor ? <p className="text-[11px] text-destructive">Use a hex colour like #4f46e5.</p> : null}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-muted-foreground">Preview</span>
        <span
          data-testid="custom-type-preview"
          className="inline-flex h-[18px] items-center rounded-sm border-l-[3px] px-1.5 text-[10px] font-semibold"
          style={validColor ? { borderLeftColor: color, backgroundColor: `${color}1a`, color } : undefined}
        >
          {label.trim() || "Custom"}
        </span>
      </div>
      <p className="text-[11px] text-muted-foreground">
        The standard type above still decides how the tactic maps and counts; the custom name and colour are
        what everyone sees.
      </p>
    </fieldset>
  );
}
