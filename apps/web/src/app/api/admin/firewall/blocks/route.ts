import { isIP } from "node:net";
import { forwardIdempotent } from "@/lib/bff-idempotent";
import { FIREWALL_BFF_TIMEOUT_MS } from "@/lib/admin-firewall";

/** Blocks an address or network; the proxy's X-Real-Ip goes on as advice for the own-address check. */
export async function POST(req: Request) {
  const ip = req.headers.get("x-real-ip");
  const headers = ip && isIP(ip) ? { "X-HP-Client-Address": ip } : undefined;
  return await forwardIdempotent(req, {}, "v1/admin/firewall/blocks", "POST", { headers, timeoutMs: FIREWALL_BFF_TIMEOUT_MS });
}
