"use client";

import { useId, useState, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** Small form primitives shared by the setup wizard steps. */

export function FieldError({ message }: { message?: string }) {
  return message ? (
    <span role="alert" className="text-[11px] text-destructive">
      {message}
    </span>
  ) : null;
}

export function Field({
  label,
  required,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("grid content-start gap-1 text-[11px] text-muted-foreground", className)}>
      <span>
        {label}
        {required ? (
          <span className="text-[var(--chart-1)]" aria-hidden>
            {" "}
            *
          </span>
        ) : null}
      </span>
      {children}
      {hint ? <span className="text-[10px] text-muted-foreground/80">{hint}</span> : null}
      <FieldError message={error} />
    </label>
  );
}

export function TextField({
  label,
  value,
  onChange,
  required,
  hint,
  error,
  placeholder,
  type = "text",
  multiline,
  list,
  className,
  testId,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  hint?: string;
  error?: string;
  placeholder?: string;
  type?: "text" | "date" | "number";
  multiline?: boolean;
  list?: string;
  className?: string;
  testId?: string;
}) {
  return (
    <Field label={label} required={required} hint={hint} error={error} className={className}>
      {multiline ? (
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          aria-required={required || undefined}
          data-testid={testId}
          className="min-h-[72px] text-[13px]"
        />
      ) : (
        <Input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          aria-required={required || undefined}
          list={list}
          data-testid={testId}
        />
      )}
    </Field>
  );
}

/** A row of mutually exclusive choices, rendered as toggle buttons. */
export function ChoiceField<T extends string | number>({
  label,
  value,
  options,
  onChange,
  required,
  error,
}: {
  label: string;
  value: T | "";
  options: readonly { id: T; label: string }[];
  onChange: (value: T) => void;
  required?: boolean;
  error?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid gap-1 text-[11px] text-muted-foreground">
      <span>
        {label}
        {required ? <span className="text-[var(--chart-1)]"> *</span> : null}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => {
          const on = option.id === value;
          return (
            <button
              key={String(option.id)}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(option.id)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-[12px] transition-colors",
                on
                  ? "border-[var(--chart-1)] bg-[var(--chart-1)]/15 text-foreground"
                  : "border-border text-muted-foreground hover:border-[var(--chart-1)]/40 hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <FieldError message={error} />
    </div>
  );
}

/** Free tags (markets, comparators, settings…) with optional one-click suggestions. */
export function TagField({
  label,
  values,
  onChange,
  suggestions = [],
  required,
  hint,
  error,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  suggestions?: readonly string[];
  required?: boolean;
  hint?: string;
  error?: string;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");
  const inputId = useId();
  const has = (tag: string) => values.some((value) => value.toLowerCase() === tag.toLowerCase());
  const add = (raw: string) => {
    const tags = raw
      .split(/[,;]/)
      .map((tag) => tag.trim().replace(/\s+/g, " "))
      .filter(Boolean);
    const next = [...values];
    for (const tag of tags) if (!next.some((value) => value.toLowerCase() === tag.toLowerCase())) next.push(tag);
    onChange(next);
    setDraft("");
  };
  const open = suggestions.filter((tag) => !has(tag));
  return (
    <div className="grid gap-1 text-[11px] text-muted-foreground">
      <label htmlFor={inputId}>
        {label}
        {required ? <span className="text-[var(--chart-1)]"> *</span> : null}
      </label>
      {values.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {values.map((value) => (
            <li
              key={value}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-card/60 py-0.5 pl-2 pr-1 text-[12px] text-foreground"
            >
              {value}
              <button
                type="button"
                aria-label={`Remove ${value}`}
                className="rounded-full p-0.5 text-muted-foreground hover:text-foreground"
                onClick={() => onChange(values.filter((item) => item !== value))}
              >
                <X className="size-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex gap-1.5">
        <Input
          id={inputId}
          value={draft}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (draft.trim()) add(draft);
            }
          }}
        />
        <Button type="button" size="sm" variant="outline" disabled={!draft.trim()} onClick={() => add(draft)}>
          Add
        </Button>
      </div>
      {open.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {open.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => add(tag)}
              className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-[var(--chart-1)]/50 hover:text-foreground"
            >
              <Plus className="size-3" aria-hidden />
              {tag}
            </button>
          ))}
        </div>
      ) : null}
      {hint ? <span className="text-[10px] text-muted-foreground/80">{hint}</span> : null}
      <FieldError message={error} />
    </div>
  );
}

/** An editable list of records (indications, objectives, competitors…). */
export function ListField<T>({
  label,
  items,
  onChange,
  blank,
  addLabel,
  renderItem,
  required,
  error,
  hint,
}: {
  label: string;
  items: T[];
  onChange: (items: T[]) => void;
  blank: () => T;
  addLabel: string;
  renderItem: (item: T, update: (patch: Partial<T>) => void, index: number) => ReactNode;
  required?: boolean;
  error?: string;
  hint?: string;
}) {
  return (
    <div className="grid gap-2 text-[11px] text-muted-foreground" role="group" aria-label={label}>
      <span>
        {label}
        {required ? <span className="text-[var(--chart-1)]"> *</span> : null}
      </span>
      {hint ? <span className="text-[10px] text-muted-foreground/80">{hint}</span> : null}
      {items.length > 0 ? (
        <ol className="grid gap-2">
          {items.map((item, index) => (
            <li
              key={index}
              aria-label={`${label} ${index + 1}`}
              className="relative grid gap-2 rounded-md border border-border bg-card/40 p-3 pr-9"
            >
              {renderItem(
                item,
                (patch) => onChange(items.map((row, i) => (i === index ? { ...row, ...patch } : row))),
                index,
              )}
              <button
                type="button"
                aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
                className="absolute right-2 top-2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => onChange(items.filter((_, i) => i !== index))}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ol>
      ) : null}
      <Button type="button" size="sm" variant="outline" className="w-fit" onClick={() => onChange([...items, blank()])}>
        <Plus className="size-3.5" aria-hidden />
        {addLabel}
      </Button>
      <FieldError message={error} />
    </div>
  );
}
