import { activeFilterChips } from "@/lib/display/filterCount";
import type { TerminalFilters } from "@/store/terminalStore";

export interface ActiveFiltersProps {
  filters: TerminalFilters;
  setFilters: (filters: Partial<TerminalFilters>) => void;
}

/** One removable chip per filter that is on. Each chip puts only its own filter back to the default. */
export function ActiveFilters({ filters, setFilters }: ActiveFiltersProps) {
  const chips = activeFilterChips(filters);
  if (chips.length === 0) return null;
  return (
    <ul className="active-filters" aria-label="Active filters">
      {chips.map((chip) => (
        <li key={chip.key}>
          <button type="button" className="active-filter-chip" aria-label={`Remove ${chip.label}`} onClick={() => setFilters(chip.clear)}>
            <span>{chip.label}</span>
            <span aria-hidden="true">×</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
