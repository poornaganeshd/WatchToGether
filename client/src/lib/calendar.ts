const icsDate = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

const escapeIcs = (value: string) => value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Downloads an .ics file so the watch party lands in the user's calendar with a reminder. */
export const downloadCalendarEvent = (event: { id: string; title: string; start: Date; url: string; durationMinutes?: number; description?: string }) => {
  const end = new Date(event.start.getTime() + (event.durationMinutes ?? 120) * 60_000);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//WatchTogether//Watch Party//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${event.id}@watchtogether`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(event.start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${escapeIcs(event.title)}`,
    `DESCRIPTION:${escapeIcs(event.description ?? `Join here: ${event.url}`)}`,
    `URL:${event.url}`,
    "BEGIN:VALARM",
    "TRIGGER:-PT15M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeIcs(event.title)} starts in 15 minutes`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  const blob = new Blob([lines.join("\r\n")], { type: "text/calendar;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = `${event.title.replace(/[^\w\- ]+/g, "").trim() || "watch-party"}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
};

/** "in 2h 15m", "in 3 days", "started 10m ago" */
export const countdown = (target: Date, now = Date.now()) => {
  const diff = target.getTime() - now;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60_000);
  let text: string;
  if (mins < 1) text = "now";
  else if (mins < 60) text = `${mins}m`;
  else if (mins < 24 * 60) text = `${Math.floor(mins / 60)}h ${mins % 60}m`;
  else {
    const days = Math.round(mins / (24 * 60));
    text = `${days} day${days === 1 ? "" : "s"}`;
  }
  if (text === "now") return diff >= 0 ? "starting now" : "just started";
  return diff >= 0 ? `in ${text}` : `started ${text} ago`;
};

/** Value for <input type="datetime-local"> in the user's timezone. */
export const toLocalInputValue = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
