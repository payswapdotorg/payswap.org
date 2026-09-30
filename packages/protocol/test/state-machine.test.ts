import { describe, expect, it } from 'vitest';
import {
  defineStateMachine,
  IllegalTransitionError,
  InvalidStateMachineDefinitionError,
  TerminalStateViolationError,
  TransitionGuardError,
  UndeclaredEventError,
  type StateMachine,
  type StateMachineDefinition,
} from '../src/index.js';

type PaymentState =
  | 'INITIATED'
  | 'AUTHORIZED'
  | 'CAPTURED'
  | 'SETTLED'
  | 'REFUNDED'
  | 'EXPIRED'
  | 'UNKNOWN';
type PaymentEvent =
  | 'AUTHORIZE'
  | 'CAPTURE'
  | 'SETTLE'
  | 'REFUND'
  | 'EXPIRE'
  | 'MARK_UNKNOWN'
  | 'RECONCILE_SETTLED';

interface GuardContext {
  readonly authorizedMinor: bigint;
}

const paymentMachine: StateMachineDefinition<PaymentState, PaymentEvent, GuardContext> = {
  name: 'payment',
  initial: 'INITIATED',
  states: ['INITIATED', 'AUTHORIZED', 'CAPTURED', 'SETTLED', 'REFUNDED', 'EXPIRED', 'UNKNOWN'],
  events: ['AUTHORIZE', 'CAPTURE', 'SETTLE', 'REFUND', 'EXPIRE', 'MARK_UNKNOWN', 'RECONCILE_SETTLED'],
  transitions: [
    { from: 'INITIATED', on: 'AUTHORIZE', to: 'AUTHORIZED', guard: (ctx) => ctx.authorizedMinor > 0n },
    { from: 'INITIATED', on: 'EXPIRE', to: 'EXPIRED' },
    { from: 'AUTHORIZED', on: 'CAPTURE', to: 'CAPTURED' },
    { from: 'AUTHORIZED', on: 'EXPIRE', to: 'EXPIRED' },
    { from: 'CAPTURED', on: 'SETTLE', to: 'SETTLED' },
    { from: 'INITIATED', on: 'MARK_UNKNOWN', to: 'UNKNOWN' },
    { from: 'AUTHORIZED', on: 'MARK_UNKNOWN', to: 'UNKNOWN' },
    { from: 'CAPTURED', on: 'MARK_UNKNOWN', to: 'UNKNOWN' },
  ],
  terminalStates: ['SETTLED', 'REFUNDED', 'EXPIRED', 'UNKNOWN'],
  recovery: [
    // INV-X03: reconciliation is authoritative for ambiguous effects.
    { from: 'UNKNOWN', on: 'RECONCILE_SETTLED', to: 'SETTLED' },
  ],
};

const machine: StateMachine<PaymentState, PaymentEvent, GuardContext> =
  defineStateMachine(paymentMachine);

describe('declared transitions only', () => {
  it('follows declared paths and reports the applied record', () => {
    const first = machine.transition('INITIATED', 'AUTHORIZE', { authorizedMinor: 100n });
    expect(first).toEqual({ from: 'INITIATED', on: 'AUTHORIZE', to: 'AUTHORIZED', viaRecovery: false });
    const second = machine.transition('AUTHORIZED', 'CAPTURE');
    expect(second.to).toBe('CAPTURED');
    const third = machine.transition('CAPTURED', 'SETTLE');
    expect(third.to).toBe('SETTLED');
    expect(machine.isTerminal(third.to)).toBe(true);
  });

  it('throws IllegalTransitionError for undeclared (state, event) pairs', () => {
    expect(() => machine.transition('INITIATED', 'SETTLE')).toThrow(IllegalTransitionError);
    expect(() => machine.transition('CAPTURED', 'REFUND')).toThrow(IllegalTransitionError);
    try {
      machine.transition('INITIATED', 'SETTLE');
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as IllegalTransitionError).details?.reason).toBe('UNDECLARED_TRANSITION');
    }
  });

  it('throws UndeclaredEventError for events the machine never declared', () => {
    expect(() => machine.transition('INITIATED', 'TELEPORT' as PaymentEvent)).toThrow(UndeclaredEventError);
    expect(() => machine.transition('SETTLED', 'TELEPORT' as PaymentEvent)).toThrow(UndeclaredEventError);
  });

  it('throws for undeclared states', () => {
    expect(() => machine.transition('DREAMING' as PaymentState, 'AUTHORIZE')).toThrow(IllegalTransitionError);
  });

  it('canTransition mirrors transition without throwing', () => {
    expect(machine.canTransition('INITIATED', 'AUTHORIZE', { authorizedMinor: 5n })).toBe(true);
    expect(machine.canTransition('INITIATED', 'AUTHORIZE', { authorizedMinor: 0n })).toBe(false);
    expect(machine.canTransition('INITIATED', 'SETTLE')).toBe(false);
    expect(machine.canTransition('INITIATED', 'TELEPORT' as PaymentEvent)).toBe(false);
  });
});

describe('guards', () => {
  it('admits the move when the pure guard accepts', () => {
    expect(machine.transition('INITIATED', 'AUTHORIZE', { authorizedMinor: 1n }).to).toBe('AUTHORIZED');
  });

  it('throws TransitionGuardError when the guard refuses', () => {
    expect(() => machine.transition('INITIATED', 'AUTHORIZE', { authorizedMinor: 0n })).toThrow(
      TransitionGuardError,
    );
    try {
      machine.transition('INITIATED', 'AUTHORIZE', { authorizedMinor: -1n });
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as TransitionGuardError).category).toBe('POLICY_BLOCKED');
    }
  });
});

describe('terminal monotonicity + explicit recovery (INV-X04)', () => {
  it('terminal states never move on ordinary events', () => {
    for (const terminal of ['SETTLED', 'EXPIRED', 'UNKNOWN'] as const) {
      for (const event of ['AUTHORIZE', 'CAPTURE', 'SETTLE', 'EXPIRE', 'MARK_UNKNOWN'] as const) {
        expect(() => machine.transition(terminal, event), `${terminal} + ${event}`).toThrow(
          TerminalStateViolationError,
        );
      }
    }
  });

  it('terminal violations carry the TERMINAL_STATE category', () => {
    try {
      machine.transition('SETTLED', 'REFUND');
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as TerminalStateViolationError).category).toBe('TERMINAL_STATE');
      expect((error as TerminalStateViolationError).code).toBe('TERMINAL_STATE_MONOTONIC_VIOLATION');
    }
  });

  it('the declared recovery rule is the ONLY exit from a terminal state', () => {
    const record = machine.transition('UNKNOWN', 'RECONCILE_SETTLED');
    expect(record).toEqual({ from: 'UNKNOWN', on: 'RECONCILE_SETTLED', to: 'SETTLED', viaRecovery: true });
    // after recovery we are terminal again (SETTLED) and locked once more
    expect(() => machine.transition('SETTLED', 'AUTHORIZE')).toThrow(TerminalStateViolationError);
  });
});

describe('definition validation', () => {
  const base = {
    name: 'validation-target',
    initial: 'A' as const,
    states: ['A' as const, 'B' as const],
    events: ['GO' as const, 'STOP' as const],
    terminalStates: ['B' as const],
  };

  it('rejects transitions to undeclared states', () => {
    expect(() =>
      defineStateMachine({
        ...base,
        transitions: [{ from: 'A', on: 'GO', to: 'C' as 'A' | 'B' }],
      }),
    ).toThrow(InvalidStateMachineDefinitionError);
  });

  it('rejects transitions on undeclared events', () => {
    expect(() =>
      defineStateMachine({
        ...base,
        transitions: [{ from: 'A', on: 'JUMP' as 'GO' | 'STOP', to: 'B' }],
      }),
    ).toThrow(InvalidStateMachineDefinitionError);
  });

  it('rejects normal transitions that originate in a terminal state', () => {
    expect(() =>
      defineStateMachine({
        ...base,
        transitions: [
          { from: 'A', on: 'GO', to: 'B' },
          { from: 'B', on: 'GO', to: 'A' },
        ],
      }),
    ).toThrow(InvalidStateMachineDefinitionError);
  });

  it('rejects recovery rules that do not originate in a terminal state', () => {
    expect(() =>
      defineStateMachine({
        ...base,
        transitions: [{ from: 'A', on: 'GO', to: 'B' }],
        recovery: [{ from: 'A', on: 'STOP', to: 'B' }],
      }),
    ).toThrow(InvalidStateMachineDefinitionError);
  });

  it('rejects duplicate (from, on) rules, undeclared initial, terminal initial', () => {
    expect(() =>
      defineStateMachine({
        ...base,
        transitions: [
          { from: 'A', on: 'GO', to: 'B' },
          { from: 'A', on: 'GO', to: 'B' },
        ],
      }),
    ).toThrow(InvalidStateMachineDefinitionError);

    expect(() =>
      defineStateMachine({
        ...base,
        initial: 'Z' as 'A' | 'B',
        transitions: [],
      }),
    ).toThrow(InvalidStateMachineDefinitionError);

    expect(() =>
      defineStateMachine({
        ...base,
        initial: 'B',
        transitions: [],
      }),
    ).toThrow(InvalidStateMachineDefinitionError);
  });

  it('rejects duplicate states, duplicate terminal states and empty machines', () => {
    expect(() =>
      defineStateMachine({
        ...base,
        states: ['A', 'A', 'B'],
        transitions: [],
      }),
    ).toThrow(InvalidStateMachineDefinitionError);
    expect(() =>
      defineStateMachine({
        ...base,
        terminalStates: ['B', 'B'],
        transitions: [],
      }),
    ).toThrow(InvalidStateMachineDefinitionError);
    expect(() =>
      defineStateMachine({ ...base, states: [], terminalStates: [], transitions: [] }),
    ).toThrow(InvalidStateMachineDefinitionError);
  });

  it('exposes machine metadata', () => {
    expect(machine.name).toBe('payment');
    expect(machine.initial).toBe('INITIATED');
    expect(machine.terminalStates).toContain('UNKNOWN');
    expect(machine.events).toContain('RECONCILE_SETTLED');
  });
});
