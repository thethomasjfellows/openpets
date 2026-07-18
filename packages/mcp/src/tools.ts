import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { allowedReactions, createOpenPetsClient, OpenPetsClientError, type OpenPetsClient, type OpenPetsLeaseResult, type OpenPetsReaction, type OpenPetsStatusResult } from "@open-pets/client";
import { extname, isAbsolute } from "node:path";
import { z } from "zod";

export const reactionSchema = z.enum(allowedReactions);

export const saySchema = z.object({
  message: z.string().trim().min(1).max(140)
    .refine((value) => !/[\r\n]/.test(value), "Message must be single-line.")
    .refine((value) => !/```|<script|function\s+\w+|=>|\b(class|import|export|const|let|var)\b/.test(value), "Message looks like code.")
    .refine((value) => !/https?:\/\/|www\.|\/[\w.-]+\/[\w./-]+|[A-Za-z]:\\/.test(value), "Message contains URL or path-like content.")
    .refine((value) => !/(api[_-]?key|secret|token|password|passwd|BEGIN [A-Z ]+PRIVATE KEY)/i.test(value), "Message looks secret-like."),
  reaction: reactionSchema.optional(),
});

export const reactSchema = z.object({ reaction: reactionSchema });

const mediaExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
export const showMediaSchema = z.object({
  path: z.string().trim().min(1).max(2048)
    .refine((value) => isAbsolute(value), "Media path must be absolute.")
    .refine((value) => mediaExtensions.has(extname(value).toLowerCase()), "Media path must use a supported image extension."),
  message: saySchema.shape.message.optional(),
  reaction: reactionSchema.optional(),
  durationMs: z.number().int().min(1_000).max(30_000).optional(),
  clickUrl: z.string().trim().url().max(2048).optional(),
});

export interface OpenPetsMcpStatus {
  readonly [key: string]: unknown;
  ok: boolean;
  appRunning: boolean;
  configuredPetId?: string;
  actualTargetPetId?: string;
  actualTargetPetName?: string;
  usingDefaultPet: boolean;
  routingImplemented: boolean;
  unavailableReason?: string;
  fallbackReason?: string;
}

export interface LeaseContext {
  lease?: OpenPetsLeaseResult;
  staleLeaseId?: string;
  /** Full lease object saved when the lease became stale; used for heartbeat-first recovery. */
  staleLease?: OpenPetsLeaseResult;
  degradedReason?: string;
}

export interface ToolContext {
  readonly configuredPetId?: string;
  readonly client?: OpenPetsClient;
  readonly lease?: LeaseContext;
  readonly leaseReady?: Promise<void>;
}

export function createToolContext(configuredPetId?: string): ToolContext & { readonly client: OpenPetsClient } {
  return {
    configuredPetId,
    client: createOpenPetsClient(),
  };
}

export async function handleStatus(context: ToolContext): Promise<CallToolResult> {
  await context.leaseReady;
  const client = context.client ?? createOpenPetsClient();
  const leaseId = context.lease?.lease?.leaseId ?? context.lease?.staleLeaseId;
  const status = await client.status({ leaseId });
  const structured = createMcpStatus(status, context.configuredPetId, context.lease?.lease, context.lease?.degradedReason, context.lease?.staleLeaseId);
  const configuredText = context.configuredPetId
    ? `Configured --pet ${context.configuredPetId}; actual target is ${structured.actualTargetPetId ?? "unavailable"}.`
    : "No --pet configured; actual target is the desktop default pet.";

  if (!structured.appRunning) {
    return {
      content: [{ type: "text", text: `OpenPets is unavailable. ${configuredText} ${structured.unavailableReason ?? "Open the OpenPets desktop app and try again."}` }],
      structuredContent: structured,
    };
  }

  return {
    content: [{ type: "text", text: `OpenPets is running. ${configuredText}` }],
    structuredContent: structured,
  };
}

async function ensureLease(context: ToolContext): Promise<boolean> {
  if (context.lease?.lease) return true;
  try {
    const client = context.client ?? createOpenPetsClient();
    // Fix 2: attempt heartbeat-first recovery when a stale lease is saved
    const staleLeaseId = context.lease?.staleLeaseId;
    const staleLease = context.lease?.staleLease;
    if (staleLeaseId && staleLease) {
      try {
        const hb = await client.heartbeatLease(staleLeaseId);
        // Heartbeat succeeded — desktop still holds the original lease
        if (context.lease) {
          context.lease.lease = { ...staleLease, leaseId: hb.leaseId, expiresAt: hb.expiresAt, leaseActive: true };
          context.lease.staleLeaseId = undefined;
          context.lease.staleLease = undefined;
          context.lease.degradedReason = undefined;
        }
        return true;
      } catch {
        // Heartbeat failed — fall through to acquireLease
      }
    }
    const newLease = await client.acquireLease({ requestedPetId: context.configuredPetId });
    if (context.lease) {
      context.lease.lease = newLease;
      context.lease.staleLeaseId = undefined;
      context.lease.staleLease = undefined;
      context.lease.degradedReason = undefined;
    }
    return !!newLease;
  } catch {
    return false;
  }
}

export async function handleReact(input: unknown, context: ToolContext): Promise<CallToolResult> {
  await context.leaseReady;
  const parsed = reactSchema.safeParse(input);
  if (!parsed.success) return toolError("Invalid reaction. Use one of: " + allowedReactions.join(", "));
  if (!(await ensureLease(context))) return toolError(`OpenPets lease is unavailable. ${sanitizeUnavailableReason(context.lease?.degradedReason) ?? "Open OpenPets and try again."}`);

  try {
    const client = context.client ?? createOpenPetsClient();
    const result = await client.react(parsed.data.reaction, { leaseId: context.lease!.lease!.leaseId });
    return {
      content: [{ type: "text", text: `OpenPets reaction sent: ${parsed.data.reaction}` }],
      structuredContent: { ok: true, reaction: parsed.data.reaction, result },
    };
  } catch (error) {
    return toolError(`OpenPets desktop app is not running or local IPC is unavailable. ${sanitizeError(error)}`);
  }
}

export async function handleSay(input: unknown, context: ToolContext): Promise<CallToolResult> {
  await context.leaseReady;
  const parsed = saySchema.safeParse(input);
  if (!parsed.success) return toolError("Invalid message. Keep it short, single-line, and avoid code, secrets, URLs, and file paths.");
  if (!(await ensureLease(context))) return toolError(`OpenPets lease is unavailable. ${sanitizeUnavailableReason(context.lease?.degradedReason) ?? "Open OpenPets and try again."}`);

  try {
    const client = context.client ?? createOpenPetsClient();
    const result = await client.say(parsed.data.message, { reaction: parsed.data.reaction, leaseId: context.lease!.lease!.leaseId });
    return {
      content: [{ type: "text", text: "OpenPets message sent." }],
      structuredContent: { ok: true, result },
    };
  } catch (error) {
    return toolError(`OpenPets desktop app is not running or local IPC is unavailable. ${sanitizeError(error)}`);
  }
}

export async function handleShowMedia(input: unknown, context: ToolContext): Promise<CallToolResult> {
  await context.leaseReady;
  const parsed = showMediaSchema.safeParse(input);
  if (!parsed.success) return toolError("Invalid media request. Use an absolute PNG, JPG, WEBP, or GIF path and keep optional text safe and short.");
  if (!(await ensureLease(context))) return toolError(`OpenPets lease is unavailable. ${sanitizeUnavailableReason(context.lease?.degradedReason) ?? "Open OpenPets and try again."}`);

  try {
    const client = context.client ?? createOpenPetsClient();
    const result = await client.showMedia(parsed.data.path, {
      message: parsed.data.message,
      reaction: parsed.data.reaction,
      durationMs: parsed.data.durationMs,
      clickUrl: parsed.data.clickUrl,
      leaseId: context.lease!.lease!.leaseId,
    });
    return {
      content: [{ type: "text", text: "OpenPets media shown." }],
      structuredContent: { ok: true, result },
    };
  } catch (error) {
    return toolError(`OpenPets could not show that media. ${sanitizeError(error)}`);
  }
}

export function createMcpStatus(status: OpenPetsStatusResult, configuredPetId?: string, lease?: OpenPetsLeaseResult, degradedReason?: string, staleLeaseId?: string): OpenPetsMcpStatus {
  if (status.leaseActive === false || staleLeaseId) {
    return {
      ok: false,
      appRunning: status.appRunning === true,
      configuredPetId,
      usingDefaultPet: true,
      routingImplemented: true,
      unavailableReason: sanitizeUnavailableReason(degradedReason ?? status.unavailableReason ?? status.staleReason),
      leaseId: typeof status.leaseId === "string" ? status.leaseId : staleLeaseId,
      leaseActive: false,
      staleReason: typeof status.staleReason === "string" ? status.staleReason : "unknown_lease",
    } as OpenPetsMcpStatus;
  }
  if (lease) {
    const statusTargetPetId = typeof status.actualTargetPetId === "string" ? status.actualTargetPetId : undefined;
    const statusTargetPetName = typeof status.actualTargetPetName === "string" ? status.actualTargetPetName : undefined;
    const statusUsingDefault = typeof status.usingDefaultPet === "boolean" ? status.usingDefaultPet : undefined;
    const statusFallbackReason = typeof status.fallbackReason === "string" ? status.fallbackReason : undefined;
    return {
      ok: status.appRunning === true && status.ok !== false,
      appRunning: status.appRunning === true,
      configuredPetId,
      actualTargetPetId: statusTargetPetId ?? lease.actualTargetPetId,
      actualTargetPetName: statusTargetPetName ?? lease.actualTargetPetName,
      usingDefaultPet: statusUsingDefault ?? lease.usingDefaultPet,
      routingImplemented: true,
      fallbackReason: statusFallbackReason ?? lease.fallbackReason,
      leaseId: lease.leaseId,
      leaseActive: lease.leaseActive,
    };
  }
  const defaultPet = isRecord(status.defaultPet) ? status.defaultPet : undefined;
  const actualTargetPetId = typeof defaultPet?.id === "string" ? defaultPet.id : undefined;
  const actualTargetPetName = typeof defaultPet?.displayName === "string" ? defaultPet.displayName : undefined;
  const appRunning = status.appRunning === true;

  return {
    ok: appRunning && status.ok !== false,
    appRunning,
    configuredPetId,
    actualTargetPetId,
    actualTargetPetName,
    usingDefaultPet: true,
    routingImplemented: true,
    unavailableReason: appRunning ? undefined : sanitizeUnavailableReason(degradedReason ?? status.unavailableReason),
    fallbackReason: undefined,
  };
}

export function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function sanitizeUnavailableReason(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return "OpenPets desktop app is unavailable.";
  if (/\/|\\|\.sock|pipe|token|ipc\.json|ENOENT|ECONNREFUSED|EACCES/i.test(value)) {
    return "OpenPets desktop app or local IPC is unavailable.";
  }
  return value.slice(0, 160);
}

function sanitizeError(error: unknown): string {
  if (error instanceof OpenPetsClientError) return sanitizeUnavailableReason(error.message) ?? "OpenPets is unavailable.";
  return "Open OpenPets and try again.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export type { OpenPetsReaction };
