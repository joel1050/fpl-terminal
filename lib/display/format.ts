/** Money is stored in integer tenths; this is the display form, £10.5. */
export function money(tenths: number | undefined): string {
  return tenths === undefined || !Number.isFinite(tenths) ? "—" : `£${(tenths / 10).toFixed(1)}`;
}

/** Points to one decimal place. Zero and missing values show a dash. */
export function points(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) || value === 0 ? "—" : value.toFixed(1);
}
