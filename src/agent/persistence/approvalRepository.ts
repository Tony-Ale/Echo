import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../../integrations/supabase/client.js";
import { clockService } from "../../shared/clockService.js";
import type { AgentApproval, ApprovalRepository } from "../ports.js";
import { AGENT_TABLES } from "./tables.js";

interface ApprovalRow {
  id: string;
  chat_id: string;
  owner_member_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  status: AgentApproval["status"];
  confirmation_message_id?: string | null;
  expires_at: string;
}

export class SupabaseApprovalRepository implements ApprovalRepository {
  public constructor(private readonly client: SupabaseClient = supabase) {}

  public async create(input: Omit<AgentApproval, "id" | "status">): Promise<AgentApproval> {
    const { data, error } = await this.client
      .from(AGENT_TABLES.approvals)
      .insert({
        chat_id: input.chatId,
        owner_member_id: input.ownerMemberId,
        tool_name: input.toolName,
        arguments: input.arguments,
        status: "pending",
        confirmation_message_id: input.confirmationMessageId ?? null,
        expires_at: input.expiresAt,
      })
      .select("id, chat_id, owner_member_id, tool_name, arguments, status, confirmation_message_id, expires_at")
      .single();
    if (error) throw new Error(`Could not create agent approval: ${error.message}`);
    return fromRow(data as ApprovalRow);
  }

  public async attachConfirmationMessage(approvalId: string, messageId: string): Promise<void> {
    const { error } = await this.client
      .from(AGENT_TABLES.approvals)
      .update({ confirmation_message_id: messageId, updated_at: clockService.now().toISO() })
      .eq("id", approvalId)
      .eq("status", "pending");
    if (error) throw new Error(`Could not attach approval message: ${error.message}`);
  }

  public async findPendingByConfirmationMessage(messageId: string): Promise<AgentApproval | null> {
    const { data, error } = await this.client
      .from(AGENT_TABLES.approvals)
      .select("id, chat_id, owner_member_id, tool_name, arguments, status, confirmation_message_id, expires_at")
      .eq("confirmation_message_id", messageId)
      .eq("status", "pending")
      .gt("expires_at", clockService.now().toISO())
      .maybeSingle();
    if (error) throw new Error(`Could not resolve agent approval: ${error.message}`);
    return data ? fromRow(data as ApprovalRow) : null;
  }

  public async updateStatus(id: string, status: AgentApproval["status"], result?: unknown): Promise<void> {
    const { error } = await this.client
      .from(AGENT_TABLES.approvals)
      .update({ status, result: result ?? null, updated_at: clockService.now().toISO() })
      .eq("id", id);
    if (error) throw new Error(`Could not update agent approval: ${error.message}`);
  }
}

function fromRow(row: ApprovalRow): AgentApproval {
  return {
    id: row.id,
    chatId: row.chat_id,
    ownerMemberId: row.owner_member_id,
    toolName: row.tool_name,
    arguments: row.arguments,
    status: row.status,
    confirmationMessageId: row.confirmation_message_id ?? undefined,
    expiresAt: row.expires_at,
  };
}
