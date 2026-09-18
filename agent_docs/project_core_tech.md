# Project Core Technologies

## Languages and Runtimes

TypeScript runs on Node 20.9+.

## Frameworks and Libraries

Next.js App Router and React provide the web application. Zustand manages
client state, Zod validates upstream payloads, and HiGHS WASM solves the exact
MILP optimization problems.

## Build, Test, and Development Tools

npm is the package manager. Vitest covers unit and integration tests, and
Playwright covers browser acceptance tests. `npm run dev`, `npm run build`,
`npm run typecheck`, and `npm run lint` are the primary project commands.

## External Services and Infrastructure

Server routes call the official FPL APIs. Vaastav historical data and RotoWire
lineup/availability snapshots provide evidence inputs. Runtime caching is
in-memory, and no database is required.

## Important Technical Constraints

- Prices and budgets are integer tenths (£10.5m is `105`); convert only for
  display.
- Squad and weekly-lineup legality, official autosubs, captaincy, and transfer
  hits are enforced in shared domain modules.
- Negative FPL availability is authoritative, and positive evidence cannot
  make an unavailable player selectable.
- Exact optimization uses HiGHS MILP with locked players as hard constraints.
