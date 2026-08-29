import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../supabase/client.js";

/** Database boundary for resetting one isolated local-staging conversation. */
export class StagingTimelineRepository {
  public constructor(private readonly client: SupabaseClient = supabase) {}

  public async reset(chatId: string): Promise<void> {
    const { error } = await this.client.rpc("echo_reset_staging_timeline", {
      p_chat_id: chatId,
    });
    if (error) throw new Error(`Could not reset the staging timeline: ${error.message}`);
  }
}
