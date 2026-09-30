/**
 * @payswap/protocol — deterministic state machines (W1-001).
 *
 * INV-X04: terminal transitions are monotonic except via declared recovery.
 *
 * A machine is a *declared* graph: states, events, transitions, a terminal
 * set and an explicit recovery map. Anything not declared is impossible:
 * `transition` either returns the applied transition record or throws a
 * typed error — it is never silent.
 *
 * Definition-time validation enforces:
 * - every transition/recovery references declared states and declared events;
 * - at most one rule per (from, on) — no ambiguous first-match semantics;
 * - non-recovery transitions may not originate in a terminal state;
 * - recovery rules may only originate in terminal states;
 * - the initial state is declared and non-terminal.
 */

import { PaySwapError, ValidationError, type PaySwapErrorDetails } from './errors.js';

/** Event used that the machine never declared. */
export class UndeclaredEventError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'UNDECLARED_EVENT', category: 'VALIDATION', message, details });
  }
}

/** (from, on) combination with no declared rule. */
export class IllegalTransitionError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'ILLEGAL_TRANSITION', category: 'CONFLICT', message, details });
  }
}

/**
 * Attempt to leave a terminal state without a declared recovery rule
 * (INV-X04). Distinct TERMINAL_STATE category: terminality violations must
 * never be treated as ordinary conflicts.
 */
export class TerminalStateViolationError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'TERMINAL_STATE_MONOTONIC_VIOLATION', category: 'TERMINAL_STATE', message, details });
  }
}

/** Declared transition refused by its guard. */
export class TransitionGuardError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'TRANSITION_GUARD_REJECTED', category: 'POLICY_BLOCKED', message, details });
  }
}

/** The machine definition itself is invalid. */
export class InvalidStateMachineDefinitionError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'INVALID_STATE_MACHINE_DEFINITION', category: 'VALIDATION', message, details });
  }
}

export interface TransitionRule<S extends string, E extends string, C> {
  readonly from: S;
  readonly on: E;
  readonly to: S;
  /** PURE guard: may read context, must never mutate it or perform I/O. */
  readonly guard?: (context: C) => boolean;
  readonly description?: string;
}

export interface RecoveryRule<S extends string, E extends string> {
  /** Must be a terminal state — recovery is the only exit from terminality. */
  readonly from: S;
  readonly on: E;
  readonly to: S;
  readonly description?: string;
}

export interface StateMachineDefinition<S extends string, E extends string, C> {
  readonly name: string;
  readonly initial: S;
  readonly states: readonly S[];
  readonly events: readonly E[];
  readonly transitions: readonly TransitionRule<S, E, C>[];
  readonly terminalStates: readonly S[];
  readonly recovery?: readonly RecoveryRule<S, E>[];
}

export interface TransitionRecord<S extends string, E extends string> {
  readonly from: S;
  readonly on: E;
  readonly to: S;
  /** True when the move was an explicit recovery out of a terminal state. */
  readonly viaRecovery: boolean;
}

export interface StateMachine<S extends string, E extends string, C> {
  readonly name: string;
  readonly initial: S;
  readonly states: readonly S[];
  readonly events: readonly E[];
  readonly terminalStates: readonly S[];
  isTerminal(state: S): boolean;
  canTransition(state: S, event: E, context?: C): boolean;
  transition(state: S, event: E, context?: C): TransitionRecord<S, E>;
}

function ruleKey(from: string, on: string): string {
  return JSON.stringify([from, on]);
}

/**
 * Build a validated, deterministic state machine. Throws
 * `InvalidStateMachineDefinitionError` on any malformed declaration.
 */
export function defineStateMachine<S extends string, E extends string, C = unknown>(
  definition: StateMachineDefinition<S, E, C>,
): StateMachine<S, E, C> {
  if (typeof definition.name !== 'string' || definition.name.length === 0) {
    throw new InvalidStateMachineDefinitionError('machine name must be a non-empty string');
  }
  const states = [...definition.states];
  const events = [...definition.events];
  const terminalStates = [...definition.terminalStates];
  if (states.length === 0) {
    throw new InvalidStateMachineDefinitionError('at least one state is required', {
      machine: definition.name,
    });
  }
  if (new Set(states).size !== states.length) {
    throw new InvalidStateMachineDefinitionError('duplicate states declared', {
      machine: definition.name,
    });
  }
  if (new Set(events).size !== events.length) {
    throw new InvalidStateMachineDefinitionError('duplicate events declared', {
      machine: definition.name,
    });
  }
  const stateSet = new Set<string>(states);
  const eventSet = new Set<string>(events);
  const terminalSet = new Set<string>(terminalStates);
  for (const terminal of terminalStates) {
    if (!stateSet.has(terminal)) {
      throw new InvalidStateMachineDefinitionError('terminal state is not a declared state', {
        machine: definition.name,
        state: terminal,
      });
    }
  }
  if (new Set(terminalStates.map((s) => s)).size !== terminalStates.length) {
    throw new InvalidStateMachineDefinitionError('duplicate terminal states declared', {
      machine: definition.name,
    });
  }
  if (!stateSet.has(definition.initial)) {
    throw new InvalidStateMachineDefinitionError('initial state is not a declared state', {
      machine: definition.name,
      initial: definition.initial,
    });
  }
  if (terminalSet.has(definition.initial)) {
    throw new InvalidStateMachineDefinitionError('initial state must not be terminal', {
      machine: definition.name,
      initial: definition.initial,
    });
  }

  const normalRules = new Map<string, TransitionRule<S, E, C>>();
  for (const rule of definition.transitions) {
    if (!stateSet.has(rule.from) || !stateSet.has(rule.to) || !eventSet.has(rule.on)) {
      throw new InvalidStateMachineDefinitionError(
        'transition references an undeclared state or event',
        { machine: definition.name, from: rule.from, on: rule.on, to: rule.to },
      );
    }
    if (terminalSet.has(rule.from)) {
      throw new InvalidStateMachineDefinitionError(
        'terminal states may only exit via declared recovery (INV-X04)',
        { machine: definition.name, from: rule.from, on: rule.on },
      );
    }
    const key = ruleKey(rule.from, rule.on);
    if (normalRules.has(key)) {
      throw new InvalidStateMachineDefinitionError(
        'duplicate transition for (from, on); declare exactly one rule per pair',
        { machine: definition.name, from: rule.from, on: rule.on },
      );
    }
    normalRules.set(key, rule);
  }

  const recoveryRules = new Map<string, RecoveryRule<S, E>>();
  for (const rule of definition.recovery ?? []) {
    if (!stateSet.has(rule.from) || !stateSet.has(rule.to) || !eventSet.has(rule.on)) {
      throw new InvalidStateMachineDefinitionError(
        'recovery rule references an undeclared state or event',
        { machine: definition.name, from: rule.from, on: rule.on, to: rule.to },
      );
    }
    if (!terminalSet.has(rule.from)) {
      throw new InvalidStateMachineDefinitionError(
        'recovery may only originate from terminal states (INV-X04)',
        { machine: definition.name, from: rule.from, on: rule.on },
      );
    }
    const key = ruleKey(rule.from, rule.on);
    if (recoveryRules.has(key)) {
      throw new InvalidStateMachineDefinitionError('duplicate recovery rule for (from, on)', {
        machine: definition.name,
        from: rule.from,
        on: rule.on,
      });
    }
    recoveryRules.set(key, rule);
  }

  const machine: StateMachine<S, E, C> = {
    name: definition.name,
    initial: definition.initial,
    states,
    events,
    terminalStates,
    isTerminal(state: S): boolean {
      return terminalSet.has(state);
    },
    canTransition(state: S, event: E, context?: C): boolean {
      if (!eventSet.has(event) || !stateSet.has(state)) {
        return false;
      }
      const rule = terminalSet.has(state)
        ? recoveryRules.get(ruleKey(state, event))
        : normalRules.get(ruleKey(state, event));
      if (rule === undefined) {
        return false;
      }
      // only TransitionRule declares a guard; RecoveryRule has none
      const guard = (rule as TransitionRule<S, E, C>).guard;
      if (guard !== undefined) {
        return guard(context as C);
      }
      return true;
    },
    transition(state: S, event: E, context?: C): TransitionRecord<S, E> {
      if (!eventSet.has(event)) {
        throw new UndeclaredEventError('event is not declared by this machine', {
          machine: definition.name,
          event,
        });
      }
      if (!stateSet.has(state)) {
        throw new IllegalTransitionError('state is not declared by this machine', {
          machine: definition.name,
          state,
          reason: 'UNDECLARED_STATE',
        });
      }
      const isTerminalState = terminalSet.has(state);
      const rule = isTerminalState
        ? recoveryRules.get(ruleKey(state, event))
        : normalRules.get(ruleKey(state, event));
      if (rule === undefined) {
        if (isTerminalState) {
          throw new TerminalStateViolationError(
            'terminal states are monotonic; no recovery rule declared for this event (INV-X04)',
            { machine: definition.name, from: state, on: event },
          );
        }
        throw new IllegalTransitionError('no transition declared for (state, event)', {
          machine: definition.name,
          from: state,
          on: event,
          reason: 'UNDECLARED_TRANSITION',
        });
      }
      // only TransitionRule declares a guard; RecoveryRule has none
      const guard = (rule as TransitionRule<S, E, C>).guard;
      if (guard !== undefined && !guard(context as C)) {
        throw new TransitionGuardError('transition guard refused the requested move', {
          machine: definition.name,
          from: state,
          on: event,
        });
      }
      return { from: state, on: event, to: rule.to, viaRecovery: isTerminalState };
    },
  };
  return machine;
}
