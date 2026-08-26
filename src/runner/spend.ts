export type SpendTracker = {
  spent: number;
  cap: number;
  exceeded: boolean;
};

export function createSpendTracker(cap: number): SpendTracker {
  return { spent: 0, cap, exceeded: false };
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
