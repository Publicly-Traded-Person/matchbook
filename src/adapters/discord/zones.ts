// Timezone autocomplete for /join and /timezone (§5: "Timezones are mandatory",
// "Entering it must not involve parsing English"). A member types the name of
// the place they live in and picks a real IANA zone id off the list, so nothing
// downstream ever has to guess what "PST" meant in March.
//
// This module is platform free on purpose: it returns plain strings, and the
// gateway adapter wraps them in autocomplete choices.

/** Discord shows at most 25 autocomplete choices. */
export const AUTOCOMPLETE_LIMIT = 25

/**
 * Place names that are not spelled anywhere in their own zone id, plus the
 * common short forms people actually type. Keys are lower case and matched by
 * prefix, so "oak" finds "oakland" and with it `America/Los_Angeles`.
 */
export const ZONE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // North America
  'abq': 'America/Denver',
  'albuquerque': 'America/Denver',
  'alaska': 'America/Anchorage',
  'anchorage': 'America/Anchorage',
  'arizona': 'America/Phoenix',
  'atlanta': 'America/New_York',
  'austin': 'America/Chicago',
  'bay area': 'America/Los_Angeles',
  'boston': 'America/New_York',
  'boulder': 'America/Denver',
  'british columbia': 'America/Vancouver',
  'brooklyn': 'America/New_York',
  'chicago': 'America/Chicago',
  'dallas': 'America/Chicago',
  'dc': 'America/New_York',
  'denver': 'America/Denver',
  'east coast': 'America/New_York',
  'guadalajara': 'America/Mexico_City',
  'halifax': 'America/Halifax',
  'hawaii': 'Pacific/Honolulu',
  'honolulu': 'Pacific/Honolulu',
  'houston': 'America/Chicago',
  'las vegas': 'America/Los_Angeles',
  'los angeles': 'America/Los_Angeles',
  'memphis': 'America/Chicago',
  'mexico': 'America/Mexico_City',
  'mexico city': 'America/Mexico_City',
  'miami': 'America/New_York',
  'milwaukee': 'America/Chicago',
  'minneapolis': 'America/Chicago',
  'montreal': 'America/Toronto',
  'nashville': 'America/Chicago',
  'new orleans': 'America/Chicago',
  'new york': 'America/New_York',
  'new york city': 'America/New_York',
  'newfoundland': 'America/St_Johns',
  'nova scotia': 'America/Halifax',
  'nyc': 'America/New_York',
  'oakland': 'America/Los_Angeles',
  'ontario': 'America/Toronto',
  'ottawa': 'America/Toronto',
  'philadelphia': 'America/New_York',
  'philly': 'America/New_York',
  'phoenix': 'America/Phoenix',
  'portland': 'America/Los_Angeles',
  'puerto rico': 'America/Puerto_Rico',
  'sacramento': 'America/Los_Angeles',
  'salt lake city': 'America/Denver',
  'san diego': 'America/Los_Angeles',
  'san francisco': 'America/Los_Angeles',
  'seattle': 'America/Los_Angeles',
  'sf': 'America/Los_Angeles',
  'silicon valley': 'America/Los_Angeles',
  'toronto': 'America/Toronto',
  'tucson': 'America/Phoenix',
  'usa': 'America/New_York',
  'vancouver': 'America/Vancouver',
  'washington': 'America/New_York',
  'west coast': 'America/Los_Angeles',

  // South America
  'argentina': 'America/Argentina/Buenos_Aires',
  'bogota': 'America/Bogota',
  'brazil': 'America/Sao_Paulo',
  'buenos aires': 'America/Argentina/Buenos_Aires',
  'chile': 'America/Santiago',
  'colombia': 'America/Bogota',
  'medellin': 'America/Bogota',
  'peru': 'America/Lima',
  'rio': 'America/Sao_Paulo',
  'rio de janeiro': 'America/Sao_Paulo',
  'sao paulo': 'America/Sao_Paulo',

  // Europe
  'amsterdam': 'Europe/Amsterdam',
  'ankara': 'Europe/Istanbul',
  'austria': 'Europe/Vienna',
  'barcelona': 'Europe/Madrid',
  'belfast': 'Europe/London',
  'belgium': 'Europe/Brussels',
  'bosnia': 'Europe/Belgrade',
  'britain': 'Europe/London',
  'cardiff': 'Europe/London',
  'cologne': 'Europe/Berlin',
  'croatia': 'Europe/Belgrade',
  'czechia': 'Europe/Prague',
  'denmark': 'Europe/Copenhagen',
  'edinburgh': 'Europe/London',
  'england': 'Europe/London',
  'estonia': 'Europe/Tallinn',
  'finland': 'Europe/Helsinki',
  'france': 'Europe/Paris',
  'frankfurt': 'Europe/Berlin',
  'germany': 'Europe/Berlin',
  'glasgow': 'Europe/London',
  'greece': 'Europe/Athens',
  'hamburg': 'Europe/Berlin',
  'holland': 'Europe/Amsterdam',
  'hungary': 'Europe/Budapest',
  'iceland': 'Atlantic/Reykjavik',
  'ireland': 'Europe/Dublin',
  'italy': 'Europe/Rome',
  'kiev': 'Europe/Kyiv',
  'kosovo': 'Europe/Belgrade',
  'krakow': 'Europe/Warsaw',
  'latvia': 'Europe/Riga',
  'lithuania': 'Europe/Vilnius',
  'ljubljana': 'Europe/Belgrade',
  'lyon': 'Europe/Paris',
  'macedonia': 'Europe/Belgrade',
  'manchester': 'Europe/London',
  'marseille': 'Europe/Paris',
  'milan': 'Europe/Rome',
  'montenegro': 'Europe/Belgrade',
  'munich': 'Europe/Berlin',
  'netherlands': 'Europe/Amsterdam',
  'northern ireland': 'Europe/London',
  'norway': 'Europe/Oslo',
  'poland': 'Europe/Warsaw',
  'porto': 'Europe/Lisbon',
  'portugal': 'Europe/Lisbon',
  'pristina': 'Europe/Belgrade',
  'romania': 'Europe/Bucharest',
  'rotterdam': 'Europe/Amsterdam',
  'russia': 'Europe/Moscow',
  'sarajevo': 'Europe/Belgrade',
  'scotland': 'Europe/London',
  'serbia': 'Europe/Belgrade',
  'seville': 'Europe/Madrid',
  'skopje': 'Europe/Belgrade',
  'slovenia': 'Europe/Belgrade',
  'spain': 'Europe/Madrid',
  'sweden': 'Europe/Stockholm',
  'switzerland': 'Europe/Zurich',
  'turkey': 'Europe/Istanbul',
  'uk': 'Europe/London',
  'ukraine': 'Europe/Kyiv',
  'utrecht': 'Europe/Amsterdam',
  'valencia': 'Europe/Madrid',
  'wales': 'Europe/London',

  // Africa and the Middle East
  'abu dhabi': 'Asia/Dubai',
  'accra': 'Africa/Accra',
  'cape town': 'Africa/Johannesburg',
  'durban': 'Africa/Johannesburg',
  'egypt': 'Africa/Cairo',
  'emirates': 'Asia/Dubai',
  'ghana': 'Africa/Accra',
  'iran': 'Asia/Tehran',
  'israel': 'Asia/Jerusalem',
  'kenya': 'Africa/Nairobi',
  'nigeria': 'Africa/Lagos',
  'saudi arabia': 'Asia/Riyadh',
  'south africa': 'Africa/Johannesburg',
  'tel aviv': 'Asia/Jerusalem',
  'uae': 'Asia/Dubai',

  // Asia and the Pacific
  'auckland': 'Pacific/Auckland',
  'australia': 'Australia/Sydney',
  'bangalore': 'Asia/Kolkata',
  'bangladesh': 'Asia/Dhaka',
  'beijing': 'Asia/Shanghai',
  'bengaluru': 'Asia/Kolkata',
  'brisbane': 'Australia/Brisbane',
  'canberra': 'Australia/Sydney',
  'chennai': 'Asia/Kolkata',
  'china': 'Asia/Shanghai',
  'delhi': 'Asia/Kolkata',
  'hanoi': 'Asia/Ho_Chi_Minh',
  'hyderabad': 'Asia/Kolkata',
  'india': 'Asia/Kolkata',
  'indonesia': 'Asia/Jakarta',
  'islamabad': 'Asia/Karachi',
  'japan': 'Asia/Tokyo',
  'korea': 'Asia/Seoul',
  'kyoto': 'Asia/Tokyo',
  'lahore': 'Asia/Karachi',
  'malaysia': 'Asia/Kuala_Lumpur',
  'melbourne': 'Australia/Melbourne',
  'mumbai': 'Asia/Kolkata',
  'nepal': 'Asia/Kathmandu',
  'new delhi': 'Asia/Kolkata',
  'new zealand': 'Pacific/Auckland',
  'nz': 'Pacific/Auckland',
  'osaka': 'Asia/Tokyo',
  'pakistan': 'Asia/Karachi',
  'perth': 'Australia/Perth',
  'philippines': 'Asia/Manila',
  'pune': 'Asia/Kolkata',
  'saigon': 'Asia/Ho_Chi_Minh',
  'shenzhen': 'Asia/Shanghai',
  'sri lanka': 'Asia/Colombo',
  'sydney': 'Australia/Sydney',
  'taiwan': 'Asia/Taipei',
  'thailand': 'Asia/Bangkok',
  'vietnam': 'Asia/Ho_Chi_Minh',
  'wellington': 'Pacific/Auckland',
})

/** Every zone id this runtime knows, alphabetical. */
const ZONE_IDS: readonly string[] = [...Intl.supportedValuesOf('timeZone')].sort()

const ZONE_SET: ReadonlySet<string> = new Set(ZONE_IDS)

/** Alias keys, alphabetical, so a given query always ranks its hits the same way. */
const ALIAS_KEYS: readonly string[] = Object.keys(ZONE_ALIASES).sort()

/** `America/Los_Angeles` reads as `america/los angeles` when we match. */
function searchable(zoneId: string): string {
  return zoneId.toLowerCase().replace(/_/g, ' ')
}

/** True when `zoneId` is a zone this runtime actually supports. */
export function isKnownZone(zoneId: string): boolean {
  return ZONE_SET.has(zoneId)
}

/**
 * Zone ids to offer for what the member has typed so far. Alias hits come
 * first (they are the place names people type), then id matches in
 * alphabetical order. Every result is a real IANA zone id and the list is
 * never longer than Discord's cap of 25.
 */
export function zoneSuggestions(query: string, limit: number = AUTOCOMPLETE_LIMIT): string[] {
  const cap = Math.max(0, Math.min(Math.floor(limit), AUTOCOMPLETE_LIMIT))
  if (cap === 0) return []

  const needle = query.trim().toLowerCase().replace(/_/g, ' ')
  const seen = new Set<string>()
  const out: string[] = []

  const take = (zoneId: string | undefined): boolean => {
    if (zoneId === undefined || !ZONE_SET.has(zoneId) || seen.has(zoneId)) return false
    seen.add(zoneId)
    out.push(zoneId)
    return out.length >= cap
  }

  for (const key of ALIAS_KEYS) {
    if (!key.startsWith(needle)) continue
    if (take(ZONE_ALIASES[key])) return out
  }

  for (const zoneId of ZONE_IDS) {
    if (!searchable(zoneId).includes(needle)) continue
    if (take(zoneId)) return out
  }

  return out
}
