"use client";

import { useState } from "react";

export type SortDirection = "asc" | "desc";

export type SortValue = string | number | null | undefined;

/**
 * Missing or non-finite values always sort to the bottom, whichever way the
 * column is flipped.
 */
export function compareSortValues(left: SortValue, right: SortValue, direction: SortDirection): number {
  const leftMissing = left === null || left === undefined || (typeof left === "number" && !Number.isFinite(left));
  const rightMissing = right === null || right === undefined || (typeof right === "number" && !Number.isFinite(right));
  if (leftMissing || rightMissing) return leftMissing && rightMissing ? 0 : leftMissing ? 1 : -1;
  const result = typeof left === "string" || typeof right === "string"
    ? String(left).localeCompare(String(right))
    : left - right;
  return direction === "asc" ? result : -result;
}

export function useSortState<K extends string>() {
  const [sortKey, setSortKey] = useState<K | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const onSort = (key: K) => {
    if (sortKey === key) {
      setSortDirection((direction) => (direction === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDirection("desc");
    }
  };
  return { sortKey, sortDirection, onSort };
}

export function SortableHead<K extends string>({
  label,
  sortKey,
  active,
  direction,
  onSort,
}: {
  label: string;
  sortKey: K;
  active: K | null;
  direction: SortDirection;
  onSort: (key: K) => void;
}) {
  return (
    <th aria-sort={active === sortKey ? (direction === "asc" ? "ascending" : "descending") : undefined}>
      <button type="button" className={`sort-button ${active === sortKey ? "active" : ""}`} onClick={() => onSort(sortKey)}>
        {label}
        {active === sortKey && <span>{direction === "asc" ? " ↑" : " ↓"}</span>}
      </button>
    </th>
  );
}
