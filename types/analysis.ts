import type { Position, PriceTenths, ProjectionConfidence } from "./player";
import type { SquadState } from "./squad";
import type { Horizon } from "./projection";

export interface SquadInsight {
  title: string;
  detail: string;
  severity: "INFO" | "POSITIVE" | "WARNING";
}

export interface SquadWeakness {
  playerId: number;
  score: number;
  reasons: string[];
}

export interface SquadOpportunity {
  outgoingPlayerId: number;
  incomingPlayerId: number;
  projectedDelta: number;
  priceDeltaTenths: PriceTenths;
  reason: string;
}

export interface SquadAnalysis {
  totalCostTenths: PriceTenths;
  bankTenths: PriceTenths;
  projectedNextGW: number;
  projectedNext3: number;
  projectedNext5: number;
  projectedNext10: number;
  startingXI: number[];
  bench: number[];
  strengths: SquadInsight[];
  weaknesses: SquadWeakness[];
  opportunities: SquadOpportunity[];
  structuralWarnings: string[];
  budgetAllocation: Record<Position | "bench", number>;
}

export interface ReplacementCandidate {
  playerId: number;
  priceTenths: PriceTenths;
  projectedNext5: number;
  projectedDelta: number;
  bankDeltaTenths: PriceTenths;
  expectedMinutes: number;
  confidence: ProjectionConfidence;
  reason: string;
}

export type SingleTransferKind = "XP_UPGRADE" | "BOTH" | "CASH_RELEASE";

export interface SingleTransferSuggestion {
  outgoingPlayerId: number;
  incomingPlayerId: number;
  horizon: Horizon;
  beforeXp: number;
  afterXp: number;
  projectedDelta: number;
  projectedDeltaPerGW: number;
  cashReleasedTenths: PriceTenths;
  score: number;
  kind: SingleTransferKind;
  incomingRisk: number;
  confidence: ProjectionConfidence;
  reason: string;
  transfersCount?: number;
  moves?: Array<{
    outgoingPlayerId: number;
    incomingPlayerId: number;
    cashReleasedTenths?: PriceTenths;
  }>;
}

export interface ProposedMove {
  outId: number;
  inId: number;
  priceDeltaTenths: PriceTenths;
  projectedDelta: number;
}

export interface SimulationResult {
  before: SquadAnalysis;
  after: SquadAnalysis;
  horizon: Horizon;
  optimizedBeforeXp: number;
  optimizedAfterXp: number;
  projectedDelta: number;
  priceDeltaTenths: PriceTenths;
  cashReleasedTenths?: PriceTenths;
  projectedDeltaGW: number;
  projectedDelta3: number;
  projectedDelta5: number;
  projectedDelta10: number;
  requiredSecondaryMoves: ProposedMove[];
  legal: boolean;
  explanationFactors: string[];
}

export interface SearchPlayersInput {
  query?: string;
  position?: Position;
  maxPriceTenths?: PriceTenths;
  onlyAffordable?: boolean;
  excludeSelected?: boolean;
}

export type { SquadState };
