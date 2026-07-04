import { randomUUID } from "node:crypto";
import { type Clock, systemClock } from "./clock.js";
import type { LivingStore } from "./store.js";
import type { AgentScoreSummary, ScoreEntry, Task } from "./types.js";

export interface RubricScore {
  agentId: string;
  success: boolean;
  scoreOverall: number; // 0..10
  costEfficiency: number; // 0..10
  latencyMs: number;
  errorRate: number; // 0..1
  rationale: string;
}

export interface CandidateComparison {
  beats: boolean;
  reason: string;
  incumbentScorePerDollar: number;
  candidateScorePerDollar: number;
  sampleSize: number;
}

export interface CompareOptions {
  minSample?: number;
  marginPct?: number;
}

// A candidate must beat the incumbent by a meaningful margin over a minimum sample.
const DEFAULT_MIN_SAMPLE = 20;
const DEFAULT_MARGIN_PCT = 0.15;

const EPSILON = 1e-6;

export class Auditor {
  constructor(
    private readonly store: LivingStore,
    private readonly clock: Clock = systemClock
  ) {}

  // Numbers first. A beautiful explanation of a failed task is a failed task.
  score(task: Task, rubric: RubricScore): ScoreEntry {
    const cost = Math.max(task.costActualUsd ?? task.budgetCapUsd, EPSILON);
    const scorePerDollar = rubric.scoreOverall / cost;
    const entry: ScoreEntry = {
      id: randomUUID(),
      taskId: task.taskId,
      agentId: rubric.agentId,
      success: rubric.success,
      scoreOverall: rubric.scoreOverall,
      costEfficiency: rubric.costEfficiency,
      latencyMs: rubric.latencyMs,
      errorRate: rubric.errorRate,
      scorePerDollar,
      rationale: rubric.rationale,
      shadow: task.shadow,
      realizedOutcome: null,
      createdAt: this.clock().toISOString()
    };
    this.store.insertScore(entry);

    const updated: Task = { ...task, auditorScore: rubric.scoreOverall };
    this.store.replaceTask(updated);
    return entry;
  }

  summaryFor(agentId: string): AgentScoreSummary {
    const scores = this.store.listScoresForAgent(agentId);
    return summarize(agentId, scores);
  }

  // Rolling averages per agent. Only live (non-shadow) scores count for the board.
  scoreboard(): AgentScoreSummary[] {
    const byAgent = new Map<string, ScoreEntry[]>();
    for (const score of this.store.listScores()) {
      if (score.shadow) {
        continue;
      }
      const list = byAgent.get(score.agentId) ?? [];
      list.push(score);
      byAgent.set(score.agentId, list);
    }
    return Array.from(byAgent.entries())
      .map(([agentId, scores]) => summarize(agentId, scores))
      .sort((a, b) => b.avgScorePerDollar - a.avgScorePerDollar);
  }

  weakestAgent(): AgentScoreSummary | undefined {
    const board = this.scoreboard().filter((row) => row.samples > 0);
    if (board.length === 0) {
      return undefined;
    }
    return board.reduce((worst, row) =>
      row.avgScorePerDollar < worst.avgScorePerDollar ? row : worst
    );
  }

  compareCandidate(
    incumbentAgentId: string,
    candidateAgentId: string,
    options: CompareOptions = {}
  ): CandidateComparison {
    const minSample = options.minSample ?? DEFAULT_MIN_SAMPLE;
    const marginPct = options.marginPct ?? DEFAULT_MARGIN_PCT;

    const incumbentScores = this.store.listScoresForAgent(incumbentAgentId);
    const candidateScores = this.store.listScoresForAgent(candidateAgentId);

    // Identical task sets only: compare on tasks both were scored on.
    const incumbentByTask = new Map(incumbentScores.map((s) => [s.taskId, s]));
    const shared = candidateScores.filter((s) => incumbentByTask.has(s.taskId));
    const sampleSize = shared.length;

    const candidateSpd = mean(shared.map((s) => s.scorePerDollar));
    const incumbentSpd = mean(shared.map((s) => incumbentByTask.get(s.taskId)!.scorePerDollar));

    if (sampleSize < minSample) {
      return {
        beats: false,
        reason: `Sample too small: ${sampleSize} < ${minSample}. Small samples are noise.`,
        incumbentScorePerDollar: incumbentSpd,
        candidateScorePerDollar: candidateSpd,
        sampleSize
      };
    }

    const required = incumbentSpd * (1 + marginPct);
    const beats = candidateSpd >= required;
    return {
      beats,
      reason: beats
        ? `Candidate beats incumbent by >= ${marginPct * 100}% over ${sampleSize} tasks.`
        : `Candidate margin too small: ${candidateSpd.toFixed(3)} < required ${required.toFixed(3)}.`,
      incumbentScorePerDollar: incumbentSpd,
      candidateScorePerDollar: candidateSpd,
      sampleSize
    };
  }

  // Mean absolute error between normalized predicted score and realized outcome.
  calibrationError(pairs: Array<{ predicted: number; realized: number }>): number {
    if (pairs.length === 0) {
      return 0;
    }
    const total = pairs.reduce((sum, pair) => sum + Math.abs(pair.predicted - pair.realized), 0);
    return total / pairs.length;
  }
}

function summarize(agentId: string, scores: ScoreEntry[]): AgentScoreSummary {
  const samples = scores.length;
  if (samples === 0) {
    return {
      agentId,
      samples: 0,
      successRate: 0,
      avgCostPerTask: 0,
      avgScore: 0,
      avgScorePerDollar: 0
    };
  }
  const successes = scores.filter((s) => s.success).length;
  return {
    agentId,
    samples,
    successRate: successes / samples,
    avgCostPerTask: mean(scores.map((s) => (s.scoreOverall > 0 ? s.scoreOverall / s.scorePerDollar : 0))),
    avgScore: mean(scores.map((s) => s.scoreOverall)),
    avgScorePerDollar: mean(scores.map((s) => s.scorePerDollar))
  };
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
