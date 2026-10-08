import { Sheet } from "@/components/shell/Sheet";
import { QUICK_LABELS } from "@/lib/display/filterCount";
import type { TerminalFilters } from "@/store/terminalStore";

const QUICK_OPTIONS: TerminalFilters["quick"][] = ["ALL", "VALUE", "PREMIUM", "DIFFERENTIAL", "NAILED", "CHEAP"];

export interface FilterSheetProps {
  open: boolean;
  onClose: () => void;
  variant: "bottom" | "popover";
  filters: TerminalFilters;
  setFilters: (filters: Partial<TerminalFilters>) => void;
  clubs: string[];
  onReset: () => void;
  /** On desktop the filter row already holds Club and Maximum price, so the sheet leaves them out. */
  rowHoldsClubAndMaxPrice: boolean;
}

/** Every filter that is not in the filter row, in one sheet. Position and search stay on the row. */
export function FilterSheet({ open, onClose, variant, filters, setFilters, clubs, onReset, rowHoldsClubAndMaxPrice }: FilterSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title="Filters" variant={variant}>
      <div className="filter-sheet">
        <fieldset className="filter-group">
          <legend>Price, £m</legend>
          <div className="filter-pair">
            <input inputMode="decimal" value={filters.minPrice} onChange={(event) => setFilters({ minPrice: event.target.value })} placeholder="Min £" aria-label="Minimum price" />
            {!rowHoldsClubAndMaxPrice && <input inputMode="decimal" value={filters.maxPrice} onChange={(event) => setFilters({ maxPrice: event.target.value })} placeholder="Max £" aria-label="Maximum price" />}
          </div>
        </fieldset>
        <fieldset className="filter-group">
          <legend>Ownership, %</legend>
          <div className="filter-pair">
            <input inputMode="decimal" value={filters.minOwnership} onChange={(event) => setFilters({ minOwnership: event.target.value })} placeholder="Min %" aria-label="Minimum ownership" />
            <input inputMode="decimal" value={filters.maxOwnership} onChange={(event) => setFilters({ maxOwnership: event.target.value })} placeholder="Max %" aria-label="Maximum ownership" />
          </div>
        </fieldset>
        {!rowHoldsClubAndMaxPrice && (
          <fieldset className="filter-group">
            <legend>Club</legend>
            <select value={filters.club} onChange={(event) => setFilters({ club: event.target.value })} aria-label="Filter by club">
              <option value="">All clubs</option>
              {clubs.map((club) => <option value={club} key={club}>{club}</option>)}
            </select>
          </fieldset>
        )}
        <fieldset className="filter-group">
          <legend>Availability</legend>
          <select value={filters.availability} onChange={(event) => setFilters({ availability: event.target.value as TerminalFilters["availability"] })} aria-label="Filter by availability">
            <option value="ALL">All statuses</option>
            <option value="AVAILABLE">Available</option>
            <option value="DOUBTFUL">Doubtful</option>
            <option value="UNAVAILABLE">Unavailable</option>
          </select>
        </fieldset>
        <fieldset className="filter-group">
          <legend>Confidence</legend>
          <select value={filters.confidence} onChange={(event) => setFilters({ confidence: event.target.value as TerminalFilters["confidence"] })} aria-label="Filter by confidence">
            <option value="ALL">All confidence</option>
            <option value="HIGH">High</option>
            <option value="MEDIUM">Medium</option>
            <option value="LOW">Low</option>
          </select>
        </fieldset>
        <fieldset className="filter-group">
          <legend>Risk</legend>
          <select value={filters.risk} onChange={(event) => setFilters({ risk: event.target.value as TerminalFilters["risk"] })} aria-label="Filter by risk">
            <option value="ALL">All risk</option>
            <option value="LOW">Low</option>
            <option value="MEDIUM">Medium</option>
            <option value="HIGH">High</option>
          </select>
        </fieldset>
        <fieldset className="filter-group">
          <legend>Quick filters</legend>
          <div className="filter-chip-row">
            {QUICK_OPTIONS.map((quick) => (
              <button type="button" key={quick} aria-pressed={filters.quick === quick} onClick={() => setFilters({ quick })}>
                {quick === "ALL" ? "All" : QUICK_LABELS[quick]}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="filter-checks">
          <label><input type="checkbox" checked={filters.affordableOnly} onChange={(event) => setFilters({ affordableOnly: event.target.checked })} /> Affordable only</label>
          <label><input type="checkbox" checked={filters.excludeSelected} onChange={(event) => setFilters({ excludeSelected: event.target.checked })} /> Hide selected</label>
        </div>
        <button type="button" className="filter-reset" onClick={onReset}>Reset filters</button>
      </div>
    </Sheet>
  );
}
