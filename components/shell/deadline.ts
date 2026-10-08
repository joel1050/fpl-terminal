export function formatDeadline(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
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
