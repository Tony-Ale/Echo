import {
    BufferJSON,
    AuthenticationState,
    AuthenticationCreds,
    initAuthCreds,
    SignalDataTypeMap,
    proto
} from "@whiskeysockets/baileys"
import type { SupabaseClient } from "@supabase/supabase-js"

import { supabase } from "../supabase/client.js"

export const useSupabaseAuthState = async (
    sessionId: string,
    client: SupabaseClient = supabase,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {

    // -----------------------------
    // Read Creds
    // -----------------------------
    const { data: credsRow, error: credsError } = await client
        .from("wa_auth_creds")
        .select("data")
        .eq("session_id", sessionId)
        .maybeSingle()

    // A missing row means this is a new session. Any actual database error must
    // stop startup so it cannot be mistaken for an unpaired WhatsApp account.
    if (credsError) {
        throw new Error(`Failed to load WhatsApp auth credentials: ${credsError.message}`)
    }

    const creds: AuthenticationCreds = credsRow?.data
        ? JSON.parse(JSON.stringify(credsRow.data), BufferJSON.reviver)
        : initAuthCreds()

    // -----------------------------
    // Return Auth State
    // -----------------------------
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const { data: rows, error } = await client
                        .from("wa_auth_keys")
                        .select("id, data")
                        .eq("session_id", sessionId)
                        .eq("type", type)
                        .in("id", ids)

                    if (error) {
                        throw new Error(`Failed to load WhatsApp auth keys: ${error.message}`)
                    }

                    const result: { [_: string]: any } = {}

                    for (const id of ids) {
                        const row = rows?.find(r => r.id === id)

                        let value = row?.data
                            ? JSON.parse(JSON.stringify(row.data), BufferJSON.reviver)
                            : null

                        if (type === "app-state-sync-key" && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value)
                        }

                        result[id] = value
                    }

                    return result
                },

                set: async (data) => {

                    const rowsToUpsert: any[] = []
                    const rowsToDelete: { type: string; id: string }[] = []

                    // Collect changes first so writes can be batched.
                    for (const category in data) {
                        for (const id in data[category as keyof SignalDataTypeMap]) {

                            const value =
                                data[category as keyof SignalDataTypeMap]![id]

                            if (value) {
                                rowsToUpsert.push({
                                    session_id: sessionId,
                                    type: category,
                                    id,
                                    data: JSON.parse(
                                        JSON.stringify(value, BufferJSON.replacer)
                                    )
                                })
                            } else {
                                rowsToDelete.push({
                                    type: category,
                                    id
                                })
                            }
                        }
                    }

                    if (rowsToUpsert.length > 0) {
                        const { error } = await client
                            .from("wa_auth_keys")
                            .upsert(rowsToUpsert, {
                                onConflict: "session_id,type,id"
                            })

                        if (error) {
                            throw new Error(`Failed to batch upsert WhatsApp auth keys: ${error.message}`)
                        }
                    }

                    for (const row of rowsToDelete) {
                        const { error } = await client
                            .from("wa_auth_keys")
                            .delete()
                            .eq("session_id", sessionId)
                            .eq("type", row.type)
                            .eq("id", row.id)

                        if (error) {
                            throw new Error(`Failed to delete WhatsApp auth key: ${error.message}`)
                        }
                    }
                }



            }
        },

        saveCreds: async () => {
            const { error } = await client.from("wa_auth_creds").upsert({
                session_id: sessionId,
                data: JSON.parse(
                    JSON.stringify(creds, BufferJSON.replacer)
                )
            })
            if (error) {
                throw new Error(`Failed to save WhatsApp auth credentials: ${error.message}`)
            }
        }
    }
}
