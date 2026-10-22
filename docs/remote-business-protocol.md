# Remote business protocol 1.0 — Phase 1

Status: implemented compatibility foundation, not completion of the full remote redesign.

## Layers and packaging

- Transport remains Remote v2 over strict TLS and E2EE. Business cursors never replace encryption sequence numbers.
- `packages/remote-contract` is a complete vendored release of `@anywhere/remote-contract@1.0.0`: schema, runtime validation, declarations, fixtures and integrity manifest. Neither application imports a sibling checkout at runtime.
- JSON Schema defines structural validation; runtime checks add cross-field invariants. The bundled validator implements only this release's vocabulary; unsupported keywords must not be added without updating validation and tests.
- Same-major changes may add optional fields. Existing required fields, enum semantics and security meanings cannot be changed. Unknown critical states fail validation; unknown optional fields are preserved/ignored.
- Do not edit a released contract in place. Publish a new version and retain frozen fixtures. Consumers pin versions independently; they need not always use byte-identical releases.

## Negotiation and compatibility

After encrypted connection, `remote.status.get` advertises `remote.contract.negotiate`. A client sends `{versions:[{major:1,minor:0}]}`. The server selects 1.0 or returns `remote_contract_version_unsupported`.

New read RPCs require negotiation on that exact authenticated socket context. Legacy RPCs require no new negotiation and retain their previous behavior.

| Capability | Endpoint / semantics |
|---|---|
| conversation.view.v1 | conversation.view.get: complete latest-page view |
| conversation.runtime.v1 | execution, control, queue and pending choices in view |
| conversation.invalidation.v1 | conversation.changes.get: bounded invalidation replay |
| operation.read.v1 | operation.get: normalized finite-lived existing request state |

Capabilities are independently optional; an absent operation reader must not disable supported views. A legacy server lacking advertisement uses the legacy adapter. A malformed response, transport error or rejected negotiation must not silently downgrade into a write path.

Optional legacy-compatible extensions: `conversation.project.set` and `conversation.context.usage.v1` are advertised independently. Old clients ignore them; old servers leave the corresponding new UI unavailable.

## View and runtime

`conversation.view.get({conversationId,pageSize})` returns `{schemaVersion:'1.0',serverEpoch,sequence,cursor,page,runtime}`. `page` uses the existing sanitized conversation/message/task/pagination DTO. Older history remains paginated; media bytes and document extraction bodies are not embedded. This phase does not introduce new message block semantics.

Runtime separates execution from control. Execution states: idle, preparing, running, waiting_input, cancelling, finalizing, recovering. Unknown states must not be interpreted as idle. Control owner: desktop, this_device, other_device, none, unknown; canWrite can be true only for this_device and a valid writer. This UI projection never replaces server authorization or SQLite lease checks. Other devices' request IDs, choices, paths, credentials and Renderer references must not leak.

Runtime and transcript are read from different authorities, not an atomic cross-store transaction. The cursor is captured before asynchronous reads; concurrent changes remain available for catch-up. Consumers reject superseded in-flight snapshots and use invalidations to converge. Read failure retains history but removes stale local write permission until a successful view.

## Synchronization

Phase 1 is pull-based invalidation synchronization, NOT a durable push event stream. Existing push events provide low-latency hints; a 2.5-second changes query repairs missed hints. No full message payload is replayed in the journal.

The in-memory journal retains 512 invalidations. Cursor is opaque `serverEpoch:sequence`, scoped by authenticated device and conversation when queried. Each entry contains only sequence, optional conversation ID and resource names. Private operation entries are device-scoped; global window/control changes can invalidate all views without including their content.

`conversation.changes.get({conversationId,cursor})` returns `{serverEpoch,sequence,cursor,resyncRequired,hasMore:false,events}`. Wrong epoch, expired cursor, malformed cursor or cursor beyond head => resyncRequired. On dirty/resync, fetch a new view before replacing the cursor. On empty successful changes, advance the cursor; on failure retain it. Reconnection renegotiates and starts a new view. No unbounded frame-cap increase or disabling oversized-response errors.

## Operations and writes

`operation.get({operationId})` maps current device's existing request record to accepted/queued/running/succeeded/failed/cancelled, with validated progress. It does not expose another device's operation.

Phase 1 request records are in memory, expire after at most 30 minutes when pruned, and may be evicted earlier under the existing 256-record cap. The negotiation limit is a maximum age, NOT a guaranteed recovery SLA. Desktop restart can return request_not_found; Mobile must not automatically resend. There is no durable commandId, restart recovery or exactly-once promise in this phase.

Existing send, edit, regenerate, config, control and deletion write RPCs remain in place. Accepted is not succeeded. Writer lease and persistence acknowledgment remain authoritative. Project changes use a serialized `conversation.project.set({conversationId,projectId})` command; empty ID means ungrouped, nonempty ID must exist, paths are rejected. The lease-owning Renderer reuses existing persistence and revision checks. Deletion requires confirmed:true; UI must confirm and wait for completion, never optimistically delete or retry an uncertain command.

Context usage is an optional numeric-only `contextUsage` field on config results: status, estimated:true, systemTokens, conversationTokens, toolTokens, updatedAt. It reuses Desktop's prompt breakdown. Busy reads do not replace the running request and may return stale estimates. Missing values are unavailable, not zero. Capacity/threshold drafts on Mobile are labeled as unsaved preview.

## Gates

- `pnpm run test:remote-contract`: frozen v1 fixture, validation/security/epoch/race tests, release hash verification, frozen pre-change v2 consumer from Desktop 0328460 against the current server.
- Mobile business-session tests: frozen legacy server capability response, missing capabilities, malformed claimed support, stale responses, resync, and real hook recovery.
- Current Desktop/Mobile encrypted interoperability is an additional gate, not a replacement for historical baselines.
- Runtime source/build/tests must work from one checkout without the other application present (the explicit interop script is the exception).

## Remaining phases / no completion claim

1. Durable command journal and idempotency keys, explicit interrupted/expired/unknown outcomes after restart, control epochs and write preconditions.
2. Structured message blocks and attachment resources with safe unknown-block fallback, then all settings/resources migration.
3. New write command facade, broader historical binary/version matrix and agreed deprecation/support window. Existing safeguards stay until replacement gates pass.
