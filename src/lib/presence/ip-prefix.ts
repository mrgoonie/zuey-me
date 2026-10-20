/**
 * Client-address key for presence rate limits and connection caps. One IPv6 subscriber usually owns a
 * whole /64 and can rotate addresses inside it freely, so IPv6 addresses collapse to their /64 prefix;
 * IPv4 addresses (including IPv4-mapped IPv6) stay as they are. Pure string logic, no app imports, so
 * both the Pages app and the presence Worker bundle it.
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEXTET = /^[0-9a-f]{1,4}$/;

function isIpv4(value: string): boolean {
  const m = IPV4.exec(value);
  return m !== null && m.slice(1).every((part) => Number(part) <= 255);
}

/** Expands an IPv6 address to its 8 hextets; null when it is not a valid IPv6 address. */
function ipv6Hextets(value: string): string[] | null {
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): string[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    const last = groups[groups.length - 1];
    // A trailing dotted IPv4 (e.g. ::ffff:192.0.2.1) fills the last two hextets.
    if (last !== undefined && last.includes('.')) {
      if (!isIpv4(last)) return null;
      const octets = last.split('.').map(Number);
      groups.splice(groups.length - 1, 1, ((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16));
    }
    return groups.every((g) => HEXTET.test(g)) ? groups : null;
  };
  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...Array<string>(missing).fill('0'), ...tail];
}

/**
 * Rate-limit key for a client address: IPv4 unchanged, IPv6 reduced to `<first 4 hextets>::/64`
 * (lower-case, leading zeros dropped). Anything unparseable is returned trimmed and lower-cased.
 */
export function presenceIpKey(ip: string): string {
  const value = ip.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!value.includes(':')) return value;
  const hextets = ipv6Hextets(value);
  if (!hextets) return value;
  const normalized = hextets.map((h) => parseInt(h, 16).toString(16));
  // IPv4-mapped (::ffff:a.b.c.d) is really an IPv4 client.
  if (normalized.slice(0, 5).every((h) => h === '0') && normalized[5] === 'ffff') {
    const hi = parseInt(normalized[6] ?? '0', 16);
    const lo = parseInt(normalized[7] ?? '0', 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return `${normalized.slice(0, 4).join(':')}::/64`;
}
