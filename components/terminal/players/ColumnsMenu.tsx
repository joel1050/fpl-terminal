import { useRef, useState } from "react";
import { Sheet } from "@/components/shell/Sheet";
import { PLAYER_COLUMN_KEYS, type PlayerColumnKey } from "@/store/terminalStore";
import { PLAYER_COLUMN_LABELS } from "./columns";

export interface ColumnsMenuProps {
  columns: PlayerColumnKey[];
  onChange: (keys: PlayerColumnKey[]) => void;
}

/** A popover with one checkbox per optional players-table column. Each tick is saved at once. */
export function ColumnsMenu({ columns, onChange }: ColumnsMenuProps) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const setColumn = (key: PlayerColumnKey, on: boolean) => {
    onChange(PLAYER_COLUMN_KEYS.filter((candidate) => (candidate === key ? on : columns.includes(candidate))));
  };
  return (
    <div className="columns-menu-wrap">
      <button ref={button} type="button" className="players-columns-button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        Columns<span aria-hidden="true"> ▾</span>
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Columns" variant="popover" anchor={button}>
        <div className="columns-options">
          {PLAYER_COLUMN_KEYS.map((key) => (
            <label key={key} className="columns-option">
              <input type="checkbox" checked={columns.includes(key)} onChange={(event) => setColumn(key, event.target.checked)} />
              <span>{PLAYER_COLUMN_LABELS[key]}</span>
            </label>
          ))}
        </div>
      </Sheet>
    </div>
  );
}
