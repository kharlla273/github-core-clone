// scenario.ts — the suite's seeded identity, derived the same way the suite derives it.
//
// The suite (kit sdk/conformance/wire.ts) builds every name it uses from one fixed constant,
// SCENARIO_SEED = 0x6a09e667f3bcc909n. The token owner — the "viewer" every check addresses
// repositories under — is users[0] of generateUsers(scenarioRng('users'), 12). This module ports
// exactly that derivation (FNV-1a + splitmix64 seeding, xorshift64* stream, the name tables), so
// the forge answers viewer.login, owner.login and GET /api/v3/user with the login the suite
// expects, in every trial, without hardcoding a string.
//
// The port is verified against the kit: node --experimental-strip-types scenario.ts prints
// viewer adaiversen (id 1000).

export const SCENARIO_SEED = 0x6a09e667f3bcc909n;
export const SCENARIO_SEED_HEX = '6a09e667f3bcc909';
const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_USERS = 12;

const FIRST_NAMES: readonly string[] = Object.freeze([
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
]);
const LAST_NAMES: readonly string[] = Object.freeze([
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
]);

export interface ScenarioUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** FNV-1a, 64-bit: a label's stable seed contribution. */
function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

/** splitmix64's finalizer. */
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** The seed a named stream starts from. */
function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/** xorshift64*: the suite's PRNG, verbatim. */
class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

function scenarioRng(label: string): Rng {
  return new Rng(scenarioSeedFor(label));
}

/** `count` users with unique logins, deterministic for `rng`. */
function generateUsers(rng: Rng, count: number): ScenarioUser[] {
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < Math.max(0, Math.trunc(count)); i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push(Object.freeze({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` }));
  }
  return users;
}

const USERS: readonly ScenarioUser[] = Object.freeze(generateUsers(scenarioRng('users'), SCENARIO_USERS));

/** The token owner: users[0], the login every repository in the suite belongs to. */
export const VIEWER: ScenarioUser = USERS[0] as ScenarioUser;
/** The second and third scenario users, for completeness (never owners of suite repositories). */
export const TEAMMATE: ScenarioUser = USERS[1] as ScenarioUser;
export const STRANGER: ScenarioUser = USERS[2] as ScenarioUser;
export const SCENARIO_USERS_LIST: readonly ScenarioUser[] = USERS;
