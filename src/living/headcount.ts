import { randomUUID } from "node:crypto";
import { type Clock, systemClock } from "./clock.js";
import type { BudgetLedger } from "./budgetLedger.js";
import type { LivingStore } from "./store.js";
import type { DynamicAgentRecord, HeadcountProposal, HeadcountState } from "./types.js";

export interface HeadcountConfig {
  humanMaxSlots: number;
  coreAgentCount: number;
}

export interface ProposeHeadcountInput {
  requestedSlots: number;
  reason: string;
  createdBy: string;
}

export interface RegisterAgentInput {
  id: string;
  displayName: string;
  roleDescription: string;
  personality: string;
  provider?: string;
  model?: string;
  relevanceKeywords?: string[];
  createdBy: string;
}

export class HeadcountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeadcountError";
  }
}

/**
 * Manages how many bots the company may run. The human sets the hard ceiling;
 * active slots can grow via protocol when surplus mode and proposals justify it.
 */
export class HeadcountManager {
  constructor(
    private readonly store: LivingStore,
    private readonly ledger: BudgetLedger,
    private readonly config: HeadcountConfig,
    private readonly clock: Clock = systemClock
  ) {}

  initialize(): HeadcountState {
    const existing = this.store.getHeadcountState();
    if (existing) {
      return existing;
    }
    const state: HeadcountState = {
      humanMaxSlots: this.config.humanMaxSlots,
      activeSlotLimit: this.config.coreAgentCount
    };
    this.store.setHeadcountState(state);
    return state;
  }

  state(): HeadcountState {
    return this.store.getHeadcountState() ?? this.initialize();
  }

  activeAgentCount(): number {
    return this.config.coreAgentCount + this.store.listDynamicAgents("active").length;
  }

  availableSlots(): number {
    const state = this.state();
    return Math.max(0, state.activeSlotLimit - this.activeAgentCount());
  }

  proposeHeadcount(input: ProposeHeadcountInput): HeadcountProposal {
    if (input.requestedSlots < 1) {
      throw new HeadcountError("Must request at least one slot.");
    }
    const proposal: HeadcountProposal = {
      proposalId: `P-${randomUUID().slice(0, 8)}`,
      kind: "headcount",
      requestedSlots: input.requestedSlots,
      reason: input.reason,
      payload: "{}",
      status: "pending",
      createdBy: input.createdBy,
      createdAt: this.clock().toISOString(),
      resolvedBy: null,
      resolvedAt: null
    };
    this.store.insertProposal(proposal);
    return proposal;
  }

  proposeAgent(spec: RegisterAgentInput): HeadcountProposal {
    if (this.availableSlots() <= 0) {
      throw new HeadcountError(
        "No agent slots available. Propose a headcount increase first."
      );
    }
    if (this.store.getDynamicAgent(spec.id)) {
      throw new HeadcountError(`Agent id already exists: ${spec.id}`);
    }
    const proposal: HeadcountProposal = {
      proposalId: `P-${randomUUID().slice(0, 8)}`,
      kind: "agent",
      requestedSlots: 1,
      reason: `New agent: ${spec.displayName}`,
      payload: JSON.stringify(spec),
      status: "pending",
      createdBy: spec.createdBy,
      createdAt: this.clock().toISOString(),
      resolvedBy: null,
      resolvedAt: null
    };
    this.store.insertProposal(proposal);
    return proposal;
  }

  /**
   * Approve a headcount proposal. Operator can auto-approve +1 in surplus mode.
   * Larger increases or deficit mode require human approval.
   */
  approveProposal(
    proposalId: string,
    approver: string,
    options: { humanApproved?: boolean } = {}
  ): HeadcountProposal {
    const proposal = this.requireProposal(proposalId);
    if (proposal.status !== "pending") {
      throw new HeadcountError(`Proposal ${proposalId} is already ${proposal.status}.`);
    }

    if (proposal.kind === "headcount") {
      this.assertHeadcountApprovalAllowed(proposal, options.humanApproved ?? false);
      const state = this.state();
      const nextLimit = state.activeSlotLimit + proposal.requestedSlots;
      if (nextLimit > state.humanMaxSlots) {
        throw new HeadcountError(
          `Would exceed human max slots (${state.humanMaxSlots}). Only the human can raise the ceiling via LIVING_MAX_HEADCOUNT.`
        );
      }
      this.store.setHeadcountState({ ...state, activeSlotLimit: nextLimit });
    } else {
      this.registerAgentFromProposal(proposal, approver);
    }

    return this.resolveProposal(proposal, "approved", approver);
  }

  vetoProposal(proposalId: string, actor: string, reason: string): HeadcountProposal {
    const proposal = this.requireProposal(proposalId);
    if (proposal.status !== "pending") {
      throw new HeadcountError(`Proposal ${proposalId} is already ${proposal.status}.`);
    }
    const resolved = this.resolveProposal(proposal, "vetoed", actor);
    resolved.reason = `${proposal.reason} | VETO: ${reason}`;
    this.store.replaceProposal(resolved);
    return resolved;
  }

  registerAgentFromProposal(proposal: HeadcountProposal, approver: string): DynamicAgentRecord {
    if (proposal.kind !== "agent") {
      throw new HeadcountError("Not an agent proposal.");
    }
    if (this.availableSlots() <= 0) {
      throw new HeadcountError("No slots available.");
    }
    const spec = JSON.parse(proposal.payload) as RegisterAgentInput;
    const agent: DynamicAgentRecord = {
      id: spec.id,
      displayName: spec.displayName,
      roleDescription: spec.roleDescription,
      personality: spec.personality,
      provider: spec.provider ?? "mock",
      model: spec.model ?? "mock",
      temperature: 0.6,
      compressionStyle: "caveman",
      respondsWhen: "mentioned-or-relevant",
      cooldownMs: 20000,
      relevanceKeywords: spec.relevanceKeywords ?? [],
      status: "active",
      createdBy: spec.createdBy,
      createdAt: this.clock().toISOString()
    };
    this.store.insertDynamicAgent(agent);
    void approver;
    return agent;
  }

  listPendingProposals(): HeadcountProposal[] {
    return this.store.listProposals("pending");
  }

  private assertHeadcountApprovalAllowed(proposal: HeadcountProposal, humanApproved: boolean): void {
    const mode = this.ledger.modeRules();
    if (humanApproved) {
      return;
    }
    if (mode.mode === "deficit") {
      throw new HeadcountError("Headcount increase blocked in deficit mode. Human approval required.");
    }
    if (proposal.requestedSlots > 1) {
      throw new HeadcountError(
        "Increasing by more than 1 slot requires human approval. Say: approve headcount " + proposal.proposalId
      );
    }
    if (mode.mode !== "surplus") {
      throw new HeadcountError(
        "Headcount auto-approve only in surplus mode. Human approval required in balance mode."
      );
    }
  }

  private resolveProposal(
    proposal: HeadcountProposal,
    status: HeadcountProposal["status"],
    approver: string
  ): HeadcountProposal {
    const resolved: HeadcountProposal = {
      ...proposal,
      status,
      resolvedBy: approver,
      resolvedAt: this.clock().toISOString()
    };
    this.store.replaceProposal(resolved);
    return resolved;
  }

  private requireProposal(proposalId: string): HeadcountProposal {
    const proposal = this.store.getProposal(proposalId);
    if (!proposal) {
      throw new HeadcountError(`Unknown proposal: ${proposalId}`);
    }
    return proposal;
  }
}
