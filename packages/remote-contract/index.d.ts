export const VERSION: Readonly<{major: 1; minor: 1}>;
export const CAPABILITIES: readonly string[];
export type Negotiation = {selected: {major: 1; minor: number}; capabilities: string[]; serverEpoch: string; limits: {eventRetention: number; operationRetentionMs: number}; [key: string]: unknown};
export type Runtime = {
  conversationId: string;
  execution: {state: 'idle' | 'preparing' | 'running' | 'waiting_input' | 'cancelling' | 'finalizing' | 'recovering'; operationId: string | null; phase: string | null};
  control: {owner: 'desktop' | 'this_device' | 'other_device' | 'none' | 'unknown'; canWrite: boolean; epoch?: string};
  queue: {pendingCount: number};
  pendingChoices: Array<{toolCallId: string; questions: unknown[]}>;
};
export type View<T = unknown> = {schemaVersion: '1.0'; serverEpoch: string; cursor: string; sequence: number; page: T; runtime: Runtime};
export type Changes = {serverEpoch: string; cursor: string; sequence: number; resyncRequired: boolean; hasMore: boolean; events: Array<{sequence: number; conversationId: string | null; resources: string[]}>};
export type Operation = {operationId: string; conversationId: string; state: 'accepted' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'; terminal: boolean; progress: unknown};
export function validateNegotiation(value: unknown): Negotiation;
export function validateRuntime(value: unknown): Runtime;
export function validateView<T = unknown>(value: unknown): View<T>;
export function validateChanges(value: unknown): Changes;
export function validateOperation(value: unknown): Operation;

export type DurableOperation = {operationId: string; conversationId: string | null; state: 'accepted' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'; terminal: boolean; code: string | null; receipt: unknown; progress: any; acceptedAt: number; expiresAt: number};
export const routes: {queries: string[]; commands: string[]; async: string[]; controlRequired: string[]; transfers: string[]};
export function validateDurableOperation(value: unknown): DurableOperation;
export function validateResource(value: unknown, resource: string): {schemaVersion: '1.0'; resource: string; value: unknown};
