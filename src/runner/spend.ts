export type SpendTracker = {
  spent: number;
  cap: number;
  exceeded: boolean;
};

export type SpendGate = SpendTracker & {
  inFlight: number;
  lastCost: number;
  _chain: Promise<void>;
  _waiters: Set<() => void>;
};

const DEFAULT_ESTIMATE = 0.05;

export function createSpendGate(cap: number): SpendGate {
  return {
    spent: 0,
    cap,
    exceeded: false,
    inFlight: 0,
    lastCost: DEFAULT_ESTIMATE,
    _chain: Promise.resolve(),
    _waiters: new Set(),
  };
}

export function createSpendTracker(cap: number): SpendTracker {
  return createSpendGate(cap);
}

function withGateLock<T>(
  gate: SpendGate,
  fn: () => T | Promise<T>,
): Promise<T> {
  const run = gate._chain.then(fn, fn);
  gate._chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function notifyGateWaiters(gate: SpendGate): void {
  for (const wake of gate._waiters) {
    wake();
  }
}

function projectedStartCost(gate: SpendGate): number {
  const cost = gate.lastCost > 0 ? gate.lastCost : DEFAULT_ESTIMATE;
  return gate.spent + gate.inFlight * cost + cost;
}

function maxAllowedSpend(gate: SpendGate): number {
  const cost = gate.lastCost > 0 ? gate.lastCost : DEFAULT_ESTIMATE;
  return gate.cap + cost;
}

function canStartAfterInflight(gate: SpendGate): boolean {
  const cost = gate.lastCost > 0 ? gate.lastCost : DEFAULT_ESTIMATE;
  const spentAfterInflight = gate.spent + gate.inFlight * cost;
  if (spentAfterInflight >= gate.cap) {
    return false;
  }
  return spentAfterInflight + cost <= maxAllowedSpend(gate);
}

export async function acquireEvalStart(gate: SpendGate): Promise<boolean> {
  while (true) {
    const decision = await withGateLock(gate, () => {
      if (gate.exceeded || gate.spent >= gate.cap) {
        return "stop" as const;
      }
      if (projectedStartCost(gate) <= maxAllowedSpend(gate)) {
        gate.inFlight += 1;
        return "go" as const;
      }
      if (gate.inFlight === 0 || !canStartAfterInflight(gate)) {
        return "stop" as const;
      }
      return "wait" as const;
    });

    if (decision === "stop") {
      return false;
    }
    if (decision === "go") {
      return true;
    }

    await new Promise<void>((resolve) => {
      const wake = () => {
        gate._waiters.delete(wake);
        resolve();
      };
      gate._waiters.add(wake);
      setTimeout(wake, 5);
    });
  }
}

export async function finishEvalSpend(
  gate: SpendGate,
  amount: number,
): Promise<void> {
  await withGateLock(gate, () => {
    gate.inFlight -= 1;
    if (amount > 0) {
      gate.lastCost = amount;
    }
    gate.spent += amount;
    if (gate.spent >= gate.cap) {
      gate.exceeded = true;
    }
  });
  notifyGateWaiters(gate);
}

export function recordSpend(tracker: SpendTracker, amount: number): void {
  tracker.spent += amount;
  if (tracker.spent >= tracker.cap) {
    tracker.exceeded = true;
  }
}

export function canStartEval(tracker: SpendTracker): boolean {
  return !tracker.exceeded && tracker.spent < tracker.cap;
}
