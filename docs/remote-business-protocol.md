# Remote business protocol 1.1

## Scope

This release completes the agreed migration of the currently supported Mobile business surfaces: conversation history/runtime, conversation commands, settings/management, project assignments, media reads and uploads. Mobile's encrypted client now routes these APIs through a connection-scoped business SDK. Legacy RPCs remain compatibility adapters, not a requirement to upgrade both applications for each internal bug fix.

This is not a promise that future features automatically exist on old peers, or that distributed execution is exactly-once forever. The limits and crash semantics below are part of the contract.

## Layers and release integrity

- Remote v2 TLS, hostname/certificate verification, E2EE sequence and replay protections remain unchanged.
- `packages/remote-contract` contains vendored `@anywhere/remote-contract@1.1.0`; `packages/remote-contract-v1` preserves the published 1.0.0 consumer/fixture baseline byte-for-byte. Each checkout builds without a sibling checkout. Explicit interoperability scripts are the exception.
- Schema, runtime validation, TypeScript declarations, routes and hash manifests ship together. Tests verify both releases. LF is pinned with .gitattributes. Released packages must not be edited in place.
- Add optional fields in compatible releases; changing established required fields or critical state semantics needs a new contract version. Unknown content blocks degrade visibly. Unknown execution/operation states are rejected, never treated as idle/success.

## Negotiation

After the authenticated encrypted welcome, the SDK sends `remote.contract.negotiate({versions:[{major:1,minor:1},{major:1,minor:0}]})`. The server selects the highest supported compatible minor.

- Legacy server without negotiation: original RPC adapter, no extra send-queue delay.
- Server selects 1.0: original business RPCs and 1.0 view representation.
- Server selects 1.1: explicit resource/command/transfer routing and structured message content.
- A malformed claimed response or transport failure is NOT permission to downgrade a write operation.

Capabilities remain independently checked. Resource routes require `resource.read.v1`; durable commands require `command.durable.v1`; structured content uses `message.blocks.v1`. The authenticated connection also records service availability for each business route. Absent services reject their routes. UI project reassignment and context usage remain separately optional capabilities.

## Stable resources and routes

`routes.json` lists supported reads, commands, asynchronous commands, control-precondition commands and transfers. It is an allowlist, not arbitrary method invocation.

- `resource.get({resource,params})` -> `{schemaVersion:'1.0',resource,value}`.
- `command.submit({commandId,issuedAt,method,params,preconditions?})` -> validated durable operation.
- `operation.status.get({operationId})` -> durable operation belonging to the authenticated device.
- `transfer.request({method,params})` -> bounded upload lifecycle adapter; never a durable journal entry per upload chunk.

Existing service parameter allowlists, permission/revision checks, quotas and field filtering are retained behind these routes. All active Mobile settings/management, project, media, queue and assistant APIs are registered. The old raw partition JSON editor now uses the existing safe settings UI. `business.config.get/replace` are NOT new-protocol resources: legacy servers/clients retain compatibility, but new Mobile does not fetch raw secret partitions.

`conversation.config.get` is a read resource that waits for the independent Renderer snapshot result. SDK provides a short-lived read receipt to existing UI callers; reads do not consume durable mutation capacity. No current generation/controller is replaced by a settings read.

## Conversation view, content and runtime


### Bounded history delivery and media correction

History reads now apply a 160 KiB page budget (both legacy and structured representations) before the encrypted 256 KiB frame ceiling. They return a continuous latest suffix with a correct older-page cursor; no text is truncated to make a page fit. Mobile can also reduce page size on explicit oversized **read** responses only, and fetches earlier pages when scrolling to the top (the manual button remains available).

A single oversized safe payload is replaced with optional `fullPayload:{id,totalChars,sha256}`. The new Mobile fetches `conversation.history.chunk.get({conversationId,id,offset})`, reassembles UTF-16 code-unit chunks of at most 16384, verifies offsets/length/SHA-256 of the complete UTF-8 JSON, and only then publishes the original message. References are device/conversation scoped, cached for five minutes with a 64 MiB total cache limit. Expired references or capacity limits are explicit failures, not partial-message success. The new endpoint is advertised separately; older Mobile versions do not reconstruct deferred single-message payloads and must update for that case. No transport cap or security filtering is relaxed.

Persisted compaction boundaries hide covered older messages by default, while keeping the summary message; `page.visibleFromUiOrder` prevents cached covered rows from reappearing on refresh. Ordinary assistant/user roles are never used to guess a compaction boundary. `view_image` and `view_pdf` can append user messages for model compatibility: retain their original role and explanatory text, just like directly submitted user content. Do not hide them or rewrite them into tool messages.

Stored data URI and nested attachment references now resolve to authorized opaque image/audio/video media resources. Bytes are read through existing bounded media chunks, not embedded in history pages; original attachment hash/MIME metadata is retained. Audio playback is supported and video uses the same reserved resource path. PDF remains a file notice with no inline PDF rendering. Existing media size/cache quotas still apply.

Hidden Writer deletion commands tolerate only their own new hidden/uncontrolled Writer's readiness transition; they still reject foreign ownership changes. Failed commands clean up only their own newly created idle hidden Writer, never visible, busy or another device's window.


`conversation.view.get({conversationId,pageSize,beforeUiOrder?})` returns schemaVersion/serverEpoch/sequence/cursor/page/runtime. Snapshot cursor is captured before awaited reads. Transcript and runtime are not a cross-store transaction; catch-up repairs changes during reads. Older history remains paginated; no frame limit is increased.

Negotiated 1.0 returns the published sanitized message payload. Negotiated 1.1 returns payload `blocks`, converted only AFTER the existing safe persisted-message projection:

- markdown/text: text content;
- image/audio/video: safe opaque scoped media URI or HTTPS without embedded credentials;
- file: display name, MIME/size metadata and preview availability, no extracted file body;
- notice/unknown: visible safe fallback, never silently remove later messages.

Other message metadata (reasoning, timestamps, status and filtered tool cards) remains in the validated message envelope. Mobile SDK converts content into the current renderer's presentation DTO and removes untrusted source blocks. No base64 media body or arbitrary local path is introduced by block conversion. Existing safe Markdown media handling remains in place.

Execution and ownership are separate: idle/preparing/running/waiting_input/cancelling/finalizing/recovering; owner desktop/this_device/other_device/none/unknown. canWrite is only a UI projection, never a substitute for server control or the SQLite lease.

An opaque per-device control epoch reflects Writer/control changes. Command checks run before dispatch and again at the per-conversation serialized execution point, including delayed send queues. Same-owner activity does not rotate epochs. Historical closed conversations may create a hidden Writer and acquire control through the existing same-device path; unrelated Writer/control changes are rejected. Renderer remains the sole conversation Writer and lease owner; Main only routes/coordinates.

Mobile rejects superseded reads, restores missed choices from snapshots, retains history but disables stale write permission on synchronization failure, and retries until a successful view. Selected runtime does not incorrectly govern other opened conversations.

## Synchronization

Existing encrypted push events are low-latency hints. A 512-entry in-memory invalidation journal and 2.5-second cursor pull repair missed hints. Journal stores only resource names and conversation IDs; private operation invalidations are device-scoped.

`conversation.changes.get({conversationId,cursor})` returns serverEpoch/sequence/cursor/resyncRequired/hasMore:false/events. Wrong/expired/malformed/future cursors require a fresh view. Dirty reads never advance the cursor before replacement; successful empty results can advance it. Epoch rotation after gateway recreation requires resnapshot. This is recoverable invalidation synchronization, not durable full event replay. Media and historical pages are not embedded in invalidations.

## Durable commands and restart semantics

Desktop journal is encrypted using the existing OS safeStorage and stored through the app's existing storage service. It stores command ID, device scope, canonical parameter hash, method, state, bounded recovery result and timestamps; never raw command parameters. Mobile Keychain/Keystore stores only operation ID/conversation ID/time before submission, not message text/configuration.

1. Persist accepted record BEFORE dispatch. Failure prevents dispatch.
2. Repeating the same device+commandId and parameter hash returns original status/receipt; changed parameters reject with remote_command_id_conflict.
3. Terminal events and queries synchronize the record. An early terminal cannot regress to running when ACK arrives late.
4. Lost ACK/connection never causes automatic resend. SDK queries the original operation.
5. Recreated Desktop loads unfinished records as terminal interrupted. This means result unknown/not confirmed, NOT proof that the mutation never happened. Never replay it.
6. Mobile reopening reconciles its pending IDs immediately and every 5 seconds while online, refreshes resources, reports interrupted/unknown results and does not resubmit.
7. A read-only legacy-request compatibility query is allowed only on explicit durable-not-found, never as a write downgrade.
8. Persistence failure after dispatch is uncertain; report remote_operation_storage_failed and query, not a safe-to-repeat failure.

Limits: 512 retained business operations, 7-day retention, 24-hour maximum age for a new command, 60-second future clock tolerance. New command IDs embed their issue timestamp (`command-<13-digit-ms>-<random>`); params.issuedAt must match. Expired IDs cannot be replayed by refreshing the supplied timestamp. Full valid journal rejects new mutations rather than evicting valid idempotency records; settings reads and upload chunks do not consume it. This bounded retention is not an infinite exactly-once guarantee. Keep device clocks correct.

Persistent receipts/results are bounded to 16 KiB each; transcript text, reasoning and tool output are not replicated in durable progress. Configuration snapshots are ephemeral; restored configuration results use refreshRequired so the UI refetches resources. The journal is not transactionally atomic with conversation SQLite/settings storage: a crash between a business mutation and terminal persistence yields interrupted/unknown, never a fabricated success or automatic repeat.

## UI extensions retained

- Long-press conversation: full title, project selection including ungrouped, confirmed deletion. Exact target ID, server control/busy/revision/lease checks, uncertain result queries rather than optimistic removal or repeated deletion.
- Context settings header: Desktop's estimated system/conversation/tool token breakdown, capacity/remaining/overage, compression threshold marker, unsaved preview and stale/unavailable/update-time labels. No raw prompts/tools are added to the statistics DTO.

## Gates and support matrix

- Frozen pre-change v2 consumer from Desktop 0328460 against new gateway (unchanged legacy transport/RPC behavior).
- Frozen published 1.0 contract consumer validates new server's 1.0 response; new Mobile selects legacy routes for 1.0 peers.
- Current 1.1 schema/package integrity, explicit route/unknown resource rejection, safe block fallback, durable concurrency/conflict/expiry/capacity/storage failure/restart/early-terminal tests.
- Real encrypted RemoteClient 1.1 resource/command routing and persisted-ID reconciliation; no plaintext RPC, strict serialized E2EE sequences retained.
- Gateway integration includes actual 1.1 negotiation, structured resource read, durable mutation/duplicate/conflict/status and encrypted disk record assertions.
- Session queue/precondition tests include newly created hidden Writer, same-owner queued send and changed-owner rejection.
- Complete Mobile TypeScript/Jest/lint, Desktop Remote/persistence/lease/build, encrypted cross-application interoperability and QA Metro build remain release gates.

Future work consists of ordinary feature additions, broader historical binary coverage and any explicitly agreed legacy deprecation policy, not the unimplemented migration stages from the Phase 1 delivery. Real-device acceptance is still required; synthetic tests are not a claim of actual installed-application testing.
