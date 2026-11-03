/** Fixed 2.5-hour dining blocks, in restaurant local time. */
export const SLOT_DURATION_MINUTES = 150;
export const SLOT_START_TIMES = ["11:00", "13:30", "17:00", "19:30"] as const;
export type SlotStartTime = (typeof SLOT_START_TIMES)[number];

export const MAX_DAYS_AHEAD = 60;

export function isSlotStartTime(value: string): value is SlotStartTime {
  return (SLOT_START_TIMES as readonly string[]).includes(value);
}

/** Converts a local date ("2026-12-24") + slot start ("19:30") into a UTC slot window. */
export function computeSlot(date: string, startTime: SlotStartTime, utcOffset: string) {
  const slotStart = new Date(`${date}T${startTime}:00${utcOffset}`);
  if (Number.isNaN(slotStart.getTime())) throw new Error(`Invalid date: ${date}`);
  const slotEnd = new Date(slotStart.getTime() + SLOT_DURATION_MINUTES * 60_000);
  return { slotStart, slotEnd };
}

/** A slot is bookable if it hasn't started yet and is within the booking window. */
export function isBookable(slotStart: Date, now: Date = new Date()): boolean {
  const latest = now.getTime() + MAX_DAYS_AHEAD * 24 * 60 * 60_000;
  return slotStart.getTime() > now.getTime() && slotStart.getTime() <= latest;
}

function offsetMinutes(utcOffset: string): number {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(utcOffset);
  if (!match) throw new Error(`Invalid UTC offset: ${utcOffset}`);
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

/** Today's date ("YYYY-MM-DD") in restaurant local time. */
export function todayLocal(utcOffset: string, now: Date = new Date()): string {
  return new Date(now.getTime() + offsetMinutes(utcOffset) * 60_000).toISOString().slice(0, 10);
}

/** UTC [start, end) range covering one or more local calendar days. */
export function localDayRange(fromDate: string, toDate: string, utcOffset: string) {
  const start = new Date(`${fromDate}T00:00:00${utcOffset}`);
  const end = new Date(new Date(`${toDate}T00:00:00${utcOffset}`).getTime() + 24 * 60 * 60_000);
  return { start, end };
}
