/**
 * The only way any module learns what time it is.
 *
 * Nothing outside `systemClock` reads the wall clock. The previous codebase
 * read it in 33 places, so a test that froze time for its fixtures still had
 * the persistence layer stamping real time, and the suite went red on its own
 * three days after it was written.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock tests can set and advance. */
export class FixedClock implements Clock {
  private t: number;
  constructor(iso: string | number | Date) {
    this.t = new Date(iso).getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  set(iso: string | number | Date): void {
    this.t = new Date(iso).getTime();
  }
  advanceDays(days: number): void {
    this.t += days * DAY_MS;
  }
  advanceMs(ms: number): void {
    this.t += ms;
  }
}

export const DAY_MS = 86_400_000;

export function iso(clock: Clock): string {
  return clock.now().toISOString();
}

/** Calendar day (UTC) of an instant, used where a value legitimately changes daily. */
export function dayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, to: Date): number | null {
  const t = Date.parse(fromIso);
  if (Number.isNaN(t)) return null;
  return (to.getTime() - t) / DAY_MS;
}
