import type { TerminalFilters } from "@/store/terminalStore";

/** One removable chip for a filter that is not at its default. `clear` puts that filter back. */
export interface ActiveFilterChip {
  key: keyof TerminalFilters;
  label: string;
  clear: Partial<TerminalFilters>;
}

const AVAILABILITY_LABELS: Record<Exclude<TerminalFilters["availability"], "ALL">, string> = {
  AVAILABLE: "Available",
  DOUBTFUL: "Doubtful",
  UNAVAILABLE: "Unavailable",
};

const CONFIDENCE_LABELS: Record<Exclude<TerminalFilters["confidence"], "ALL">, string> = {
  HIGH: "High confidence",
  MEDIUM: "Medium confidence",
  LOW: "Low confidence",
};

const RISK_LABELS: Record<Exclude<TerminalFilters["risk"], "ALL">, string> = {
  LOW: "Low risk",
  MEDIUM: "Medium risk",
  HIGH: "High risk",
};

export const QUICK_LABELS: Record<Exclude<TerminalFilters["quick"], "ALL">, string> = {
  VALUE: "Value",
  PREMIUM: "Premium",
  DIFFERENTIAL: "Differential",
  NAILED: "Nailed",
  CHEAP: "Cheap",
};

/**
 * The narrowing filters that are not at their default, in filter-row order.
 * Position and search are left out because the filter row shows them already.
 */
export function activeFilterChips(filters: TerminalFilters): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = [];
  if (filters.club) chips.push({ key: "club", label: `Club ${filters.club}`, clear: { club: "" } });
  if (filters.minPrice) chips.push({ key: "minPrice", label: `Min £${filters.minPrice}m`, clear: { minPrice: "" } });
  if (filters.maxPrice) chips.push({ key: "maxPrice", label: `Max £${filters.maxPrice}m`, clear: { maxPrice: "" } });
  if (filters.minOwnership) chips.push({ key: "minOwnership", label: `Min ${filters.minOwnership}% owned`, clear: { minOwnership: "" } });
  if (filters.maxOwnership) chips.push({ key: "maxOwnership", label: `Max ${filters.maxOwnership}% owned`, clear: { maxOwnership: "" } });
  if (filters.availability !== "ALL") chips.push({ key: "availability", label: AVAILABILITY_LABELS[filters.availability], clear: { availability: "ALL" } });
  if (filters.confidence !== "ALL") chips.push({ key: "confidence", label: CONFIDENCE_LABELS[filters.confidence], clear: { confidence: "ALL" } });
  if (filters.risk !== "ALL") chips.push({ key: "risk", label: RISK_LABELS[filters.risk], clear: { risk: "ALL" } });
  if (filters.affordableOnly) chips.push({ key: "affordableOnly", label: "Affordable only", clear: { affordableOnly: false } });
  if (filters.excludeSelected) chips.push({ key: "excludeSelected", label: "Hide selected", clear: { excludeSelected: false } });
  if (filters.quick !== "ALL") chips.push({ key: "quick", label: QUICK_LABELS[filters.quick], clear: { quick: "ALL" } });
  return chips;
}

/** The number on the "Filters · n" button. */
export function countActiveFilters(filters: TerminalFilters): number {
  return activeFilterChips(filters).length;
}
