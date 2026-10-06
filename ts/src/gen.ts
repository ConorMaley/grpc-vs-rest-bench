// Deterministic data generator. Must stay in lock-step with dotnet/Bench.Common/Gen.cs:
// same RNG, same call order, so both services return logically identical payloads.

export interface Customer { id: number; name: string; email: string; country: string }
export interface LineItem { sku: string; quantity: number; unitPrice: number; tags: string[] }
export interface Order {
  id: number;
  customer: Customer;
  createdAtMs: number;
  status: string;
  total: number;
  items: LineItem[];
}

class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = Math.imul(seed, 2654435761) >>> 0;
  }
  next(): number {
    this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0;
    return this.s >>> 8;
  }
}

const NAMES = ["Ada Lovelace", "Alan Turing", "Grace Hopper", "Linus Torvalds", "Margaret Hamilton", "Dennis Ritchie"];
const COUNTRIES = ["US", "GB", "DE", "FR", "JP", "AU", "CA", "BR"];
const TAGS = ["fragile", "gift", "express", "bulk", "returnable", "oversize", "perishable", "eco"];
const STATUSES = ["PENDING", "PAID", "SHIPPED", "CANCELLED"];

export function makeOrder(id: number, items: number): Order {
  const r = new Rng(id);
  const customerId = (r.next() % 100000) + 1;
  const name = NAMES[r.next() % NAMES.length];
  const country = COUNTRIES[r.next() % COUNTRIES.length];
  const status = STATUSES[r.next() % STATUSES.length];
  const createdAtMs = 1700000000000 + r.next() * 1000;
  let totalCents = 0;
  const lines: LineItem[] = new Array(items);
  for (let i = 0; i < items; i++) {
    const sku = "SKU-" + String(r.next() % 1000000).padStart(6, "0");
    const quantity = (r.next() % 10) + 1;
    const cents = (r.next() % 100000) + 100;
    const tagCount = r.next() % 3;
    const tags: string[] = new Array(tagCount);
    for (let t = 0; t < tagCount; t++) tags[t] = TAGS[r.next() % TAGS.length];
    totalCents += quantity * cents;
    lines[i] = { sku, quantity, unitPrice: cents / 100, tags };
  }
  return {
    id,
    customer: { id: customerId, name, email: `user${customerId}@example.com`, country },
    createdAtMs,
    status,
    total: totalCents / 100,
    items: lines,
  };
}
