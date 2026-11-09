import dns from "node:dns";

export interface DnsLookup {
  /** Throws on resolver failure. */
  lookup(hostname: string): Promise<{ a: string[]; aaaa: string[] }>;
}

export const DEFAULT_DNS_RESOLVERS = ["1.1.1.1", "8.8.8.8", "9.9.9.9"] as const;

/** `HP_DNS_RESOLVERS`: comma list, `host:port` allowed for the harness. */
export function parseDnsResolvers(value: string | undefined): string[] {
  const list = (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : [...DEFAULT_DNS_RESOLVERS];
}

export interface ResolverLike {
  setServers(servers: string[]): void;
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

export function createNodeDnsLookup(
  servers: readonly string[],
  // A fresh resolver per lookup: no cache can return a stale answer to "Check now".
  resolverFactory: () => ResolverLike = () => new dns.promises.Resolver({ timeout: 2000, tries: 1 }),
): DnsLookup {
  const empty = (e: unknown): string[] => {
    const code = (e as { code?: unknown } | null)?.code;
    if (code === dns.NODATA || code === dns.NOTFOUND) return [];
    throw e;
  };
  return {
    async lookup(hostname) {
      const resolver = resolverFactory();
      resolver.setServers([...servers]);
      const [a, aaaa] = await Promise.all([
        resolver.resolve4(hostname).catch(empty),
        resolver.resolve6(hostname).catch(empty),
      ]);
      return { a, aaaa };
    },
  };
}
