/** Money is stored in integer tenths; this is the display form, £10.5. */
export function money(tenths: number | undefined): string {
  return tenths === undefined || !Number.isFinite(tenths) ? "—" : `£${(tenths / 10).toFixed(1)}`;
}

/** Points to one decimal place. Zero and missing values show a dash. */
export function points(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) || value === 0 ? "—" : value.toFixed(1);
}

/** Money in tenths as millions without the symbol, 9.6, for columns already headed "£m". */
export function millions(tenths: number | undefined): string {
  return tenths === undefined || !Number.isFinite(tenths) || tenths <= 0 ? "—" : (tenths / 10).toFixed(1);
}

/** Ownership as a whole percent. Below 1% it keeps one decimal, so a rare pick does not read as 0%. */
export function ownershipPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return "—";
  return value < 1 ? `${value.toFixed(1)}%` : `${Math.round(value)}%`;
}

/**
 * A count short enough for a narrow column: exact below 100,000, then 376.5k,
 * 1.30m and 10.8m. Callers that need the exact figure put it in a title.
 */
export function compactCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  const size = Math.abs(value);
  if (size < 100_000) return value.toLocaleString("en-GB");
  if (size < 999_950) return `${(value / 1_000).toFixed(1)}k`;
  if (size < 9_995_000) return `${(value / 1_000_000).toFixed(2)}m`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}
