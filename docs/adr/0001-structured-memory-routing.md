# ADR-0001: Use Structured Routing for Long-Term Memory

## Status

Accepted

## Context

Love Advisor needs long-term memory across conversations, but injecting the full
memory store into every model request would steadily increase token use, dilute
attention, and let stale conclusions influence unrelated answers.

The existing data is already organized around a relationship workspace and can
be routed with stable fields. The system also keeps original ChatLab messages as
evidence, so memory does not need to duplicate chat transcripts or introduce a
semantic retrieval layer.

The design must therefore:

- keep the always-injected memory payload small and bounded;
- let the model retrieve relevant details deterministically;
- preserve provenance for conclusions derived from chat messages;
- remain compatible with the current local JSON store;
- prevent untrusted memory text from becoming model instructions; and
- leave room for dynamic memories to be superseded, invalidated, or archived.

## Decision

Use structured, deterministic memory routing instead of embedding or vector
retrieval.

Each memory has an `id`, `topic`, `type`, `kind`, `title`, `content`, `refs`,
`sourceMessageIds`, `confidence`, `status`, and timestamps. Topics align with the
workspace structure: `her`, `me`, `relationship`, `risk`, `events`, and
`general`. Status is one of `active`, `superseded`, `invalid`, or `archived`.

Every Run receives only a Memory Index capped at 2200 Unicode characters. The
index contains active-memory counts and at most three recent titles per topic;
it is navigation metadata, not authoritative detail. It is wrapped as untrusted
data.

Detailed memory content stays in `case.memories`. The model retrieves it with
`read_context` using exact `memoryTopics`, `memoryTypes`, `memoryStatuses`, or
`memoryIds` filters. Reads default to `active` memories only and remain subject
to the Run-level context byte and call limits.

Memory is compressed knowledge plus navigation, not evidence. When verification
is necessary, `sourceMessageIds` and `refs` route the model back to workspace or
ChatLab evidence.

Static memories produced by an import or full re-analysis keep the existing
bulk replacement model, and user-created memories remain direct writes.
Conversational memories use a review flow: the model calls `propose_memory`,
which validates evidence and buffers at most two proposals in the current Run.
Only a successful Run persists those proposals as pending `memoryCandidates`.
The user can edit, accept, or reject each candidate in chat or in the workspace.
Acceptance atomically creates one active memory and marks the candidate as
accepted; pending and rejected candidates never enter the Memory Index.

## Consequences

### Positive

- Per-Run memory injection has a hard, predictable upper bound.
- Retrieval is explainable and testable because filters use stored fields.
- No embedding service, vector database, chunking pipeline, or reranker is
  required.
- The model receives plain text, which is convenient for reasoning after a
  relevant memory is selected.
- Legacy memories remain readable through normalization defaults.
- Provenance can be followed back to the original evidence rather than trusting
  a detached model conclusion.

### Negative

- Topic and metadata quality directly affect retrieval quality.
- Deterministic filters cannot discover loosely related memories that were
  assigned to the wrong topic.
- The index exposes only recent titles, so the model may need an extra read to
  inspect older memories.
- Active memories still need future update/archive/supersede operations when a
  previously accepted conclusion becomes stale.

### Neutral

- `type` describes the memory's semantic form, while `topic` controls routing;
  both fields are retained for different purposes.
- Static import memories and dynamic conversational memories intentionally have
  different replacement semantics.
- Memory volume on disk may continue to grow even though the prompt payload is
  bounded.

## Failure Modes and Mitigations

- **Stale conclusion remains active:** detailed answers should trace important
  claims to evidence; lifecycle operations will allow replacement or invalidation.
- **Incorrect or missing metadata:** stored memories are normalized, validated,
  and given deterministic defaults based on `type`.
- **Prompt injection inside memory:** the index and context slices are marked as
  untrusted data, and memory content is never treated as system instructions.
- **Context growth from retrieval:** `read_context` enforces a Run-level byte
  budget and read-count limit in addition to the 2200-character index cap.
- **Model silently stores a weak inference:** model-facing writes create pending
  candidates only; a memory becomes active only after explicit user acceptance.
- **Failed answer leaves memory behind:** proposals are Run-local and are
  persisted only on the successful completion path.

## Alternatives Considered

**Inject all memories on every Run**

Rejected because prompt size and attention pollution grow with the memory store,
and stale or irrelevant conclusions receive the same prominence as relevant
ones.

**Embedding/vector RAG**

Rejected for the current architecture. The memory set already has useful
structure, exact routing is sufficient for the expected access patterns, and a
vector stack would add operational complexity without a demonstrated retrieval
need.

**Single free-form `MEMORY.md` file**

Rejected because it lacks deterministic filtering, item-level provenance, and
lifecycle state, and it eventually recreates full-memory prompt injection.

**Automatically review and rewrite memory after every Turn**

Deferred because it adds model cost, creates noisy low-value memories, and can
silently change long-term conclusions. A candidate/review flow is preferable
for dynamic memory.

## References

- [Love Advisor Memory Architecture](../plans/love-advisor-memory-architecture.md)
- [Hermes Agent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- [Hermes Agent 2200-character memory discussion](https://github.com/NousResearch/hermes-agent/issues/16831)
- [Hermes Agent indexed memory routing proposal](https://github.com/NousResearch/hermes-agent/issues/22612)
