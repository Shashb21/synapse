"use client";

import { createContext, useContext, type ReactNode, type RefObject } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

/** A record can replace the current panel body without opening a second sheet. */
export const RecordNavigation = createContext<{ openTactic: (id: string, trigger: HTMLElement) => void } | null>(null);
export const useRecordNavigation = () => useContext(RecordNavigation);

/** Common modal record interaction: retained workspace, contained focus and an explicit return target. */
export function RecordPanel({ open, onClose, title, description, returnFocusRef, children }: {
  open: boolean; onClose: () => void; title: string; description: string;
  returnFocusRef: RefObject<HTMLElement | null>; children: ReactNode;
}) {
  return <Sheet open={open} onOpenChange={next => { if (!next) onClose(); }}>
    <SheetContent side="right" className="data-[side=right]:w-full data-[side=right]:sm:max-w-2xl" finalFocus={returnFocusRef}>
      <SheetHeader className="border-b border-border pr-14">
        <SheetTitle>{title}</SheetTitle>
        <SheetDescription>{description}</SheetDescription>
      </SheetHeader>
      <div className="min-w-0 break-words px-4 pb-6">{children}</div>
    </SheetContent>
  </Sheet>;
}
