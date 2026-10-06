// Scenario presets shared by the load runner and the micro-benchmark runner.
export const SCENARIOS: Record<string, { scenario: string; items?: number; count?: number }> = {
  echo: { scenario: "echo" },
  "getorder-small": { scenario: "getorder", items: 10 },
  "getorder-large": { scenario: "getorder", items: 1000 },
  listorders: { scenario: "listorders", count: 1000, items: 3 },
  "createorder-small": { scenario: "createorder", items: 10 },
  "createorder-large": { scenario: "createorder", items: 1000 },
};
