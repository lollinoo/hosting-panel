/**
 * Start order of the services of an application template (A6). Pure, synchronous and never throws; a message never
 * echoes a value.
 */
export type AppTemplateServiceOrder =
  | { readonly ok: true; readonly order: readonly string[] }
  | { readonly ok: false; readonly unordered: readonly string[] };

/** Kahn's algorithm. Precondition: keys unique. A dependsOn entry that names no service is ignored (reported elsewhere as
 *  DEPENDS_ON_UNKNOWN). Each step takes the code-unit-smallest key among those whose dependencies are all placed.
 *  Self-dependency counts as a cycle. Pure, O(n²), never throws. */
export function orderAppTemplateServices(
  services: readonly { readonly key: string; readonly dependsOn: readonly string[] }[],
): AppTemplateServiceOrder {
  const known = new Set(services.map((service) => service.key));
  const placed = new Set<string>();
  const order: string[] = [];
  let pending = services.map((service) => ({ key: service.key, needs: service.dependsOn.filter((key) => known.has(key)) }));
  for (;;) {
    let next: (typeof pending)[number] | undefined;
    for (const item of pending) {
      if ((next === undefined || item.key < next.key) && item.needs.every((key) => placed.has(key))) next = item;
    }
    if (next === undefined) break;
    placed.add(next.key);
    order.push(next.key);
    pending = pending.filter((item) => item !== next);
  }
  return pending.length === 0 ? { ok: true, order } : { ok: false, unordered: pending.map((item) => item.key).sort() };
}
