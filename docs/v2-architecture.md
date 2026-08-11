# V2 Agent Architecture

v2 treats the language model as the conversation and planning layer. The application no longer classifies messages with keywords or selects a fixed requirement flow.

```text
Feishu message
  -> identity, allowlist, idempotency, conversation lock
  -> pending high-risk action policy
  -> LLM conversation loop
       -> BP domain tools
       -> live Feishu MCP tool search and invocation
  -> tool-result verification
  -> Feishu reply
```

## Responsibilities

The model receives the current message, recent conversation history, sender identity, and current requirement draft. It owns natural-language understanding, multi-turn clarification, planning, and tool selection.

The application exposes stable BP tools for requirement drafts, submission, requirement queries, current work, administrator identity, the requirement Base link, and protected Base field management. Other Feishu capabilities are discovered from the live MCP catalog through two broker tools, so the core does not maintain a duplicate list of Feishu APIs.

Application code owns only enforceable boundaries:

- sender identity, tenant/user/chat allowlists, and data visibility;
- message idempotency and cross-instance conversation locks;
- requirement-draft ownership and explicit submission/cancellation;
- administrator-only Base field deletion and separate confirmation;
- confirmation of MCP mutations by the original requester;
- audit logging, secret redaction, and tool-result verification.

## Failure semantics

Only a tool result with `ok=true` is a successful operation. Domain or Feishu tool failures override a model response that claims success. Expected policy rejections may be explained naturally by the model only when its answer accurately acknowledges the specific rejection.

There is no rule-based conversation fallback. In production, `LLM_ENABLED=true`, `LLM_API_KEY`, and `LLM_MODEL` are mandatory. Startup rejects an invalid configuration; a runtime provider outage returns an explicit unavailability message and does not mutate requirements through a local keyword flow.

## Persistence compatibility

The PostgreSQL schema and `ConversationState.recentMessages` representation are unchanged. v2 stores role-prefixed history strings and normalizes older unprefixed entries when loading them, so deployment does not require a database migration.
