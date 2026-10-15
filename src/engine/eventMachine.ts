export type EventSignal<Side extends string = string> = {
  confidence: number;
  side: Side;
  joint: string;
};

export type EventRuleConfig = {
  min: number;
  grace?: number;
  cooldown: number;
};

export type EventState<Side extends string = string> = {
  start: number | null;
  activeDuration: number;
  peak: number;
  fired: boolean;
  misses: number;
  lastFired: number;
  side: Side;
  joint: string;
  firingIndex: number | null;
};

export type DetectorFiring<Rule extends string = string, Side extends string = string> = {
  rule: Rule;
  start: number;
  end: number;
  peak: number;
  confidence: number;
  side: Side;
  joint: string;
};

export function createEventStates<Rule extends string, Side extends string>(
  keys: readonly Rule[],
  defaultSide: Side,
): Record<Rule, EventState<Side>> {
  const value = {} as Record<Rule, EventState<Side>>;
  for (const key of keys) {
    value[key] = {
      start: null,
      activeDuration: 0,
      peak: 0,
      fired: false,
      misses: 0,
      lastFired: -Infinity,
      side: defaultSide,
      joint: "body",
      firingIndex: null,
    };
  }
  return value;
}

/**
 * Convert sampled detector activations into durable events.
 *
 * Duration is accumulated from active samples rather than inferred from the
 * wall-clock distance between the first and latest hit. Grace frames preserve
 * a run across brief pose dropouts but do not count those dropouts as active
 * time. This makes an identical score sequence form the same event regardless
 * of where it appears in a clip.
 */
export function advanceEventStates<Rule extends string, Side extends string>(
  keys: readonly Rule[],
  rules: Record<Rule, EventRuleConfig>,
  signals: Partial<Record<Rule, EventSignal<Side>>>,
  sample: { time: number; dt: number },
  state: Record<Rule, EventState<Side>>,
  firings: DetectorFiring<Rule, Side>[],
) {
  for (const key of keys) {
    const config = rules[key];
    const current = state[key];
    const signal = signals[key];
    if (signal && signal.confidence > 0) {
      current.misses = 0;
      if (current.start === null) {
        current.start = sample.time;
        current.activeDuration = 0;
      }
      current.activeDuration += Math.max(0, sample.dt);
      current.peak = Math.max(current.peak, signal.confidence);
      current.side = signal.side;
      current.joint = signal.joint;

      const cooledDown = sample.time - current.lastFired >= config.cooldown;
      if (!current.fired && current.activeDuration >= config.min && cooledDown) {
        firings.push({
          rule: key,
          start: current.start,
          end: sample.time,
          peak: sample.time,
          confidence: current.peak,
          side: current.side,
          joint: current.joint,
        });
        current.firingIndex = firings.length - 1;
        current.fired = true;
        current.lastFired = sample.time;
      } else if (current.fired && current.firingIndex !== null) {
        const firing = firings[current.firingIndex];
        if (firing) {
          firing.end = sample.time;
          if (signal.confidence >= firing.confidence) {
            firing.confidence = signal.confidence;
            firing.peak = sample.time;
            firing.side = signal.side;
            firing.joint = signal.joint;
          }
        }
      }
      continue;
    }

    current.misses += 1;
    if (current.misses >= (config.grace ?? 2)) {
      current.start = null;
      current.activeDuration = 0;
      current.peak = 0;
      current.fired = false;
      current.misses = 0;
      current.firingIndex = null;
    }
  }
}
