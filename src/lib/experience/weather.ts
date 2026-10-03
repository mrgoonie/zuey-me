import { AppError } from '../http';
import type { JsonCache } from './runtime';
import { experienceRuntime, fetchWithTimeout, isRecord, readNumber, readString } from './runtime';

export type WeatherCondition = 'clear' | 'clouds' | 'fog' | 'rain' | 'snow' | 'storm';

export type WeatherQuery =
  | { kind: 'coords'; lat: number; lon: number }
  | { kind: 'city'; city: string; language: string };

export interface WeatherPlace {
  name: string;
  country: string | null;
  admin1: string | null;
}

export interface WeatherReport {
  place: WeatherPlace | null;
  /** Coordinates rounded to 1 decimal (~11 km): never precise positions. */
  latitude: number;
  longitude: number;
  condition: WeatherCondition;
  is_day: boolean;
  weather_code: number;
  temperature_c: number | null;
  wind_kmh: number | null;
  observed_at: string | null;
  source: 'open-meteo';
  attribution: string;
}

const WEATHER_TTL_SECONDS = 10 * 60;
const GEOCODE_TTL_SECONDS = 7 * 24 * 60 * 60;
const TIMEOUT_MS = 6000;
const COORD_RE = /^-?\d{1,3}(\.\d{1,8})?$/;
const CITY_RE = /^[\p{L}\p{M}][\p{L}\p{M}\s.'’,-]*$/u;
const GEO_LANGS = ['en', 'vi', 'zh', 'ko', 'ja'];

/** Rounds to one decimal place so stored and forwarded coordinates stay coarse (~11 km). */
export function coarse(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Validates `?lat&lon` or `?city` (+ optional `lang`). Throws AppError 400 on bad input. */
export function parseWeatherQuery(params: URLSearchParams): WeatherQuery {
  const latRaw = params.get('lat');
  const lonRaw = params.get('lon');
  const cityRaw = params.get('city');
  if (latRaw !== null || lonRaw !== null) {
    if (latRaw === null || lonRaw === null || !COORD_RE.test(latRaw.trim()) || !COORD_RE.test(lonRaw.trim())) {
      throw new AppError(400, 'invalid_coordinates', 'lat and lon must both be decimal numbers');
    }
    const lat = Number(latRaw);
    const lon = Number(lonRaw);
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw new AppError(400, 'invalid_coordinates', 'lat must be within ±90 and lon within ±180');
    }
    return { kind: 'coords', lat: coarse(lat), lon: coarse(lon) };
  }
  if (cityRaw !== null) {
    const city = cityRaw.replace(/\s+/g, ' ').trim();
    if (city.length < 2 || city.length > 80 || !CITY_RE.test(city)) {
      throw new AppError(400, 'invalid_city', 'city must be 2–80 letters (spaces, dots, apostrophes, commas and hyphens allowed)');
    }
    const lang = params.get('lang') ?? 'en';
    return { kind: 'city', city, language: GEO_LANGS.includes(lang) ? lang : 'en' };
  }
  throw new AppError(400, 'invalid_query', 'Provide ?lat=&lon= (rounded to 1 decimal) or ?city=');
}

/** Maps WMO weather interpretation codes (Open-Meteo `weather_code`) to the visual scene. */
export function conditionFromCode(code: number): WeatherCondition {
  if (code <= 1) return 'clear';
  if (code <= 3) return 'clouds';
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'storm';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  return 'clouds';
}

async function getJson(url: string, failureMessage: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchWithTimeout(url, { headers: { Accept: 'application/json', 'User-Agent': 'zuey.me-weather' } }, TIMEOUT_MS);
  } catch {
    throw new AppError(502, 'weather_unavailable', failureMessage);
  }
  if (!res.ok) throw new AppError(502, 'weather_unavailable', `${failureMessage} (HTTP ${res.status})`);
  const body: unknown = await res.json().catch(() => null);
  if (!isRecord(body)) throw new AppError(502, 'weather_unavailable', failureMessage);
  return body;
}

interface GeocodeHit {
  place: WeatherPlace;
  lat: number;
  lon: number;
}

async function geocode(city: string, language: string, cache: JsonCache): Promise<GeocodeHit> {
  const key = `weather:geocode:${language}:${city.toLowerCase()}`;
  const cached = await cache.get(key);
  if (isRecord(cached) && isRecord(cached.place) && typeof cached.lat === 'number' && typeof cached.lon === 'number') {
    const place = cached.place;
    return {
      place: { name: readString(place, 'name') ?? city, country: readString(place, 'country'), admin1: readString(place, 'admin1') },
      lat: cached.lat,
      lon: cached.lon,
    };
  }
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=${language}&format=json`;
  const body = await getJson(url, 'City lookup is unavailable right now');
  const first = Array.isArray(body.results) ? body.results[0] : null;
  if (!isRecord(first)) throw new AppError(404, 'city_not_found', `No place named "${city}" was found`);
  const lat = readNumber(first, 'latitude');
  const lon = readNumber(first, 'longitude');
  const name = readString(first, 'name');
  if (lat === null || lon === null || !name) throw new AppError(404, 'city_not_found', `No place named "${city}" was found`);
  const hit: GeocodeHit = {
    place: { name, country: readString(first, 'country'), admin1: readString(first, 'admin1') },
    lat: coarse(lat),
    lon: coarse(lon),
  };
  await cache.put(key, hit, GEOCODE_TTL_SECONDS);
  return hit;
}

function isReport(value: unknown): value is WeatherReport {
  return isRecord(value) && typeof value.condition === 'string' && typeof value.latitude === 'number' && value.source === 'open-meteo';
}

async function forecast(lat: number, lon: number, cache: JsonCache): Promise<WeatherReport> {
  const key = `weather:current:${lat},${lon}`;
  const cached = await cache.get(key);
  if (isReport(cached)) return cached;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + '&current=temperature_2m,weather_code,is_day,wind_speed_10m&timezone=auto';
  const body = await getJson(url, 'Weather service is unavailable right now');
  const current = isRecord(body.current) ? body.current : null;
  const code = current ? readNumber(current, 'weather_code') : null;
  if (!current || code === null) throw new AppError(502, 'weather_unavailable', 'Weather service returned no current conditions');
  const report: WeatherReport = {
    place: null,
    latitude: lat,
    longitude: lon,
    condition: conditionFromCode(code),
    is_day: readNumber(current, 'is_day') !== 0,
    weather_code: code,
    temperature_c: readNumber(current, 'temperature_2m'),
    wind_kmh: readNumber(current, 'wind_speed_10m'),
    observed_at: readString(current, 'time'),
    source: 'open-meteo',
    attribution: 'Weather data by Open-Meteo.com (CC BY 4.0)',
  };
  await cache.put(key, report, WEATHER_TTL_SECONDS);
  return report;
}

/** Current conditions for coarse coordinates or a city name, cached at the edge for 10 minutes. */
export async function getWeather(query: WeatherQuery, cache: JsonCache = experienceRuntime.cache()): Promise<WeatherReport> {
  if (query.kind === 'coords') return forecast(query.lat, query.lon, cache);
  const hit = await geocode(query.city, query.language, cache);
  const report = await forecast(hit.lat, hit.lon, cache);
  return { ...report, place: hit.place };
}
