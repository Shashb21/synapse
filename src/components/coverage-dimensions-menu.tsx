"use client";

import { ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  COVERAGE_DIMENSIONS,
  DIMENSION_LABELS,
  type CoverageDimension,
  type DimensionValue,
  type OverallCoverage,
} from "@/lib/iegp/enums";

function formatOverall(overall: OverallCoverage | null): string {
  if (!overall) return "unknown";
  return overall.replaceAll("_", " ");
}

export function CoverageDimensionsMenu({
  overall,
  dimensions,
}: {
  overall: OverallCoverage | null;
  dimensions: Record<CoverageDimension, DimensionValue> | null;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button type="button" size="xs" variant="outline" className="font-normal" />
        }
      >
        Dimensions
        <ChevronDownIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-72 min-w-72 p-2" align="start">
        {!dimensions ? (
          <p className="px-1.5 py-1 text-xs text-muted-foreground">
            No coverage dimensions on this mapping yet.
          </p>
        ) : (
          <dl className="grid gap-1">
            <div className="flex items-baseline justify-between gap-3 px-1.5 py-0.5">
              <dt className="text-xs text-muted-foreground">Overall</dt>
              <dd className="text-xs capitalize text-foreground">{formatOverall(overall)}</dd>
            </div>
            {COVERAGE_DIMENSIONS.map((dim) => (
              <div key={dim} className="flex items-baseline justify-between gap-3 px-1.5 py-0.5">
                <dt className="text-xs text-muted-foreground">{DIMENSION_LABELS[dim]}</dt>
                <dd className="text-xs capitalize text-foreground">{dimensions[dim]}</dd>
              </div>
            ))}
          </dl>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
