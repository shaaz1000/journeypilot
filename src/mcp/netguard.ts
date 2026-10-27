import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** True for loopback, private, link-local, carrier-grade NAT and unspecified addresses (IPv4 and IPv6). */
export function isInternalAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("::ffff:")) return isInternalAddress(lower.slice(7));
    const first = Number.parseInt(lower.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return true; // not an address at all: refuse
}

/** Resolves a URL's host and refuses it if any address it resolves to is internal. */
export async function assertPublicHost(url: string, resolve: typeof lookup = lookup): Promise<void> {
  const host = new URL(url).hostname.replace("[", "").replace("]", "");
  const addresses = isIP(host) ? [{ address: host }] : await resolve(host, { all: true });
  const internal = addresses.find((a) => isInternalAddress(a.address));
  if (internal) throw new Error(`${host} resolves to an internal address (${internal.address})`);
}

/** Origins the browser may never request, passed to Playwright MCP as defence in depth (it is not a boundary on its own). */
export const BLOCKED_BROWSER_ORIGINS = [
  "http://localhost",
  "https://localhost",
  "http://127.0.0.1",
  "https://127.0.0.1",
  "http://[::1]",
  "http://0.0.0.0",
  "http://169.254.169.254",
  "http://metadata.google.internal",
];
