// dsh-team-link — node half (host plugin).
//
// Upstream dsh-session-link behavior, kept in full: direct user prompts
// carrying a session deep link (the canonical `dsh-session:<base64url>` URI,
// this deployment's `dsh://session/<sessionId>` deep link, or the legacy web
// deep link `http(s)://<host>/s/<sessionId>`) are resolved through the shipped
// session-reference service and the bounded snapshot is injected as read-only
// model context immediately before the direct prompt.
//
// New in -pro:
//  1. team_link_list_sessions — list the sessions of the current
//     workspace (id / title / running state / created time).
//  2. team_link_export — export any session as markdown + JSON into
//     the session workspace's `.dsh-exports/` directory; the same renderer
//     also streams downloads through an exact webServer route for the
//     conversation-header export button.
//  3. team_link_send — deliver a message to another live session.
//     A running target receives it inside its current turn (steer); an idle
//     target gets it queued without being woken (inject). Every send passes
//     two gates before delivery: the sender's user must approve (permanently
//     memorable per target) and the receiver's inbound policy must accept it
//     (ask / accept / reject, plus trusted and blocked sender lists, edited
//     through the settings UI).
import { encodeSessionReferenceUri, parseSessionReferenceText } from "@deepseek-ai/dsh-session-reference";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "schemastery";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Stable Cordis plugin name (also the package id the client half rides on). */
const name = "dsh-team-link";
/** Services this host row needs before it activates. The remaining services
 * (userQuestions, settings, webServer) are resolved at runtime and degrade
 * gracefully when absent: sends refuse without an approval UI, approval
 * memory falls back to process-local state, and the export route is skipped
 * while the export tool keeps working. */
const inject = ["sessionReferenceResolver", "tools", "sessionQuery", "agents"];

const PLUGIN_LABEL = "dsh-team-link";
/** Directory (inside the session's workspace) receiving export artifacts. */
const EXPORT_DIR = ".dsh-exports";
/** Per-text-block truncation limit for markdown exports (JSON stays complete). */
const MD_BLOCK_LIMIT = 16000;
/** Per-tool-result truncation limit for markdown exports. */
const MD_TOOL_RESULT_LIMIT = 2000;
/** How long the receiving user has to answer an inbound confirmation. */
const RECEIVE_CONFIRM_TIMEOUT_MS = 180000;
/** Cap on sessions rendered by the list tool. */
const LIST_LIMIT = 50;
/** Cap on sessions given a topic/activity digest (each digest costs a log read). */
const PREVIEW_SESSIONS = 12;

// ---------------------------------------------------------------------------
// upstream deep-link resolution (verbatim behavior; labels renamed only)
// ---------------------------------------------------------------------------

/**
 * `dsh://` deep links copied by the header button: `dsh://session/<sessionId>`.
 * Only ids shaped like harness session ids (`session-…`) are treated as
 * references, so an unrelated `dsh://` URI cannot hijack a message.
 */
const DSH_URI_RE = /dsh:\/\/session\/(session-[A-Za-z0-9_-]+)/gu;
/**
 * Legacy web deep links: `/s/<sessionId>`. Kept for pasted copies of the
 * browser-openable URL. The host part is ignored: session ids are opaque and
 * local to this DSH home.
 */
const WEB_DEEP_LINK_RE = /https?:\/\/[^\s"'<>()\\]+?\/s\/(session-[A-Za-z0-9_-]+)/gu;
/** Any occurrence of a supported link form, used as a cheap pre-filter. */
const ANY_LINK_RE = /dsh-session:[A-Za-z0-9_-]+|dsh:\/\/session\/session-[A-Za-z0-9_-]+|\/s\/session-[A-Za-z0-9_-]+/u;

/** True when the message is a direct user prompt rather than injected context. */
function isDirectUserMessage(message) {
	return message !== null && typeof message === "object" && message?.source?.kind === "user";
}

/** All text of one content block array, in order. */
function textOf(content) {
	if (!Array.isArray(content)) return "";
	return content.flatMap((block) => block?.type === "text" && typeof block?.text === "string" ? [block.text] : []).join("\n");
}

/**
 * Normalize one content block array for references: `dsh://` and web deep
 * links become markdown mentions, then every `dsh-session:` form is parsed
 * into a structured reference and replaced with its readable `@label` text.
 * Malformed or non-canonical URIs throw — callers must never let that fail a
 * user's turn.
 * @param content - the user message content.
 * @returns the normalized content and the structured references, or
 *   `null` when no reference-shaped text was present.
 */
function normalizeReferences(content) {
	let references = [];
	let changed = false;
	const normalized = content.map((block) => {
		if (block?.type !== "text" || typeof block?.text !== "string") return block;
		if (!ANY_LINK_RE.test(block.text)) return block;
		const withMentions = block.text
			.replace(DSH_URI_RE, (_full, sessionId) => `@[${sessionId}](${encodeSessionReferenceUri(sessionId)})`)
			.replace(WEB_DEEP_LINK_RE, (_full, sessionId) => `@[${sessionId}](${encodeSessionReferenceUri(sessionId)})`);
		const parsed = parseSessionReferenceText(withMentions);
		if (parsed.references.length > 0) changed = true;
		references = [...references, ...parsed.references];
		return { ...block, text: parsed.text };
	});
	return changed ? { content: normalized, references } : null;
}

/**
 * Register the upstream `agent/pre-step` listener that turns deep links found
 * in direct user prompts into sourced snapshot context. Fail-open throughout.
 * @param ctx - plugin context carrying the `sessionReferenceResolver` service.
 */
function registerDeepLinks(ctx) {
	ctx.on("agent/pre-step", async ({ agent, turn, step, signal }, next) => {
		const decision = await next();
		if (decision.kind === "reject" || signal?.aborted === true) return decision;
		// Fail open: no parse or snapshot failure may ever break a user turn.
		const targets = [];
		for (const message of decision.messages) {
			if (!isDirectUserMessage(message)) continue;
			try {
				const text = textOf(message.content);
				if (text === "" || !ANY_LINK_RE.test(text)) continue;
				const normalized = normalizeReferences(message.content);
				if (normalized !== null) targets.push({ message, ...normalized });
			} catch (error) {
				ctx.logger?.warn?.(`${PLUGIN_LABEL}: leaving a malformed link as plain text: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (targets.length === 0) return decision;
		// Build the modified decision; every later failure leaves it untouched.
		const result = { ...decision, messages: [...decision.messages] };
		for (const target of targets) {
			try {
				const prepared = await ctx.sessionReferenceResolver.prepare(agent, target.content, target.references, signal);
				const index = result.messages.indexOf(target.message);
				if (index === -1) continue;
				// The injected snapshot is the plugin's most direct carrier INTO the
				// caller's next request, and the referenced session's own log is exactly
				// where a lone surrogate can come from — so both messages are repaired
				// here (a no-op for well-formed text; the resolver's behavior is left
				// alone, only the bytes it hands over are).
				const replaced = { ...target.message, content: wellFormedContent(prepared.content) };
				const context = prepared.additionalContext === undefined || prepared.additionalContext === null
					? prepared.additionalContext
					: { ...prepared.additionalContext, content: wellFormedContent(prepared.additionalContext.content) };
				// Sourced snapshot first, then the readable direct prompt. `additionalContext`
				// is optional in the resolver's contract, so a missing one is dropped rather
				// than spliced in as `undefined` — the direct prompt must survive either way.
				if (context === undefined || context === null) result.messages.splice(index, 1, replaced);
				else result.messages.splice(index, 1, context, replaced);
			} catch (error) {
				if (signal?.aborted === true) return decision;
				ctx.logger?.warn?.(`${PLUGIN_LABEL}: skipped references in turn ${turn} step ${step}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return result;
	}, { prepend: true });
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/** Filesystem-safe timestamp for export artifact names. */
function timestamp(date = new Date()) {
	const pad = (n) => String(n).padStart(2, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Local `YYYY-MM-DD HH:mm:ss` stamp for relay banners. The audited
 * `agent-message` source admits exactly `{kind, form, senderSessionId}`, so the
 * delivery time has no home there and travels in the message body instead —
 * where the receiving card reads it back.
 */
function localStamp(date = new Date()) {
	const pad = (n) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Single-line preview of arbitrary text. Cuts on code-point boundaries only: a
 * code-unit slice can split a surrogate pair and leave a lone surrogate — half
 * an emoji — in the returned string, and a lone surrogate forwarded into the
 * next model request fails that request with HTTP 400 INVALID_REQUEST for the
 * rest of the session (see `wellFormed`). The limits themselves are unchanged;
 * only the counting unit is: `[...flat]` iterates code points, so a preview is
 * truncated when it exceeds `limit` code points, not code units.
 */
function preview(text, limit = 120) {
	const flat = String(text ?? "").replace(/\s+/gu, " ").trim();
	const chars = [...flat];
	return chars.length <= limit ? flat : `${chars.slice(0, limit - 1).join("")}…`;
}

/**
 * Truncate long text with an explicit marker (exports must stay honest). Cuts
 * on code-point boundaries only, for the same reason as `preview`. The count in
 * the marker is a code-point count too: it used to count UTF-16 code units, so
 * an astral character was billed as two "字符" while being cut in half.
 */
function truncate(text, limit) {
	const value = String(text ?? "");
	const chars = [...value];
	return chars.length <= limit ? value : `${chars.slice(0, limit).join("")}\n…[已截断 ${chars.length - limit} 字符]`;
}

/**
 * A lone surrogate must never leave this plugin: the orchestrator forwards tool
 * output verbatim into the next model request, and an unpaired surrogate makes
 * that request fail with HTTP 400 INVALID_REQUEST — permanently, for the whole
 * session (observed on 4/4 logged sessions that carried one over
 * deepseek-official). `preview`/`truncate` keep this plugin from CREATING a lone
 * surrogate; this pass also repairs one that entered from outside — an older
 * build's log, a cross-session message body, an echoed tool argument. The
 * unpaired half becomes U+FFFD; nothing else in the string changes.
 * `String.prototype.toWellFormed` (Node >= 20) is the native equivalent, the
 * regex is the fallback for older runtimes.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
function wellFormed(value) {
	const text = String(value ?? "");
	return typeof text.toWellFormed === "function" ? text.toWellFormed() : text.replace(LONE_SURROGATE, "\uFFFD");
}

/** Well-formed copy of a content block array: text blocks are repaired, every
 * other block (and a non-array) passes through untouched. */
function wellFormedContent(content) {
	if (!Array.isArray(content)) return content;
	return content.map((block) => block?.type === "text" && typeof block.text === "string" ? { ...block, text: wellFormed(block.text) } : block);
}

/**
 * Tool output contract for every tool in this plugin: a plain string value,
 * rendered well-formed. `output.render` is the last stop before a return value
 * becomes model-facing tool-result content (dsh-tools calls it and snapshots the
 * blocks), so this single gate covers every return path — including the early
 * refusals whose text embeds log-derived ids and titles.
 */
function textOutput() {
	return {
		schema: { type: "string" },
		render: (_args, value) => [{ type: "text", text: wellFormed(String(value)) }],
	};
}

/** JSON.stringify that never throws and never returns undefined. */
function safeJson(value) {
	try {
		const text = JSON.stringify(value, null, 2);
		return text === undefined ? String(value) : text;
	} catch {
		return String(value);
	}
}

/** Human-readable one-line description of a thrown error. */
function describeError(error) {
	if (error !== null && typeof error === "object" && typeof error.code === "string" && error.code !== "") {
		return `${error.code}: ${error.message ?? ""}`.trim();
	}
	if (error instanceof Error) return error.message;
	return String(error);
}

/** Session id of the agent executing a tool call, when known. */
function agentSessionId(exec) {
	return typeof exec?.agent?.id === "string" && exec.agent.id !== "" ? exec.agent.id : undefined;
}

/** Workspace cwd of the agent executing a tool call. */
function agentCwd(exec) {
	const cwd = exec?.agent?.session?.header?.cwd;
	return typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
}

/** `「标题」(id)` when a title exists, the bare id otherwise. */
function sessionLabel(sessionId, title) {
	return typeof title === "string" && title !== "" ? `「${title}」(${sessionId})` : sessionId;
}

/** First direct-user text on a session surface — what the session was asked to do. */
function firstSurfaceUserText(events) {
	for (const event of events) {
		if (event?.type !== "user/message" || event.data?.source?.kind !== "user") continue;
		const text = textOf(event.data.content);
		if (text !== "") return text;
	}
	return undefined;
}

/** Latest human/model text on a session surface — what the session is doing now. */
function lastSurfaceText(events) {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.type === "assistant/message") {
			const text = textOf(event.data?.message?.content);
			if (text !== "") return text;
		} else if (event?.type === "user/message" && event.data?.source?.kind === "user") {
			const text = textOf(event.data.content);
			if (text !== "") return text;
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// policy store: settings-backed, memory fallback
// ---------------------------------------------------------------------------

/** Default cross-session messaging policy. */
const DEFAULT_POLICY = {
	receiveMode: "ask",
	trustedSenders: [],
	blockedSenders: [],
	rememberTargets: [],
	pairs: [],
};

const POLICY_MODES = new Set(["ask", "accept", "reject"]);

const PolicyConfig = z.object({
	receiveMode: z.string().default("ask"),
	trustedSenders: z.array(z.string()).default([]),
	blockedSenders: z.array(z.string()).default([]),
	rememberTargets: z.array(z.string()).default([]),
	pairs: z.array(z.object({ a: z.string(), b: z.string(), createdAt: z.number().default(0) })).default([]),
});

/** Coerce any stored/patched value into a complete, well-typed policy view. */
function normalizePolicy(value) {
	const stringList = (list) => Array.isArray(list) ? list.filter((item) => typeof item === "string") : [];
	const pairList = (list) => Array.isArray(list) ? list.filter((pair) => typeof pair?.a === "string" && typeof pair?.b === "string").map((pair) => ({ a: pair.a, b: pair.b, createdAt: typeof pair.createdAt === "number" ? pair.createdAt : 0 })) : [];
	return {
		receiveMode: POLICY_MODES.has(value?.receiveMode) ? value.receiveMode : "ask",
		trustedSenders: stringList(value?.trustedSenders),
		blockedSenders: stringList(value?.blockedSenders),
		rememberTargets: stringList(value?.rememberTargets),
		pairs: pairList(value?.pairs),
	};
}

/** True when the two sessions share an approved auto-relay pair. */
function pairBetween(view, a, b) {
	return view.pairs.some((pair) => (pair.a === a && pair.b === b) || (pair.a === b && pair.b === a));
}

/** Append one sender id to a policy list without ever duplicating it. */
function withSender(list, senderId) {
	return list.includes(senderId) ? list : [...list, senderId];
}

/**
 * Create the messaging policy store. Prefers the settings service (namespace
 * `team-link`, user-editable through the settings UI and persisted by
 * the settings provider); falls back to process-local memory when settings is
 * unavailable so the approval flow still works within one run.
 */
/** Current settings namespace for the messaging policy. */
const POLICY_NAMESPACE = "team-link";
/**
 * Pre-rename namespace (<= 0.2.4, when this plugin was dsh-session-link-pro).
 * Registered for the one-time data migration below; user trust data (pairs /
 * trustedSenders / blockedSenders / rememberTargets / receiveMode) must never
 * be orphaned by the rename.
 */
const LEGACY_POLICY_NAMESPACE = "session-link-pro";

function createPolicyStore(ctx) {
	const settings = ctx.get?.("settings");
	let scope = null;
	let legacyScope = null;
	if (settings !== undefined && typeof settings.register === "function") {
		try {
			scope = settings.register(POLICY_NAMESPACE, PolicyConfig, { base: structuredClone(DEFAULT_POLICY) });
			try {
				legacyScope = settings.register(LEGACY_POLICY_NAMESPACE, PolicyConfig, { base: structuredClone(DEFAULT_POLICY) });
			} catch {
				legacyScope = null; // legacy namespace is best-effort only
			}
		} catch (error) {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: settings namespace unavailable, approval memory falls back to memory: ${describeError(error)}`);
		}
	}
	const memory = structuredClone(DEFAULT_POLICY);
	return {
		get() {
			try {
				const value = scope !== null ? scope.get() : memory;
				return normalizePolicy(value);
			} catch {
				return normalizePolicy(memory);
			}
		},
		async update(patch) {
			if (scope !== null) {
				await scope.update(patch);
				return;
			}
			for (const [key, value] of Object.entries(patch)) memory[key] = structuredClone(value);
		},
		/**
		 * One-time rename migration: when the legacy namespace (this plugin's
		 * identity before 0.3.0) still carries data and the current namespace
		 * is at defaults, copy everything over and reset the legacy namespace
		 * to base so the migration never repeats. Both non-default → the user
		 * already diverged under the new name; current wins, legacy kept.
		 */
		async migrateLegacyPolicy() {
			if (legacyScope === null) return;
			let legacy;
			try {
				legacy = normalizePolicy(legacyScope.get());
			} catch {
				return;
			}
			const legacyHasData = legacy.pairs.length > 0 || legacy.trustedSenders.length > 0
				|| legacy.blockedSenders.length > 0 || legacy.rememberTargets.length > 0
				|| legacy.receiveMode !== DEFAULT_POLICY.receiveMode;
			if (!legacyHasData) return;
			const current = this.get();
			const currentIsDefault = current.pairs.length === 0 && current.trustedSenders.length === 0
				&& current.blockedSenders.length === 0 && current.rememberTargets.length === 0
				&& current.receiveMode === DEFAULT_POLICY.receiveMode;
			if (!currentIsDefault) {
				ctx.logger?.info?.(`${PLUGIN_LABEL}: legacy policy namespace "${LEGACY_POLICY_NAMESPACE}" still holds data; kept untouched (current namespace already in use)`);
				return;
			}
			try {
				await this.update({
					receiveMode: legacy.receiveMode,
					trustedSenders: [...legacy.trustedSenders],
					blockedSenders: [...legacy.blockedSenders],
					rememberTargets: [...legacy.rememberTargets],
					pairs: [...legacy.pairs],
				});
				await legacyScope.update(structuredClone(DEFAULT_POLICY));
				ctx.logger?.info?.(`${PLUGIN_LABEL}: migrated policy from legacy namespace "${LEGACY_POLICY_NAMESPACE}" (${legacy.pairs.length} pairs, ${legacy.trustedSenders.length} trusted senders)`);
			} catch (error) {
				ctx.logger?.warn?.(`${PLUGIN_LABEL}: legacy policy migration failed (legacy data left in place): ${describeError(error)}`);
			}
		},
	};
}

// ---------------------------------------------------------------------------
// export rendering
// ---------------------------------------------------------------------------

/**
 * Render one content block array as markdown. Known block types (text,
 * tool_use, tool-result) get dedicated shapes; anything else is fenced JSON so
 * the export stays complete without guessing at newer block types.
 */
function renderContentBlocks(content, limit = MD_BLOCK_LIMIT) {
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (block?.type === "text" && typeof block.text === "string") {
			parts.push(truncate(block.text, limit));
		} else if (block?.type === "tool_use") {
			parts.push(`**工具调用 \`${block.name}\`**（call \`${block.id}\`）\n\n\`\`\`json\n${truncate(safeJson(block.arguments), limit)}\n\`\`\``);
		} else if (block?.type === "tool-result" && Array.isArray(block.content)) {
			parts.push(truncate(renderContentBlocks(block.content, limit), limit));
		} else {
			parts.push(`\`\`\`json\n${truncate(safeJson(block), limit)}\n\`\`\``);
		}
	}
	return parts.join("\n\n") || "（空内容）";
}

/**
 * Render a complete session log as readable markdown. Turns become section
 * breaks; user and assistant messages become labeled blocks; tool results are
 * summarized with a hard truncation so a runaway log cannot produce an
 * unbounded document (the JSON export keeps full fidelity).
 */
function renderSessionMarkdown(session, events, title) {
	const lines = [];
	lines.push(`# 会话导出：${typeof title === "string" && title !== "" ? title : session.id}`, "");
	lines.push(`- 会话 ID：\`${session.id}\``);
	if (typeof title === "string" && title !== "") lines.push(`- 标题：${title}`);
	lines.push(`- 创建时间：${new Date(session.createdAt).toISOString()}`);
	if (typeof session.cwd === "string" && session.cwd !== "") lines.push(`- 工作目录：${session.cwd}`);
	if (typeof session.origin === "string" && session.origin !== "") lines.push(`- 来源：${session.origin}`);
	if (typeof session.parentSession === "string" && session.parentSession !== "") lines.push(`- 父会话：\`${session.parentSession}\``);
	lines.push(`- 事件数：${events.length}`);
	lines.push(`- 导出工具：${PLUGIN_LABEL}`);
	for (const event of events) {
		switch (event?.type) {
			case "turn/start": {
				lines.push("", "---", "", `### Turn ${event.data?.turn ?? "?"}`);
				break;
			}
			case "user/message": {
				const message = event.data;
				const note = message?.source?.kind === "user" ? "" : `（来源：${message?.source?.kind ?? "unknown"}）`;
				lines.push("", `**👤 用户${note}**`, "", renderContentBlocks(message?.content));
				break;
			}
			case "assistant/message": {
				const message = event.data?.message;
				lines.push("", "**🤖 助手**", "", renderContentBlocks(message?.content));
				break;
			}
			case "tool/result": {
				const message = event.data?.message;
				const callId = typeof message?.source?.callId === "string" ? message.source.callId : "";
				const mark = event.data?.error !== undefined ? "（错误）" : "";
				lines.push("", `**🔧 工具结果${mark}** \`${callId}\``, "", renderContentBlocks(message?.content, MD_TOOL_RESULT_LIMIT));
				break;
			}
			case "command/run": {
				const data = event.data ?? {};
				const command = typeof data.command === "string" ? data.command : preview(safeJson(data), 200);
				lines.push("", `> 💻 ${preview(command, 200)}`);
				break;
			}
			default:
				// Structural events (step/turn markers, todo writes, compaction,
				// approval trails, ...) stay out of the readable rendering; the
				// JSON export keeps every one of them.
				break;
		}
	}
	return wellFormed(`${lines.join("\n")}\n`);
}

/**
 * Serialized complete-fidelity JSON export document — the one place the file
 * writer and the download route both call. `JSON.stringify` is already
 * well-formed (ES2019 escapes an unpaired surrogate as a six-character `\uXXXX`
 * escape, never raw), so `wellFormed` is a no-op today; it stays as the explicit
 * statement of the contract this document is written under.
 */
function jsonExportText(session, events, title) {
	return wellFormed(JSON.stringify(buildJsonExport(session, events, title), null, 2));
}

/** Complete-fidelity JSON export document. */
function buildJsonExport(session, events, title) {
	return {
		exporter: PLUGIN_LABEL,
		exportedAt: new Date().toISOString(),
		session,
		title: typeof title === "string" ? title : null,
		eventCount: events.length,
		events,
	};
}

/** Latest log-backed title for one session, or undefined. Never throws. */
async function titleOf(ctx, sessionId) {
	try {
		const snapshots = await ctx.sessionQuery.readTitleSnapshots([sessionId]);
		const first = Array.isArray(snapshots) ? snapshots[0] : undefined;
		if (first?.status === "fulfilled" && typeof first.value?.title === "string") return first.value.title;
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Export one session to `.dsh-exports/<id>-<timestamp>.{md,json}` inside the
 * session's own workspace (or an explicit outputDir).
 * @returns the header, events, folded title, and the absolute paths written.
 */
async function exportSession(ctx, sessionId, { format = "both", outputDir } = {}) {
	const { session, events } = await ctx.sessionQuery.readSession(sessionId);
	const title = await titleOf(ctx, sessionId);
	const dir = typeof outputDir === "string" && outputDir !== "" ? outputDir : path.join(typeof session.cwd === "string" && session.cwd !== "" ? session.cwd : process.cwd(), EXPORT_DIR);
	await mkdir(dir, { recursive: true });
	const stamp = timestamp();
	const files = [];
	if (format === "both" || format === "json") {
		const file = path.join(dir, `${sessionId}-${stamp}.json`);
		await writeFile(file, `${jsonExportText(session, events, title)}\n`, "utf8");
		files.push(file);
	}
	if (format === "both" || format === "md") {
		const file = path.join(dir, `${sessionId}-${stamp}.md`);
		await writeFile(file, renderSessionMarkdown(session, events, title), "utf8");
		files.push(file);
	}
	return { session, events, title, files };
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

/** Register the three model-facing tools on the tools service. */
function registerTools(ctx, policy) {
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_list_sessions",
		description: "列出当前工作区（同目录）的其他 DSH 会话：id、标题/主题摘要、运行状态、创建时间、最近动态；供跨会话导出或发送前查目标。",
		parameters: {
			includeOtherProjects: { type: "boolean", description: "同时列出其他项目目录的会话（默认仅当前工作区目录）" },
		},
		output: textOutput(),
		timeoutMs: 60000,
		async execute(args, exec) {
			try {
				const selfId = agentSessionId(exec);
				const cwd = agentCwd(exec);
				const records = await ctx.sessionQuery.listSessions(undefined);
				const sameProject = records.filter((record) => record.header.cwd === cwd);
				const pool = (args.includeOtherProjects === true ? records : sameProject).filter((record) => record.header.id !== selfId);
				const shown = pool.slice(0, LIST_LIMIT);
				const ids = shown.map((record) => record.header.id);
				const titles = new Map();
				if (ids.length > 0) {
					try {
						const snapshots = await ctx.sessionQuery.readTitleSnapshots(ids);
						for (let index = 0; index < snapshots.length; index += 1) {
							const snapshot = snapshots[index];
							if (snapshot?.status === "fulfilled" && typeof snapshot.value?.title === "string") titles.set(ids[index], snapshot.value.title);
						}
					} catch {
						/* titles are best-effort decoration */
					}
				}
				// Session digests: fold each current surface (much smaller than the
				// full log) into a topic + last-activity preview so the list answers
				// "what is each session doing", not just "that it exists".
				const topics = new Map();
				const activities = new Map();
				for (const record of shown.slice(0, PREVIEW_SESSIONS)) {
					try {
						const surface = await ctx.sessionQuery.readSurface(record.header.id);
						const topic = firstSurfaceUserText(surface.events);
						if (topic !== undefined) topics.set(record.header.id, topic);
						const activity = lastSurfaceText(surface.events);
						if (activity !== undefined) activities.set(record.header.id, activity);
					} catch {
						/* digest is best-effort; cold or unreadable logs still list */
					}
				}
				const lines = [];
				lines.push(`当前工作区：${cwd}${selfId !== undefined ? `（当前会话：${selfId}）` : ""}`);
				lines.push(`共 ${pool.length} 个其他会话${pool.length > shown.length ? `，按新到旧显示前 ${shown.length} 个` : ""}：`);
				lines.push("");
				if (shown.length === 0) lines.push("（无）");
				for (const record of shown) {
					const header = record.header;
					const agent = ctx.agents.get(header.id);
					const running = agent?.status === "running";
					const state = running ? "▶ 运行中" : agent !== undefined ? "○ 空闲" : "✕ 未运行";
					const origin = header.origin === "subagent" ? " [子代理]" : "";
					const title = titles.get(header.id);
					const other = args.includeOtherProjects === true && header.cwd !== cwd ? ` · ${header.cwd}` : "";
					lines.push(`- ${header.id}${origin} — ${state}${title !== undefined ? `「${title}」` : ""} · 创建于 ${new Date(header.createdAt).toLocaleString()}${other}`);
					const topic = topics.get(header.id);
					if (topic !== undefined) lines.push(`    主题：${preview(topic, 90)}`);
					const activity = activities.get(header.id);
					if (activity !== undefined && activity !== topic) lines.push(`    最近：${preview(activity, 90)}`);
				}
				lines.push("");
				lines.push("提示：team_link_export 可导出任意会话（md+JSON）；team_link_send 可发送跨会话消息（需用户批准；接收确认时可选「配对」建立双向免确认通道；目标运行中→注入当前回合，空闲→唤醒为新回合）。");
				// This text goes straight into the caller's history, so it leaves
				// well-formed: preview() no longer CREATES a lone surrogate, and this
				// pass also repairs one that arrived inside an id, a title, a cwd or a
				// logged topic.
				return wellFormed(lines.join("\n"));
			} catch (error) {
				return wellFormed(`列出会话失败：${describeError(error)}`);
			}
		},
	})), "team-link: list tool");

	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_export",
		description: "导出会话完整记录：markdown + JSON 双格式写入会话工作区 .dsh-exports/ 目录（JSON 含全量事件日志，md 为可读渲染）。",
		parameters: {
			sessionId: { type: "string", description: "要导出的会话 id；缺省为当前会话" },
			format: { type: "string", description: "导出格式：md / json / both（缺省 both）" },
			outputDir: { type: "string", description: "输出目录（缺省会话工作区的 .dsh-exports/）" },
		},
		output: textOutput(),
		timeoutMs: 60000,
		async execute(args, exec) {
			const sessionId = typeof args.sessionId === "string" && args.sessionId !== "" ? args.sessionId : agentSessionId(exec);
			if (sessionId === undefined) return "导出失败：未指定 sessionId，且当前上下文无法确定会话 id。";
			const format = ["md", "json", "both"].includes(args.format) ? args.format : "both";
			try {
				const result = await exportSession(ctx, sessionId, { format, outputDir: args.outputDir });
				return wellFormed(`已导出会话 ${sessionLabel(sessionId, result.title)}（${result.events.length} 个事件）：\n${result.files.map((file) => `- ${file}`).join("\n")}`);
			} catch (error) {
				return wellFormed(`导出失败：${describeError(error)}`);
			}
		},
	})), "team-link: export tool");

	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_send",
		description: "向另一会话发送跨会话消息（多会话联调用）。发送前需当前用户批准；目标会话运行中→注入当前回合，空闲→唤醒目标并作为新回合处理。已配对的两个会话互发免确认（接收确认时选择「配对：双向免确认」即可建立）。",
		parameters: {
			targetSessionId: { type: "string", required: true, description: "目标会话 id（可用 team_link_list_sessions 查询）" },
			message: { type: "string", required: true, description: "要投递的消息文本" },
		},
		output: textOutput(),
		async execute(args, exec) {
			const targetId = args.targetSessionId;
			const text = args.message;
			const sender = exec?.agent;
			if (sender === undefined || ctx.agents.get(sender.id) !== sender) {
				return "发送失败：跨会话发送需要用户批准，但当前执行上下文没有可交互的活动代理。";
			}
			if (targetId === sender.id) return "发送失败：目标会话不能是当前会话。";
			const target = ctx.agents.get(targetId);
			// `targetId` is a model-supplied tool argument echoed straight back into the
			// caller's history — the "tool argument echo" carrier — so the refusal is
			// repaired here and does not rely on the output.render gate alone.
			if (target === undefined) return wellFormed(`发送失败：目标会话 ${targetId} 没有活动代理（未在本壳中打开或已退出）。仅支持投递到存活会话。`);
			if (target?.session?.header?.origin === "subagent") return "发送失败：目标会话是子代理会话，不支持接收跨会话消息。";
			if (typeof ctx.agents.roots === "function" && !ctx.agents.roots().includes(target)) {
				return "发送失败：目标代理不是根代理（可能是子代理），不支持接收跨会话消息。";
			}
			// ---- block check + pairing fast path ----------------------------------
			const initialView = policy.get();
			if (initialView.blockedSenders.includes(sender.id)) {
				// An explicit block always wins, even over an established pair.
				if (pairBetween(initialView, sender.id, targetId)) {
					try {
						await policy.update({ pairs: initialView.pairs.filter((pair) => !((pair.a === sender.id && pair.b === targetId) || (pair.a === targetId && pair.b === sender.id))) });
						} catch {
							/* best-effort pair cleanup once the sender is blocked */
						}
				}
				return "未投递：目标会话已屏蔽来自当前会话的消息。";
			}
			const paired = pairBetween(initialView, sender.id, targetId);
			const userQuestions = paired ? undefined : ctx.get?.("userQuestions");
			// Deliberately fail-closed: without the confirmation service an unpaired send
			// refuses, even in a configuration whose gates would not have asked (sender
			// already remembered AND the receiver trusting/accepting). Relaxing this to
			// "ask only if a gate would prompt" is a policy decision, not a bug fix.
			if (!paired && (userQuestions === undefined || typeof userQuestions.ask !== "function")) {
				return "发送失败：跨会话发送需要用户批准，但确认服务（userQuestions）不可用。";
			}
			
			// ---- gate 1: sender-side approval -------------------------------------
			if (!paired && !policy.get().rememberTargets.includes(targetId)) {
				let choice;
				try {
					const answer = await userQuestions.ask({
						questions: [{
							id: "send-confirm",
							header: "跨会话发送确认",
							// The payload is the caller's own text, echoed back into a dialog;
							// preview() cannot create a lone surrogate but cannot repair one it
							// was handed either, so the question leaves well-formed.
							question: wellFormed(`发送消息到会话 ${sessionLabel(targetId, undefined)}？\n\n${preview(text, 300)}`),
							options: [
								{ label: "发送", description: "本次发送；下次发送到该会话仍会确认" },
								{ label: "记住该目标并发送", description: "今后发送到该会话不再逐次确认" },
								{ label: "取消", description: "不发送" },
							],
						}],
						agent: sender,
						signal: exec.signal,
					});
					choice = answer?.answers?.[0]?.selected?.[0];
				} catch (error) {
					return wellFormed(`发送失败：发送确认未完成（${describeError(error)}）。`);
				}
				if (choice === "取消") return "已取消：用户拒绝了本次发送。";
				if (choice !== "发送" && choice !== "记住该目标并发送") return "发送失败：发送确认未得到明确同意。";
				if (choice === "记住该目标并发送") {
					try {
						await policy.update({ rememberTargets: withSender(policy.get().rememberTargets, targetId) });
					} catch {
						/* remembering is best-effort; the send itself proceeds */
					}
				}
			}

			const [senderTitle, targetTitle] = await Promise.all([titleOf(ctx, sender.id), titleOf(ctx, targetId)]);

			// ---- gate 2: receiver-side inbound policy -----------------------------
			if (!paired && !policy.get().trustedSenders.includes(sender.id)) {
				const view = policy.get();
				if (view.receiveMode === "reject") return "未投递：目标会话的接收策略为全部拒绝（可在设置 team-link 中调整）。";
				if (view.receiveMode === "ask") {
					let timedOut = false;
					const controller = new AbortController();
					const timer = setTimeout(() => {
						timedOut = true;
						controller.abort();
					}, RECEIVE_CONFIRM_TIMEOUT_MS);
					const forwardAbort = () => controller.abort();
					exec.signal?.addEventListener?.("abort", forwardAbort);
					let choice;
					try {
						const answer = await userQuestions.ask({
							questions: [{
								id: "receive-confirm",
								header: "收到跨会话消息请求",
								question: wellFormed(`会话 ${sessionLabel(sender.id, senderTitle)} 请求向你发送消息：\n\n${preview(text, 300)}`),
								options: [
									{ label: "接收", description: "接收这一次" },
									{ label: "总是接收该会话", description: "记住该发送方，今后免确认" },
									{ label: "配对：双向免确认", description: "建立配对通道：这两个会话今后互发免确认（本次亦接收）" },
									{ label: "拒绝并屏蔽该会话", description: "拒绝本次，并屏蔽该发送方" },
								],
							}],
							agent: target,
							signal: controller.signal,
						});
						choice = answer?.answers?.[0]?.selected?.[0];
					} catch (error) {
						return timedOut
							? "未投递：目标会话用户未在 3 分钟内确认接收。"
							: wellFormed(`未投递：目标会话用户未能确认（${describeError(error)}）。`);
					} finally {
						clearTimeout(timer);
						exec.signal?.removeEventListener?.("abort", forwardAbort);
					}
					if (choice === "拒绝并屏蔽该会话") {
						try {
							await policy.update({ blockedSenders: withSender(policy.get().blockedSenders, sender.id) });
						} catch {
							/* best-effort persistence of the block decision */
						}
						return "未投递：目标会话用户拒绝并屏蔽了来自当前会话的消息。";
					}
					if (choice === "配对：双向免确认") {
						try {
							const current = policy.get();
							if (!pairBetween(current, sender.id, targetId)) {
								await policy.update({ pairs: [...current.pairs, { a: sender.id, b: targetId, createdAt: Date.now() }] });
							}
						} catch {
							/* best-effort pairing; this send still proceeds */
						}
					} else if (choice === "总是接收该会话") {
						try {
							await policy.update({ trustedSenders: withSender(policy.get().trustedSenders, sender.id) });
						} catch {
							/* best-effort persistence of the trust decision */
						}
					} else if (choice !== "接收") {
						return "未投递：目标会话用户未确认接收。";
					}
				}
				// receiveMode === "accept" → deliver without asking
			}

			// ---- deliver -----------------------------------------------------------
			// The banner is written into the TARGET session's log, where a lone
			// surrogate would kill that session's next request — so the payload is
			// made well-formed here, at the door, not merely where it is displayed.
			const banner = wellFormed([
				`📨 [跨会话消息 · 来自会话 ${sessionLabel(sender.id, senderTitle)} · ${localStamp()}]`,
				"",
				text,
				"",
				"（如需回复，可让本会话调用 team_link_send 工具发回）",
			].join("\n"));
			// The source is the audited cross-session relay shape the DSH 0.1.5
			// session-format migration admits — exactly `{kind, form, senderSessionId}`.
			// An unknown kind (or any extra member) refuses the WHOLE session log at
			// migration time, so the sender, the plugin name and the delivery time live
			// in the banner text instead of the source.
			const message = {
				id: `slp-${randomUUID()}`,
				role: "user",
				source: { kind: "agent-message", form: "relay", senderSessionId: sender.id },
				content: [{ type: "text", text: banner }],
			};
			const running = target.status === "running";
			if (running) target.steer(message);
			else target.followup(message);
			const channelNote = paired ? "（已配对通道，免确认自动投递）" : "";
			return wellFormed(`已投递到 ${sessionLabel(targetId, targetTitle)}${channelNote}：${running ? "目标正在运行，消息将在步边界注入当前回合" : "目标空闲，已唤醒目标会话并作为新回合处理（消息与回复稍后出现在目标会话中）"}。`);
		},
	})), "team-link: send tool");
}

// ---------------------------------------------------------------------------
// web export route (consumed by the conversation-header export button)
// ---------------------------------------------------------------------------

/** Serve `GET /team-link/export?session=<id>&format=md|json` downloads. */
function registerExportRoute(ctx) {
	const webServer = ctx.get?.("webServer");
	if (webServer === undefined || typeof webServer.register !== "function") {
		ctx.logger?.warn?.(`${PLUGIN_LABEL}: webServer service unavailable — header export button disabled, the export tool keeps working.`);
		return;
	}
	ctx.effect(() => webServer.register({
		kind: "exact",
		path: "/team-link/export",
		handler: async (req, res) => {
			try {
				const url = new URL(req.url ?? "/", "http://localhost");
				const sessionId = url.searchParams.get("session") ?? "";
				const format = url.searchParams.get("format") === "json" ? "json" : "md";
				if (sessionId === "") {
					res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
					res.end("missing ?session=<sessionId>");
					return;
				}
				const { session, events } = await ctx.sessionQuery.readSession(sessionId);
				const title = await titleOf(ctx, sessionId);
				// The id reaches a response header, so keep it to a filename-safe shape.
				const downloadName = sessionId.replace(/[^\w.-]/gu, "_");
				if (format === "json") {
					const body = jsonExportText(session, events, title);
					res.writeHead(200, {
						"content-type": "application/json; charset=utf-8",
						"content-disposition": `attachment; filename="${downloadName}.json"`,
					});
					res.end(body);
					return;
				}
				const body = renderSessionMarkdown(session, events, title);
				res.writeHead(200, {
					"content-type": "text/markdown; charset=utf-8",
					"content-disposition": `attachment; filename="${downloadName}.md"`,
				});
				res.end(body);
			} catch (error) {
				res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
				res.end(wellFormed(`export failed: ${describeError(error)}`));
			}
		},
	}), "team-link: export route");
}

// ---------------------------------------------------------------------------
// plugin entry
// ---------------------------------------------------------------------------

/**
 * Host plugin body: deep-link resolution (upstream), the three -pro tools, and
 * the web export route.
 * @param ctx - plugin context carrying the injected services.
 */
function apply(ctx) {
	const policy = createPolicyStore(ctx);
	void policy.migrateLegacyPolicy().catch(() => { /* logged inside */ });
	registerDeepLinks(ctx);
	registerTools(ctx, policy);
	registerExportRoute(ctx);
}

export { apply, inject, name };
