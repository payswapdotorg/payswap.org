/**
 * Compile-time assertion helpers. A failed Expect<...> is a tsc error, so the
 * type-level contract guarantees below are enforced by the typecheck gate.
 */
export type Expect<T extends true> = T;
export type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
