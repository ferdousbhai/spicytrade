/** Every dated line on the site: New York time, since that is where the market day is. */
export const nyDateTime = new Intl.DateTimeFormat('en-US', {
  day: 'numeric', hour: 'numeric', minute: '2-digit', month: 'short', timeZone: 'America/New_York', timeZoneName: 'short', year: 'numeric',
})

/** Only the time of an instant, in New York: for a line whose day is already on screen. */
export const nyTime = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short',
})

/**
 * The calendar day of an instant, in New York. For a stored instant only: a date-only value such
 * as a catalyst's day has no time zone to convert from, and is formatted as the day it names.
 */
export const nyDate = new Intl.DateTimeFormat('en-US', {
  day: 'numeric', month: 'short', timeZone: 'America/New_York', year: 'numeric',
})

const calendarDay = new Intl.DateTimeFormat('en-US', {
  day: 'numeric', month: 'short', timeZone: 'UTC', year: 'numeric',
})

/** A date-only value (`YYYY-MM-DD`), printed as the day it names: UTC so no offset can shift it. */
export function formatCalendarDay(isoDate: string): string {
  return calendarDay.format(new Date(`${isoDate}T00:00:00Z`))
}
