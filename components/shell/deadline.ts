const DEADLINE_DATE = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

/** The deadline as the top bar shows it, in local time: "Sat 10 Oct, 11:00". */
export function formatDeadlineDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : DEADLINE_DATE.format(date);
}

/** Time left to the deadline in its two largest units: "3d 5h", "5h 12m", "12m", or "Closed". */
export function formatTimeLeft(value: string, now = Date.now()): string {
  const deadline = Date.parse(value);
  if (!Number.isFinite(deadline)) return "—";
  const totalMinutes = Math.max(0, Math.ceil((deadline - now) / 60_000));
  if (totalMinutes === 0) return "Closed";
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor(totalMinutes % 1_440 / 60);
  const minutes = totalMinutes % 60;
  if (days) return `${days}d ${hours}h`;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function formatDeadlineCountdown(value: string, now = Date.now()): string {
  const deadline = Date.parse(value);
  if (!Number.isFinite(deadline)) return "—";
  const totalSeconds = Math.max(0, Math.ceil((deadline - now) / 1_000));
  if (totalSeconds === 0) return "CLOSED";
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor(totalSeconds % 86_400 / 3_600);
  const minutes = Math.floor(totalSeconds % 3_600 / 60);
  const seconds = totalSeconds % 60;
  const clock = [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
  return days ? `${days}d ${clock}` : clock;
}
