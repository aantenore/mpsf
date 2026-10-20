// Sample project for Change Observatory screenshots and demos: an online shop
// with stories in every state, times relative to "now" so ages read naturally.
// Served by the preview server with `--demo`; never used by the plugin itself.

const PHASES = ["discovery", "analysis", "design", "implementation", "validation", "release", "operations"];

const STORIES = [
  { id: "ST-101", title: "Guest checkout", summary: "Buy without creating an account.", done: 7, hoursAgo: 96 },
  { id: "ST-102", title: "Saved payment cards", summary: "Pay with a card saved at the provider, never stored here.", done: 7, hoursAgo: 80 },
  { id: "ST-103", title: "Order tracking page", summary: "One page with the parcel status and delivery window.", done: 6, hoursAgo: 52 },
  { id: "ST-104", title: "Email receipts", summary: "A receipt by email after every paid order.", done: 6, hoursAgo: 30 },
  { id: "ST-105", title: "Refund requests", summary: "Customers ask for a refund from the order page.", done: 3, live: true, hoursAgo: 1 },
  { id: "ST-106", title: "Search by category", summary: "Filter the catalogue by category and price.", done: 4, live: true, hoursAgo: 2 },
  { id: "ST-107", title: "Stock alerts", summary: "Tell a customer when a sold-out product is back.", done: 2, blocked: true, hoursAgo: 5 },
  { id: "ST-108", title: "Admin price editor", summary: "Change prices in bulk with a preview.", done: 1, live: true, hoursAgo: 0.4 },
  { id: "ST-109", title: "Mobile cart redesign", summary: "A one-hand cart on small screens.", done: 0, hoursAgo: null },
];

const EDGES = [
  { from: "ST-102", to: "ST-101" },
  { from: "ST-103", to: "ST-101" },
  { from: "ST-104", to: "ST-102" },
  { from: "ST-105", to: "ST-103" },
  { from: "ST-105", to: "ST-104" },
  { from: "ST-107", to: "ST-106" },
  { from: "ST-109", to: "ST-105" },
];

function ref(path) {
  return [{ path }];
}

export function buildDemoModel(nowMs = Date.now()) {
  const at = (hoursAgo) => new Date(nowMs - hoursAgo * 3_600_000).toISOString();
  const records = new Set();
  const track = (path) => {
    records.add(path);
    return ref(path);
  };
  const iterations = STORIES.map((story) => {
    const storyPath = `.sdlc/stories/${story.id}/story.json`;
    const phases = PHASES.map((phase, index) => {
      let status = "missing";
      if (index < story.done) status = "complete";
      else if (index === story.done && story.live) status = "inProgress";
      else if (index === story.done && story.blocked) status = "blocked";
      return { phase, status, provenance: status === "missing" ? "missing" : "recorded", sourceRefs: status === "missing" ? [] : track(`.sdlc/traces/${story.id}.jsonl`) };
    });
    const delivered = story.done >= 6;
    const current = phases.find((phase) => phase.status === "inProgress" || phase.status === "blocked")?.phase ?? null;
    return {
      id: story.id,
      type: "iteration",
      title: story.title,
      summary: story.summary,
      status: delivered ? "complete" : story.blocked ? "blocked" : story.done || story.live ? "active" : "planned",
      phase: current ?? PHASES[Math.max(0, story.done - 1)],
      timestamp: story.hoursAgo === null ? null : at(story.hoursAgo),
      provenance: "recorded",
      currentPhase: current,
      sourceRefs: track(storyPath),
      phases,
      ...(story.live ? { claimed: true } : {}),
    };
  });

  const item = (type, story, index, extra) => ({
    id: `${type.toUpperCase()}-${story.id}-${index}`,
    type,
    storyId: story.id,
    provenance: "recorded",
    ...extra,
  });
  const contracts = [];
  const decisions = [];
  const changes = [];
  const verification = [];
  const asked = [];
  for (const story of STORIES) {
    if (story.hoursAgo === null) continue;
    const base = story.hoursAgo + Math.min(story.done, 6) * 3;
    asked.push(item("requirement", story, 1, { title: story.title, summary: story.summary, status: "approved", phase: "discovery", timestamp: at(base + 2), sourceRefs: track(`.sdlc/requirements/REQ-${story.id}.json`) }));
    if (story.done >= 2) contracts.push(item("contract", story, 1, { title: `${story.title}: agreed scope`, summary: "What is in, what is out, and how it is checked.", status: "approved", phase: "analysis", timestamp: at(base), sourceRefs: track(`.sdlc/contracts/contract-${story.id}.json`) }));
    if (story.done >= 3) decisions.push(item("decision", story, 1, { title: DECISIONS[story.id] ?? `${story.title}: design choice`, summary: "Chosen for safety and the smallest change; the alternatives are recorded.", status: "approved", phase: "design", timestamp: at(base - 3), sourceRefs: track(`.sdlc/decisions/DEC-${story.id}.json`) }));
    if (story.done >= 3 || story.live) {
      for (const [index, file] of (FILES[story.id] ?? []).entries()) {
        changes.push(item("file-change", story, index + 1, { title: file, summary: `Part of ${story.title.toLowerCase()}.`, status: "complete", phase: "implementation", intent: story.title.toLowerCase(), timestamp: at(Math.max(0.2, base - 6 - index)), sourceRefs: track(`.sdlc/stories/${story.id}/implementation-log.md`) }));
      }
    }
    if (story.done >= 5 || story.blocked) {
      const failed = story.blocked;
      verification.push(item("test-run", story, 1, { title: `${story.title}: unit and API tests`, summary: failed ? "The stock provider sandbox did not answer; waiting for a decision." : "All tests passed.", status: failed ? "failed" : "passed", phase: "validation", timestamp: at(Math.max(0.1, base - 9)), sourceRefs: track(`.sdlc/tests/${story.id}.json`) }));
      if (!failed) verification.push(item("gate", story, 2, { title: `${story.title}: release gate`, summary: "Review, checks and contract matched.", status: story.done >= 6 ? "passed" : "pending", phase: "release", timestamp: at(Math.max(0.1, base - 10)), sourceRefs: track(`.sdlc/tests/${story.id}-gate.json`) }));
    }
  }
  return {
    schemaVersion: "change-observatory:view:v1",
    generatedAt: at(0),
    project: { id: "acme-shop", name: "Acme Shop", branch: "main" },
    snapshots: { counts: { requirements: asked.length, stories: STORIES.length, contracts: contracts.length, changes: changes.length, verification: verification.length } },
    summary: {
      asked,
      changed: changes.slice(-1),
      decided: decisions.slice(-1),
    },
    iterations,
    contracts,
    decisions,
    changes,
    verification,
    records: [...records].map((path) => ({ path, kind: "record", provenance: "recorded", rawHref: `/api/v1/source?path=${encodeURIComponent(path)}` })),
    diagnostics: [],
  };
}

const DECISIONS = {
  "ST-101": "Guest orders keep only the email address",
  "ST-102": "Cards stay at the payment provider",
  "ST-103": "Poll the carrier every 15 minutes",
  "ST-104": "Receipts are sent from the order service",
  "ST-105": "Refunds above 200 EUR need a person",
  "ST-106": "Filters run in the database, not in the page",
};

const FILES = {
  "ST-101": ["src/checkout/guest.ts", "src/checkout/guest.test.ts"],
  "ST-102": ["src/payments/saved-cards.ts", "src/payments/provider.ts"],
  "ST-103": ["src/orders/tracking-page.tsx", "src/orders/carrier.ts"],
  "ST-104": ["src/orders/receipt-email.ts"],
  "ST-105": ["src/orders/refund-request.ts", "src/orders/refund-request.test.ts"],
  "ST-106": ["src/catalogue/filters.ts", "db/migrations/0042_category_index.sql"],
  "ST-108": ["src/admin/price-editor.tsx"],
};

export function demoDependencies() {
  return { found: true, edges: EDGES.map((edge) => ({ ...edge })) };
}

export function demoNowInputs(nowMs = Date.now()) {
  const ago = (minutes) => new Date(nowMs - minutes * 60_000).toISOString();
  return {
    claims: [
      { storyId: "ST-105", state: "claimed", agent: "claude", holder: "anna-mac", branch: "feature/ST-105", claimedAt: ago(70), health: "active" },
      { storyId: "ST-106", state: "claimed", agent: "codex", holder: "luca-pc", branch: "feature/ST-106", claimedAt: ago(150), health: "active" },
      { storyId: "ST-108", state: "claimed", agent: "claude", holder: "build-server", branch: "feature/ST-108", claimedAt: ago(25), health: "active" },
    ],
    messages: [
      { id: "n1", from: "anna-mac", kind: "info", story: "ST-105", text: "[auto] status: ST-105 in phase implementation for 20 min", time: ago(22), trust: "trusted" },
      { id: "n2", from: "luca-pc", kind: "question", story: "ST-107", text: "The stock provider sandbox is down. Wait for it, or mock it and ship?", time: ago(18), trust: "trusted" },
      { id: "n3", from: "anna-mac", kind: "answer", reply_to: "n2", text: "Mock it, but keep the contract test against the real sandbox.", time: ago(14), trust: "trusted" },
      { id: "n4", from: "luca-pc", kind: "discuss", story: "ST-109", text: "Who takes the mobile cart once refunds are in?", time: ago(12), trust: "trusted" },
      { id: "n5", from: "build-server", kind: "propose", story: "ST-109", reply_to: "n4", text: "I am free after the price editor\nmpsf-action: {\"action\":\"claim\",\"story\":\"ST-109\",\"agent\":\"build-server\"}", time: ago(9), trust: "trusted" },
      { id: "n6", from: "anna-mac", kind: "ack", story: "ST-109", reply_to: "n4", text: "", time: ago(6), trust: "trusted" },
      { id: "n7", from: "build-server", kind: "info", story: "ST-108", text: "[auto] status: ST-108 in phase analysis", time: ago(4), trust: "trusted" },
      { id: "n8", from: "luca-pc", kind: "info", text: "Heads up: the staging database restarts at 18:00.", time: ago(3), trust: "trusted" },
    ],
  };
}
