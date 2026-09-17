// dsh-team-link — node half (host plugin).
//
// Upstream dsh-session-link behavior, kept in full: direct user prompts
// carrying a session deep link (the canonical `dsh-session:<base64url>` URI,
// this deployment's `dsh://session/<sessionId>` deep link, or the legacy web
// deep link `http(s)://<host>/s/<sessionId>`) are resolved through the shipped
// session-reference service and the bounded snapshot is injected as read-only
// model context immediately before the direct prompt.
//
// New in -pro (and in the 0.3.x team upgrade):
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
//  4. team_link_watch — the M1 cross-session watchdog (register / list / clear).
//  5. team_link_roster / team_link_team_read / team_link_team_append — the M2 team
//     identity registry (roles, version history, writer policy) and the team
//     blackboard under <workspace>/team/<name>/ (mirror + decisions + discipline).
import { encodeSessionReferenceUri, parseSessionReferenceText } from "@deepseek-ai/dsh-session-reference";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "schemastery";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
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
/** Liveness thresholds in minutes (§3.1): idle silence past `LV_SILENT_MIN` is
 * the P1 symptom ("双端都在等"), and a running turn past `LV_RUN_MIN` is
 * reported as long-running rather than healthy. */
const LV_SILENT_MIN = 10;
const LV_RUN_MIN = 30;
/** A liveness reading is a snapshot of a moving system, so every row says when it
 * was taken and when it stops being trustworthy (§3.1 防偏离 regulations). */
const READ_STALE_NOTE = ">2min 作废";
/** Verdicts the cross-session watchdog acts on (§3.2.3): a silent idle target, a
 * root-cause goal-disarmed target, and a target whose agent is gone. */
const TICKABLE_VERDICTS = new Set(["silent-idle", "goal-disarmed", "dead"]);
/** Watchdog limits (§3.2.4, anti-runaway): at most this many registrations per
 * watcher session, and these floors/ceilings on the thresholds a caller may set. */
const WATCHDOG_MAX_PER_SESSION = 3;
const WATCHDOG_MIN_SILENT_MINUTES = 10;
const WATCHDOG_DEFAULT_SILENT_MINUTES = 10;
const WATCHDOG_MIN_INTERVAL_MINUTES = 5;
const WATCHDOG_DEFAULT_INTERVAL_MINUTES = 5;
const WATCHDOG_MAX_TTL_HOURS = 24;
const WATCHDOG_DEFAULT_TTL_HOURS = 12;
/** Registration id prefix; distinct from `slp-` so the two kinds never collide. */
const WATCHDOG_ID_PREFIX = "wd-";
/** Tick message id prefix (§3.2.3). The client card reads the `slp-` stem. */
const WATCHDOG_TICK_ID_PREFIX = "slp-wd-";
/**
 * Live watchdog controller of each plugin context. `apply` is the only writer;
 * `host-half.test.mjs` reads it (through {@link __testing}) so it can drive the
 * real `patrol` implementation with an injected clock instead of waiting.
 */
const WATCHDOG_BY_CTX = new WeakMap();

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
// liveness signal and verdict (§3.1)
// ---------------------------------------------------------------------------

/**
 * Goal signal for one session — the strongest liveness fact available. The
 * `goals` service is resolved at runtime with `ctx.get("goals")` (§3.1
 * implementation note: the goal-round driver injects it, so it is a plain
 * service call and needs no log parsing), and its absence is a supported
 * degradation: the whole plugin keeps working with `goal: null` shown as `?`
 * instead of failing to start (red line §5.3).
 *
 * @returns `null` when the service is unavailable (degraded), otherwise the
 *   normalized goal signal — phase `"none"` when the session has no current
 *   goal, or when no live agent exists to ask about (the agent face already
 *   reports `dead` for that case).
 */
function readGoalSignal(ctx, sessionId, agent) {
	const goals = ctx.get?.("goals");
	if (goals === undefined || goals === null || typeof goals.get !== "function") return null;
	const none = { phase: "none", activation: "?", rounds: "-", blockedReason: null };
	if (agent === undefined) return none;
	try {
		const view = goals.get(agent);
		if (view === undefined || view === null) return none;
		const rounds = `${Number.isFinite(view.roundsStarted) ? view.roundsStarted : "?"}/${Number.isFinite(view.maxGoalRounds) ? view.maxGoalRounds : "?"}`;
		const reason = view.blockedReason === undefined || view.blockedReason === null
			? null
			: `${view.blockedReason.code}: ${view.blockedReason.message}`;
		return {
			phase: typeof view.phase === "string" && view.phase !== "" ? view.phase : "none",
			activation: view.activation === "armed" || view.activation === "disarmed" ? view.activation : "?",
			rounds,
			blockedReason: typeof reason === "string" ? wellFormed(reason) : null,
		};
	} catch {
		// A goal read that throws (not live, projection failure) is not a reason to
		// lose the session's other signals — the goal face degrades to "unknown".
		return none;
	}
}

/**
 * The §3.1 verdict: five states, and the four-state tick policy of §3.7 in one
 * place.
 *
 * - `dead` — no live agent (A4: nothing can wake it, the signal face says so);
 * - `long-running` — a live turn that has been running longer than `runMin`;
 * - `goal-disarmed` — idle with an active-but-disarmed goal: the root-cause
 *   silent state (V5, activation is deliberately not persisted), which must be
 *   reported immediately instead of waiting for the silence threshold;
 * - `silent-idle` — idle, no goal, and no activity for longer than `silentMin`
 *   (the P1 scenario);
 * - `ok` — everything else, including paused/blocked/complete goals: those are
 *   silence somebody already explained (waiting on a human), so they are shown,
 *   never alarmed on.
 *
 * @param signal - a {@link buildLivenessSignal} result.
 * @param cfg - `now` plus the two minute thresholds (defaults §3.1).
 */
function verdictOf(signal, cfg = {}) {
	const now = typeof cfg.now === "number" ? cfg.now : Date.now();
	const silentMin = typeof cfg.silentMin === "number" ? cfg.silentMin : LV_SILENT_MIN;
	const runMin = typeof cfg.runMin === "number" ? cfg.runMin : LV_RUN_MIN;
	if (signal.agent === "not-live") return "dead";
	if (signal.agent === "running") {
		if (typeof signal.turnStartedAt === "number" && now - signal.turnStartedAt > runMin * 60000) return "long-running";
		return "ok";
	}
	const goal = signal.goal;
	if (goal !== null && goal !== undefined) {
		if (goal.phase === "active" && goal.activation === "armed") return "ok";
		if (goal.phase === "active" && goal.activation === "disarmed") return "goal-disarmed";
		if (goal.phase === "paused" || goal.phase === "blocked" || goal.phase === "complete") return "ok";
	}
	if (signal.silenceMs > silentMin * 60000) return "silent-idle";
	return "ok";
}

/**
 * Read one session's liveness signal (§3.1). Never throws and never costs more
 * than the surface the caller already read: the agent comes from the registry,
 * the timestamps from the session surface, the goal from the optional service.
 *
 * `silenceMs` is 0 when neither timestamp is readable (no evidence of silence
 * is not evidence of liveness, but an unknown reading must not fire alarms), and
 * the renderer shows that case as `?`.
 */
function buildLivenessSignal(ctx, sessionId, options = {}) {
	const now = typeof options.now === "number" ? options.now : Date.now();
	const agent = options.agent !== undefined ? options.agent : ctx.agents.get(sessionId);
	const agentState = agent === undefined ? "not-live" : agent.status === "running" ? "running" : "idle";
	let lastAssistantAt = null;
	let lastInboundAt = null;
	let turnStartedAt = null;
	const events = Array.isArray(options.surface?.events) ? options.surface.events : [];
	for (const event of events) {
		const time = typeof event?.time === "number" ? event.time : undefined;
		if (time === undefined) continue;
		if (event.type === "assistant/message") lastAssistantAt = time;
		else if (event.type === "user/message") lastInboundAt = time;
		else if (event.type === "turn/start") turnStartedAt = time;
	}
	const lastActivity = Math.max(lastAssistantAt ?? Number.NEGATIVE_INFINITY, lastInboundAt ?? Number.NEGATIVE_INFINITY);
	const signal = {
		agent: agentState,
		lastAssistantAt,
		lastInboundAt,
		turnStartedAt,
		goal: readGoalSignal(ctx, sessionId, agent),
		silenceMs: Number.isFinite(lastActivity) ? Math.max(0, now - lastActivity) : 0,
		verdict: "ok",
	};
	signal.verdict = verdictOf(signal, { now, silentMin: options.silentMin, runMin: options.runMin });
	return signal;
}

/** Reading stamp for the liveness face and the watchdog tick body. */
function readStamp(now) {
	return localStamp(new Date(now));
}

/** A silence duration in minutes, one decimal — display and tick-body unit. */
function fmtSilence(ms) {
	return `${(ms / 60000).toFixed(1)}min`;
}

/** The target's last observed activity watermark (§3.1 timestamps), or `null`
 * when neither side is readable — the watchdog's "same silence period" key. */
function lastActivityOf(signal) {
	if (signal.lastAssistantAt === null && signal.lastInboundAt === null) return null;
	return Math.max(signal.lastAssistantAt ?? Number.NEGATIVE_INFINITY, signal.lastInboundAt ?? Number.NEGATIVE_INFINITY);
}

/** One-line goal summary for the signal face; `?` means the goal service is absent. */
function goalSummary(goal) {
	if (goal === null || goal === undefined) return "?";
	if (goal.phase === "none") return "none";
	const blocked = goal.blockedReason === null ? "" : ` blocked=${goal.blockedReason}`;
	return `${goal.phase}/${goal.activation}(${goal.rounds})${blocked}`;
}

/** The per-row liveness signal line of `team_link_list_sessions`. */
function livenessLine(signal) {
	const agent = signal.agent === "running" ? "运行中" : signal.agent === "idle" ? "空闲" : "未运行";
	const silence = signal.lastAssistantAt === null && signal.lastInboundAt === null
		? "静默 ?"
		: `静默 ${fmtSilence(signal.silenceMs)}`;
	const parts = [`verdict=${signal.verdict}`, `代理=${agent}`, `goal=${goalSummary(signal.goal)}`, silence];
	if (signal.agent === "running" && signal.turnStartedAt !== null) parts.push(`回合始于 ${readStamp(signal.turnStartedAt)}`);
	if (signal.lastAssistantAt !== null) parts.push(`末条助手 ${readStamp(signal.lastAssistantAt)}`);
	if (signal.lastInboundAt !== null) parts.push(`末条入站 ${readStamp(signal.lastInboundAt)}`);
	return parts.join(" · ");
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
	watchdogs: [],
	teams: [],
};

const POLICY_MODES = new Set(["ask", "accept", "reject"]);

/**
 * One registered watchdog (§3.2.2). `team` is the M2 roster hook; v1 allows an
 * empty value (pure sessionId list mode). Every field carries a fallback so a
 * hand-edited settings file degrades to "drop that entry" rather than making the
 * whole policy namespace unreadable — a namespace that fails to resolve would
 * fall back to memory and orphan the user's pairs.
 */
const WatchdogConfig = z.object({
	id: z.string().default(""),
	team: z.string().default(""),
	watcherSession: z.string().default(""),
	targets: z.array(z.string()).default([]),
	silentMinutes: z.number().default(WATCHDOG_DEFAULT_SILENT_MINUTES),
	intervalMinutes: z.number().default(WATCHDOG_DEFAULT_INTERVAL_MINUTES),
	expiresAt: z.number().default(0),
	createdAt: z.number().default(0),
});

/**
 * One role of one team (§3.3.1). `current` is an empty string in the stored
 * shape when the role is vacant; the normalized view renders that as `null`.
 * `pending` is the M4 rotation slot (§3.6) — M2 never writes one, but carries a
 * row written by a later milestone through untouched (`z.any()`).
 */
const TeamRoleConfig = z.object({
	role: z.string().default(""),
	current: z.string().default(""),
	pending: z.any().default(null),
	history: z.array(z.object({
		session: z.string().default(""),
		from: z.number().default(0),
		until: z.any().default(null),
		note: z.string().default(""),
	})).default([]),
});

/**
 * One team of the roster (§3.3.1). `workspace` is captured from the creating
 * session's `agentCwd` at the first session-side upsert and is the root of both
 * the roster mirror and the blackboard directory. Every field carries a
 * fallback, for the same reason the watchdog entries do: a hand-edited settings
 * row must degrade to "drop that team", never to an unreadable namespace.
 */
const TeamConfig = z.object({
	name: z.string().default(""),
	createdAt: z.number().default(0),
	workspace: z.string().default(""),
	policy: z.object({ writer: z.string().default("coordinator") }).default({ writer: "coordinator" }),
	roles: z.array(TeamRoleConfig).default([]),
});

const PolicyConfig = z.object({
	receiveMode: z.string().default("ask"),
	trustedSenders: z.array(z.string()).default([]),
	blockedSenders: z.array(z.string()).default([]),
	rememberTargets: z.array(z.string()).default([]),
	pairs: z.array(z.object({ a: z.string(), b: z.string(), createdAt: z.number().default(0) })).default([]),
	watchdogs: z.array(WatchdogConfig).default([]),
	teams: z.array(TeamConfig).default([]),
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
		watchdogs: watchdogList(value?.watchdogs),
		teams: normalizeTeams(value?.teams),
	};
}

/**
 * Normalized watchdog registrations: entries without an id or a watcher are
 * dropped (they can never be patrolled or cleared), and every other field is
 * coerced into its declared type. `team` is kept as `null` in this view when it
 * is empty — the M2 roster hook §3.2.2 allows `null` in v1.
 */
function watchdogList(list) {
	if (!Array.isArray(list)) return [];
	const number = (item, fallback) => typeof item === "number" && Number.isFinite(item) ? item : fallback;
	const entries = [];
	for (const entry of list) {
		if (entry === null || typeof entry !== "object") continue;
		if (typeof entry.id !== "string" || entry.id === "") continue;
		if (typeof entry.watcherSession !== "string" || entry.watcherSession === "") continue;
		entries.push({
			id: entry.id,
			team: typeof entry.team === "string" && entry.team !== "" ? entry.team : null,
			watcherSession: entry.watcherSession,
			targets: [...new Set((Array.isArray(entry.targets) ? entry.targets : []).filter((target) => typeof target === "string" && target !== ""))],
			silentMinutes: number(entry.silentMinutes, WATCHDOG_DEFAULT_SILENT_MINUTES),
			intervalMinutes: number(entry.intervalMinutes, WATCHDOG_DEFAULT_INTERVAL_MINUTES),
			expiresAt: number(entry.expiresAt, 0),
			createdAt: number(entry.createdAt, 0),
		});
	}
	return entries;
}

/**
 * Normalized M4 rotation slot (§3.6.2), or `null`. M2 has no rotation flow —
 * this only makes sure a `pending` written by a later milestone survives a
 * read/write cycle of the settings namespace instead of being silently dropped
 * (the namespace is shared, so a lossy normalizer would be a migration bug).
 */
function normalizePending(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const session = typeof value.session === "string" ? value.session : "";
	const token = typeof value.token === "string" ? value.token : "";
	if (session === "" || token === "") return null;
	const pending = {
		session,
		token,
		team: typeof value.team === "string" ? value.team : "",
		role: typeof value.role === "string" ? value.role : "",
		expiresAt: typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) ? value.expiresAt : 0,
	};
	if (Array.isArray(value.migratedPairs)) pending.migratedPairs = value.migratedPairs;
	return pending;
}

/**
 * One role's version history (§3.3.1), normalized: a record is
 * `{session, from, until|null, note?}` and `until: null` marks the tenure the
 * current holder is still serving. Records without a session are dropped — they
 * could never be attributed or closed.
 */
function normalizeHistory(list) {
	if (!Array.isArray(list)) return [];
	const entries = [];
	for (const entry of list) {
		if (entry === null || typeof entry !== "object") continue;
		const session = typeof entry.session === "string" ? entry.session : "";
		if (session === "") continue;
		const record = {
			session,
			from: typeof entry.from === "number" && Number.isFinite(entry.from) ? entry.from : 0,
			until: typeof entry.until === "number" && Number.isFinite(entry.until) ? entry.until : null,
		};
		if (typeof entry.note === "string" && entry.note !== "") record.note = entry.note;
		entries.push(record);
	}
	return entries;
}

/** The roles of one team, normalized: nameless or duplicate roles are dropped,
 * an empty `current` becomes a vacant `null`. */
function normalizeRoles(list) {
	if (!Array.isArray(list)) return [];
	const roles = [];
	const seen = new Set();
	for (const entry of list) {
		if (entry === null || typeof entry !== "object") continue;
		const role = typeof entry.role === "string" ? entry.role.trim() : "";
		if (role === "" || seen.has(role)) continue;
		seen.add(role);
		roles.push({
			role,
			current: typeof entry.current === "string" && entry.current !== "" ? entry.current : null,
			pending: normalizePending(entry.pending),
			history: normalizeHistory(entry.history),
		});
	}
	return roles;
}

/**
 * The roster (§3.3.1) as this plugin reads it: teams with a legal `[a-z0-9-]+`
 * name, deduplicated, every nested field coerced. A team whose name is illegal
 * is dropped rather than kept — the name is a path segment of the blackboard, so
 * an illegal one must never reach `path.join` through a settings row.
 */
function normalizeTeams(list) {
	if (!Array.isArray(list)) return [];
	const teams = [];
	const seen = new Set();
	for (const entry of list) {
		if (entry === null || typeof entry !== "object") continue;
		const name = typeof entry.name === "string" ? entry.name : "";
		if (!TEAM_NAME_RE.test(name) || seen.has(name)) continue;
		seen.add(name);
		teams.push({
			name,
			createdAt: typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt) ? entry.createdAt : 0,
			workspace: typeof entry.workspace === "string" ? entry.workspace : "",
			policy: { writer: entry.policy?.writer === "any" ? "any" : "coordinator" },
			roles: normalizeRoles(entry.roles),
		});
	}
	return teams;
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
// cross-session watchdog (§3.2)
// ---------------------------------------------------------------------------

/** Inclusive bounded-number reading for one registration argument. */
function readBoundedNumber(value, name, min, max, options = {}) {
	if (value === undefined || value === null) return { value: undefined };
	if (typeof value !== "number" || !Number.isFinite(value)) return { error: `${name} 必须是数字。` };
	if (options.integer === true && !Number.isInteger(value)) return { error: `${name} 必须是整数。` };
	if (value < min) return { error: `${name} 不能小于 ${min}。` };
	if (max !== undefined && value > max) return { error: `${name} 不能大于 ${max}。` };
	return { value };
}

/** TTL reading (§3.2.4: `<= 24h`, default 12h; strictly positive). */
function readTtlHours(value) {
	if (value === undefined || value === null) return { value: WATCHDOG_DEFAULT_TTL_HOURS };
	if (typeof value !== "number" || !Number.isFinite(value)) return { error: "ttlHours 必须是数字。" };
	if (value <= 0) return { error: "ttlHours 必须大于 0。" };
	if (value > WATCHDOG_MAX_TTL_HOURS) return { error: `ttlHours 不能大于 ${WATCHDOG_MAX_TTL_HOURS}（防失控）。` };
	return { value };
}

/**
 * Build one validated registration (§3.2.2 schema, §3.2.4 anti-runaway rules).
 * Pure — it neither reads nor writes the store — so every bound is directly
 * testable and a rejected request can never leave a half-written entry behind.
 *
 * @returns `{ value: entry }` or `{ error: reason }`.
 */
function buildWatchdogRegistration(request) {
	const caller = request.caller;
	const now = request.now;
	const targets = [...new Set((Array.isArray(request.targets) ? request.targets : [])
		.filter((target) => typeof target === "string" && target.trim() !== "")
		.map((target) => target.trim()))];
	if (targets.length === 0) return { error: "register 需要 targets（至少一个被盯会话 id）。" };
	if (targets.includes(caller)) return { error: "register 拒绝自指注册：targets 不能包含观察者自身会话（自指 = 变相的自 tick 定时器，§3.2.4）。" };
	const silent = readBoundedNumber(request.silentMinutes, "silentMinutes", WATCHDOG_MIN_SILENT_MINUTES, undefined, { integer: true });
	if (silent.error !== undefined) return { error: silent.error };
	const interval = readBoundedNumber(request.intervalMinutes, "intervalMinutes", WATCHDOG_MIN_INTERVAL_MINUTES, undefined, { integer: true });
	if (interval.error !== undefined) return { error: interval.error };
	const ttl = readTtlHours(request.ttlHours);
	if (ttl.error !== undefined) return { error: ttl.error };
	return {
		value: {
			id: `${WATCHDOG_ID_PREFIX}${randomUUID()}`,
			team: null,
			watcherSession: caller,
			targets,
			silentMinutes: silent.value ?? WATCHDOG_DEFAULT_SILENT_MINUTES,
			intervalMinutes: interval.value ?? WATCHDOG_DEFAULT_INTERVAL_MINUTES,
			expiresAt: now + ttl.value * 3600000,
			createdAt: now,
		},
	};
}

/**
 * The watchdog tick message (§3.2.3). Both bodies are plugin constants: the
 * only interpolated values are status fields (target id, reading time, silence
 * duration), so no registration argument can smuggle a payload into the
 * watcher's next request. The source is the audited three-member relay shape
 * (V10) — the watchdog has no session identity of its own, so the watcher is
 * recorded as the sender of the message it receives (§3.2.3 note (a)).
 */
function tickMessage(watcherSession, target, signal, now) {
	let text;
	if (signal.verdict === "goal-disarmed") {
		text = `[watchdog] 目标 ${target} 的 goal 处于 active-but-disarmed（可能原因：max-tokens 回合结束 / DSH 重启 / agent error，读数 ${readStamp(now)}）。该状态不会自愈：请向用户说明并请求授权 resume；用户同意后调用 update_goal(action:"resume") 恢复续跑。复核用 team_link_list_sessions。`;
	} else {
		text = `[watchdog] 目标 ${target} 失联征兆：verdict=${signal.verdict} 静默 ${fmtSilence(signal.silenceMs)}（读数 ${readStamp(now)}）。请用 team_link_list_sessions 复核后处置；误报或不再需要盯人可用 team_link_watch clear。`;
	}
	return {
		id: `${WATCHDOG_TICK_ID_PREFIX}${randomUUID()}`,
		role: "user",
		source: { kind: "agent-message", form: "relay", senderSessionId: watcherSession },
		content: [{ type: "text", text: wellFormed(text) }],
	};
}

/** Best-effort session surface read; an unreadable or cold log yields `undefined`. */
async function readSessionSurface(ctx, sessionId) {
	try {
		return await ctx.sessionQuery.readSurface(sessionId);
	} catch {
		return undefined;
	}
}

/**
 * Cross-session watchdog controller (§3.2.3). One interval timer per
 * registration at its `intervalMinutes` granularity, plus two process-local
 * maps: the per-target tick debounce and the watcher-dead marks. §3.2.4 is
 * explicit that neither is persisted — a restart forgets them, which may cost
 * one extra tick and never resurrects a stale "already handled" state.
 */
function createWatchdog(ctx, policy) {
	const timers = new Map();
	const ticked = new Map();
	const deadWatchers = new Map();
	let disposed = false;

	function stopTimer(id) {
		const timer = timers.get(id);
		if (timer === undefined) return;
		clearInterval(timer);
		timers.delete(id);
	}

	/** Drop every process-local trace of one registration. */
	function forget(id) {
		for (const key of [...ticked.keys()]) if (key.startsWith(`${id}\n`)) ticked.delete(key);
		deadWatchers.delete(id);
	}

	/** (Re)arm the patrol timer of one registration. */
	function schedule(entry) {
		if (disposed) return;
		stopTimer(entry.id);
		const timer = setInterval(() => {
			void patrol({ id: entry.id }).catch((error) => {
				ctx.logger?.warn?.(`${PLUGIN_LABEL}: watchdog patrol failed: ${describeError(error)}`);
			});
		}, entry.intervalMinutes * 60000);
		// A patrol timer is background housekeeping: it must never hold the shell open.
		timer.unref?.();
		timers.set(entry.id, timer);
	}

	/** Drop one registration and its timer (clear tool, TTL self-clean). */
	async function removeWatchdog(id) {
		stopTimer(id);
		forget(id);
		const current = policy.get().watchdogs;
		if (!current.some((entry) => entry.id === id)) return;
		try {
			await policy.update({ watchdogs: current.filter((entry) => entry.id !== id) });
		} catch (error) {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: watchdog ${id} could not be removed: ${describeError(error)}`);
		}
	}

	/**
	 * Already ticked for this target's current silent period? The watermark is the
	 * target's last observed activity (§3.1's two timestamps): unchanged since the
	 * last tick means nothing happened in between, so the same silence is still
	 * being reported and a second tick would be noise. It also covers targets
	 * whose silence cannot be measured at all (a gone agent has no activity
	 * watermark either, so it is ticked once and not on every patrol).
	 *
	 * A watermark that DID advance is a new silence period, but the patrol also
	 * waits out one interval before reporting it — the "去抖间隔" of §3.2.4, so a
	 * burst of activity cannot produce a burst of ticks.
	 */
	function recentlyTicked(id, target, signal, intervalMinutes, now) {
		const last = ticked.get(`${id}\n${target}`);
		if (last === undefined) return false;
		if (last.activity === lastActivityOf(signal)) return true;
		return now - last.at < intervalMinutes * 60000;
	}

	function markTicked(id, target, signal, now) {
		ticked.set(`${id}\n${target}`, { at: now, activity: lastActivityOf(signal), silenceMs: signal.silenceMs });
	}

	/**
	 * Watcher agent gone: mark the signal face and leave the registration alone
	 * (A4 — nothing can wake a closed session; the tick has nowhere to land).
	 * The mark is process-local, so if the watcher comes back inside the TTL the
	 * patrol simply resumes delivering.
	 */
	function markWatcherDead(id, now) {
		if (deadWatchers.has(id)) return;
		deadWatchers.set(id, now);
		ctx.logger?.warn?.(`${PLUGIN_LABEL}: watchdog ${id} observer session is not live; keeping the registration until its TTL`);
	}

	/**
	 * One pass for one registration (§3.2.3, line by line): an expired
	 * registration self-cleans FIRST — ahead of every watcher gate, so a watcher
	 * that is gone, running or armed-active can never keep an expired row (and its
	 * empty timer) alive (§3.2.3 TTL 自清【最先】, audit D1); then missing watcher →
	 * mark the signal face and stop; running watcher → never interrupt; armed-active
	 * watcher → it has its own cadence (A1); then per target: skip every verdict
	 * outside {@link TICKABLE_VERDICTS}, debounce one tick per silent period, and
	 * deliver.
	 */
	async function patrolOne(entry, now) {
		if (now > entry.expiresAt) {
			await removeWatchdog(entry.id);
			return;
		}
		const watcher = ctx.agents.get(entry.watcherSession);
		if (watcher === undefined) {
			markWatcherDead(entry.id, now);
			return;
		}
		deadWatchers.delete(entry.id);
		if (watcher.status === "running") return;
		const watcherGoal = readGoalSignal(ctx, entry.watcherSession, watcher);
		if (watcherGoal !== null && watcherGoal.phase === "active" && watcherGoal.activation === "armed") return;
		for (const target of entry.targets) {
			const targetAgent = ctx.agents.get(target);
			const surface = targetAgent === undefined ? undefined : await readSessionSurface(ctx, target);
			const signal = buildLivenessSignal(ctx, target, {
				now,
				agent: targetAgent,
				surface,
				silentMin: entry.silentMinutes,
				runMin: LV_RUN_MIN,
			});
			if (!TICKABLE_VERDICTS.has(signal.verdict)) continue;
			if (recentlyTicked(entry.id, target, signal, entry.intervalMinutes, now)) continue;
			try {
				watcher.followup(tickMessage(entry.watcherSession, target, signal, now));
				markTicked(entry.id, target, signal, now);
			} catch (error) {
				ctx.logger?.warn?.(`${PLUGIN_LABEL}: watchdog tick to ${entry.watcherSession} failed: ${describeError(error)}`);
			}
		}
	}

	/**
	 * Run one patrol pass over every registration, or over one explicit id.
	 * `now` is injectable so the TTL and debounce behaviour is testable without
	 * waiting for wall-clock time.
	 */
	async function patrol(options = {}) {
		if (disposed) return;
		const now = typeof options.now === "number" ? options.now : Date.now();
		for (const entry of policy.get().watchdogs) {
			if (options.id !== undefined && entry.id !== options.id) continue;
			await patrolOne(entry, now);
		}
	}

	/**
	 * Arm the timers of every persisted registration and hand back the disposer
	 * that is passed to `ctx.effect` — the plugin's only background work must die
	 * with the plugin (§3.2.4 / the task's cleanup requirement).
	 */
	function start() {
		for (const entry of policy.get().watchdogs) schedule(entry);
		return () => {
			disposed = true;
			for (const id of [...timers.keys()]) stopTimer(id);
			timers.clear();
			ticked.clear();
			deadWatchers.clear();
		};
	}

	/** Clear one registration's process-local state (the clear tool's target). */
	function cancel(id) {
		stopTimer(id);
		forget(id);
	}

	// `deadWatchers` is read by the watch tool's list action; `timers` and
	// `ticked` are exposed so host-half.test.mjs can assert timer ownership and
	// the debounce without reaching into closure state.
	return { start, schedule, cancel, patrol, removeWatchdog, timers, ticked, deadWatchers };
}

// ---------------------------------------------------------------------------
// roster (team role registry) + team blackboard (§3.3, M2)
// ---------------------------------------------------------------------------

/** Team names are `[a-z0-9-]+` (§3.3.1). The name becomes a path segment of the
 * blackboard directory, so every other shape — a separator, a dot, an empty
 * string — is refused at the door instead of reaching `path.join`. */
const TEAM_NAME_RE = /^[a-z0-9-]+$/u;
/** The convention role whose incumbent is the writer under the default
 * `policy.writer === "coordinator"` (§3.3.1/§3.3.2); other roles are free-form. */
const COORDINATOR_ROLE = "coordinator";
/** Blackboard directory (inside a team's captured workspace) and its files. */
const TEAM_DIR = "team";
const ROSTER_MIRROR_FILE = "roster.md";
const DECISIONS_FILE = "decisions.md";
const DISCIPLINE_FILE = "discipline.md";
/** The `file` argument is a closed set (§4.1) — never a caller-supplied path. */
const BLACKBOARD_FILES = new Set(["decisions", "discipline"]);
/** §4.1: one blackboard line may not exceed this many characters, counted in
 * code points so an astral character costs one (the `preview` convention). */
const BLACKBOARD_LINE_LIMIT = 500;
/** Trailing decisions returned by one `team_link_team_read` (§3.3.3, K = 20). */
const DECISIONS_WINDOW = 20;
/** Longest role name accepted — a role name is a settings key and a markdown
 * heading, not a document. */
const ROLE_NAME_LIMIT = 64;

/** Team name reading (§3.3.1): `[a-z0-9-]+`, trimmed; everything else refuses. */
function readTeamName(value) {
	if (typeof value !== "string" || value.trim() === "") return { error: "需要 team（团队名）。" };
	const name = value.trim();
	if (!TEAM_NAME_RE.test(name)) return { error: `团队名 ${name} 非法：只允许 [a-z0-9-]+（团队名是黑板目录的路径段，收紧字符集以杜绝路径穿越）。` };
	return { value: name };
}

/** Role name reading: non-empty, bounded, free of control characters — a role
 * name is stored in settings and rendered as a markdown heading. */
function readRoleName(value) {
	if (typeof value !== "string" || value.trim() === "") return { error: "需要 role（角色名；约定角色名 coordinator）。" };
	const role = value.trim();
	if ([...role].length > ROLE_NAME_LIMIT) return { error: `角色名过长（上限 ${ROLE_NAME_LIMIT} 字符）。` };
	if (/[\u0000-\u001F\u007F]/u.test(role)) return { error: "角色名不能包含控制字符或换行。" };
	return { value: role };
}

/** Session id reading for `set-role` — one line, so a history record cannot be
 * split by an injected newline or a `|` separator. */
function readSessionId(value) {
	if (typeof value !== "string" || value.trim() === "") return { error: "需要 session（新现任会话 id）。" };
	const session = value.trim();
	if (/[\r\n|]/u.test(session)) return { error: "session 不能包含换行或 | 字符。" };
	return { value: session };
}

/** History note reading: optional, trimmed; an empty note is no note. */
function readNote(value) {
	if (typeof value !== "string") return undefined;
	const note = value.trim();
	return note === "" ? undefined : note;
}

/** One role record of a team, or `null`. */
function roleOf(team, role) {
	return team.roles.find((entry) => entry.role === role) ?? null;
}

/** The open (incumbent) tenure record of one role, or `null` — `until: null` is
 * what marks the tenure the current holder is still serving. */
function openTenureOf(entry) {
	for (let index = entry.history.length - 1; index >= 0; index -= 1) {
		const record = entry.history[index];
		if (record.session === entry.current && record.until === null) return record;
	}
	return null;
}

/** The start of a role's open tenure — the incumbent's `from`, falling back to
 * the team creation time when history holds no open record (hand-edited row). */
function tenureStartOf(entry, team) {
	const open = openTenureOf(entry);
	return open === null ? team.createdAt : open.from;
}

/** Close one tenure inside a history copy: set its `until` (and the note), or
 * append a closing record when no open one exists for that session (§3.3.2
 * "旧任 until=now, note"). Returns the same array, mutated. */
function closeTenure(history, session, now, note) {
	for (let index = history.length - 1; index >= 0; index -= 1) {
		const record = history[index];
		if (record.session !== session || record.until !== null) continue;
		record.until = now;
		if (note !== undefined) record.note = note;
		return history;
	}
	const previous = history.filter((record) => record.session === session).pop();
	const record = { session, from: previous === undefined ? now : previous.from, until: now };
	if (note !== undefined) record.note = note;
	history.push(record);
	return history;
}

/**
 * §3.3.2 write permission for one team. `policy.writer === "any"` admits every
 * session. `"coordinator"` (the default) admits only the session currently
 * holding the `coordinator` role — and a vacant coordinator refuses every
 * session path, because the design points that case at the settings UI, where
 * the user is always the super-writer.
 */
function writerGate(team, caller) {
	if (team.policy.writer === "any") return { ok: true };
	const coordinator = roleOf(team, COORDINATOR_ROLE);
	const incumbent = coordinator === null ? null : coordinator.current;
	if (incumbent === null) {
		return { error: `写操作被拒绝：团队 ${team.name} 的 policy.writer=coordinator，但 coordinator 角色当前空缺（current=null）——会话路径写不进去，请由用户经设置 UI（设置命名空间 team-link 的 teams 键）指定现任协调者。` };
	}
	if (caller === undefined) {
		return { error: `写操作被拒绝：团队 ${team.name} 的 policy.writer=coordinator，只有现任协调者会话 ${incumbent} 可写，而当前执行上下文没有会话身份（exec.agent.id）。` };
	}
	if (caller !== incumbent) {
		return { error: `写操作被拒绝：团队 ${team.name} 的 policy.writer=coordinator，只有现任协调者会话 ${incumbent} 可写（当前调用会话 ${caller}）。` };
	}
	return { ok: true };
}

/**
 * §3.3.2 (v1.3) retirement permission, implemented verbatim: "仅现任协调者会话
 * 或用户发起". Deliberately independent of `policy.writer` — the clause names
 * the incumbent coordinator, not the writer policy, so a `writer: "any"` team
 * still retires through its coordinator. The user path is the settings UI.
 */
function retireGate(team, caller) {
	const coordinator = roleOf(team, COORDINATOR_ROLE);
	const incumbent = coordinator === null ? null : coordinator.current;
	if (incumbent === null) {
		return { error: `退役被拒绝：团队 ${team.name} 的 coordinator 角色当前空缺（current=null），没有「现任协调者会话」可以发起退役。请由用户经设置 UI 处理。` };
	}
	if (caller === undefined || caller !== incumbent) {
		return { error: `退役被拒绝：只有现任协调者会话 ${incumbent} 可以发起退役（当前调用会话 ${caller ?? "（无会话身份）"}）。` };
	}
	return { ok: true };
}

/**
 * Pure `upsert-team` (§3.3.2): create a team, or update an existing one
 * idempotently. On an existing team only `policy` is updatable — and only the
 * user can change it (this tool has no policy parameter), so an existing team's
 * policy, roles, history and createdAt are all left alone. `workspace` is
 * captured from the creating session's `agentCwd` and is never overwritten; a
 * team that has no workspace yet (a row written by hand in the settings UI)
 * captures the first one that comes along.
 */
function applyTeamUpsert(teams, request) {
	const { name, workspace, now } = request;
	const existing = teams.find((team) => team.name === name) ?? null;
	if (existing === null) {
		const team = { name, createdAt: now, workspace, policy: { writer: "coordinator" }, roles: [] };
		return { teams: [...teams, team], team, created: true, capturedWorkspace: workspace !== "" };
	}
	const captured = existing.workspace === "" && workspace !== "";
	const team = captured ? { ...existing, workspace } : existing;
	return { teams: teams.map((entry) => (entry.name === name ? team : entry)), team, created: false, capturedWorkspace: captured };
}

/**
 * Pure `set-role` (§3.3.2): replace the incumbent and extend the version history
 * — the previous tenure is closed (`until = now`, plus the caller's note) and
 * the new one is appended open (`until: null`). A role that does not exist yet
 * is created by the appointment. **pairs are never migrated here**: §3.3.2
 * reserves migration for the rotation flow (§3.6), so no hand-over can bypass
 * the rotation token.
 * @returns `{ team, previous }`.
 */
function applySetRole(team, request) {
	const { role, session, note, now } = request;
	const existing = roleOf(team, role);
	const previous = existing === null ? null : existing.current;
	const history = existing === null ? [] : existing.history.map((record) => ({ ...record }));
	if (previous !== null) closeTenure(history, previous, now, note);
	const open = { session, from: now, until: null };
	// The note belongs to the hand-over it describes: it lands on the tenure being
	// closed. Only a first appointment (no previous holder) has nowhere else to
	// put it, so there it annotates the tenure it opens.
	if (previous === null && note !== undefined) open.note = note;
	history.push(open);
	const record = { role, current: session, pending: existing === null ? null : existing.pending, history };
	const roles = existing === null
		? [...team.roles, record]
		: team.roles.map((entry) => (entry.role === role ? record : entry));
	return { team: { ...team, roles }, previous };
}

/**
 * Pure `retire` (§3.3.2 v1.3): the role's `current` becomes vacant and the
 * incumbent's tenure is closed with the retirement note. Retire itself touches
 * no trust data — the optional cleanup runs afterwards, on the user's word.
 * @returns `{ team, retired }` or `{ error }`.
 */
function applyRetire(team, request) {
	const { role, note, now } = request;
	const existing = roleOf(team, role);
	if (existing === null) return { error: `团队 ${team.name} 没有角色 ${role}。` };
	if (existing.current === null) return { error: `团队 ${team.name} 的角色 ${role} 已经空缺（vacant），无需退役。` };
	const retired = existing.current;
	const history = existing.history.map((record) => ({ ...record }));
	closeTenure(history, retired, now, note);
	const roles = team.roles.map((entry) => (entry.role === role ? { ...entry, current: null, history } : entry));
	return { team: { ...team, roles }, retired };
}

/** Trust references pointing at one session, in both directions (§3.3.2 retire
 * cleanup). `pairs` is directional by construction and both ends are matched;
 * the two id lists are this plugin's global lists, so "pointing at" means the
 * session appears in them. */
function trustReferencesTo(view, session) {
	const pairs = view.pairs.filter((pair) => pair.a === session || pair.b === session);
	const trustedSenders = view.trustedSenders.filter((id) => id === session);
	const rememberTargets = view.rememberTargets.filter((id) => id === session);
	return { pairs, trustedSenders, rememberTargets, total: pairs.length + trustedSenders.length + rememberTargets.length };
}

/** Blackboard paths of one team. `name` is already `[a-z0-9-]+`, so no segment
 * of the joined path can escape the captured workspace. */
function blackboardPaths(team) {
	const dir = path.join(team.workspace, TEAM_DIR, team.name);
	return {
		dir,
		roster: path.join(dir, ROSTER_MIRROR_FILE),
		decisions: path.join(dir, DECISIONS_FILE),
		discipline: path.join(dir, DISCIPLINE_FILE),
	};
}

/** Human-readable rendering of one team — the `roster.md` mirror (§3.3.1). The
 * settings namespace stays the source of truth; this copy is overwritten by the
 * next roster change. */
function renderRosterMirror(team) {
	const lines = [
		`# 团队 roster：${team.name}`,
		"",
		`- 生成时间：${localStamp()}`,
		`- 创建时间：${readStamp(team.createdAt)}`,
		`- workspace：${team.workspace === "" ? "（未捕获）" : team.workspace}`,
		`- policy.writer：${team.policy.writer}（coordinator=仅现任协调者会话可写；any=任何会话可写）`,
		"- 事实源：设置命名空间 `team-link` 的 `teams` 键；本文件由 dsh-team-link 与设置变更同一事务内 best-effort 镜像，读以 settings 为准。",
		"",
		"## 角色",
		"",
	];
	if (team.roles.length === 0) lines.push("（无角色：用 team_link_roster action=set-role 指定现任）", "");
	for (const entry of team.roles) {
		lines.push(`### ${entry.role}`, "");
		lines.push(`- 现任：${entry.current === null ? "空缺（vacant）" : `${entry.current}（自 ${readStamp(tenureStartOf(entry, team))}）`}`);
		lines.push(`- pending：${entry.pending === null ? "（无）" : `${entry.pending.session}（token ${entry.pending.token}，到期 ${readStamp(entry.pending.expiresAt)}，team=${entry.pending.team} role=${entry.pending.role}）`}`);
		lines.push(`- 版本史（共 ${entry.history.length} 条，退役≠删除）：`);
		if (entry.history.length === 0) lines.push("  - （无）");
		for (const record of entry.history) {
			const until = record.until === null ? "现任" : readStamp(record.until);
			const note = record.note === undefined ? "" : `　备注：${preview(record.note, 200)}`;
			lines.push(`  - ${record.session}　${readStamp(record.from)} → ${until}${note}`);
		}
		lines.push("");
	}
	return wellFormed(`${lines.join("\n")}\n`);
}

/** Best-effort mirror write (§3.3.1: same transaction as the settings change; a
 * failure is a warning only — the settings namespace stays authoritative and the
 * next roster change rewrites the file). */
async function writeRosterMirror(team) {
	if (team.workspace === "") return { ok: false, error: "团队没有 workspace 记录，无法定位 <workspace>/team/<name>/roster.md" };
	try {
		const file = blackboardPaths(team).roster;
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, renderRosterMirror(team), "utf8");
		return { ok: true, path: file };
	} catch (error) {
		return { ok: false, error: describeError(error) };
	}
}

/** The mirror line of a tool result: success names the file, failure says the
 * settings namespace is unaffected (§3.3.1「失败仅告警」). */
function mirrorNote(mirror) {
	return mirror.ok
		? `镜像已更新：${mirror.path}`
		: `（注意：roster.md 镜像写入失败——${mirror.error}。settings 是本插件的事实源，本次变更已生效；镜像会在下一次 roster 变更时重试，也可手工从设置重建。）`;
}

/** Content hash of a blackboard file — the discipline file's optimistic lock
 * (§3.3.3). Truncated to 16 hex characters: short enough to carry in a tool
 * call, still 64 bits of a SHA-256 digest. */
function blackboardHash(text) {
	return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** Read one blackboard file. A missing file is an empty file — reported as such
 * — and any other failure comes back as readable text instead of an exception
 * out of a tool call. */
async function readBlackboardFile(file) {
	try {
		return { text: await readFile(file, "utf8"), exists: true };
	} catch (error) {
		if (error !== null && typeof error === "object" && error.code === "ENOENT") return { text: "", exists: false };
		return { error: describeError(error) };
	}
}

/** Every non-empty line of a blackboard file, in order. */
function blackboardLines(text) {
	return text.split(/\r?\n/u).filter((line) => line.trim() !== "");
}

/** Highest `seq` already present in decisions.md — the ledger's counter (§3.3.3
 * "seq 单调递增", assigned by the plugin). Unparsable lines are ignored rather
 * than allowed to reset the counter. */
function lastDecisionSeq(text) {
	let max = 0;
	for (const line of blackboardLines(text)) {
		const matched = /^(\d+)\s*\|/u.exec(line);
		if (matched === null) continue;
		const seq = Number(matched[1]);
		if (Number.isFinite(seq) && seq > max) max = seq;
	}
	return max;
}

/** §4.1 line bound, counted in code points (so an astral character costs one). */
function readBlackboardLine(value, name) {
	if (typeof value !== "string") return { error: `${name} 必须是字符串。` };
	if (value.trim() === "") return { error: `${name} 不能为空。` };
	const length = [...value].length;
	if (length > BLACKBOARD_LINE_LIMIT) {
		return { error: `${name} 超过单行上限 ${BLACKBOARD_LINE_LIMIT} 字符（当前 ${length} 字符；§4.1 防黑板刷屏）。` };
	}
	return { value };
}

/** Author field of one ledger row: the caller's session id, kept to a single
 * injection-free line (a row is parsed by splitting on `|`). A caller without a
 * session identity is recorded honestly as `unknown` rather than invented. */
function blackboardAuthor(exec) {
	const caller = agentSessionId(exec);
	if (caller === undefined) return "unknown";
	return caller.replace(/[\r\n|]/gu, "_");
}

/** One ledger row: `seq | ISO 时间 | author-session-id | 正文` (§3.3.3). */
function decisionRow(seq, iso, author, text) {
	return `${seq} | ${iso} | ${author} | ${text}`;
}

/**
 * Register the M2 tools (§3.3.2/§3.3.3): the roster registry and the team
 * blackboard reader/writer.
 */
function registerTeamTools(ctx, policy) {
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_roster",
		description: "团队角色注册表（roster，M2）：团队 -> 角色 -> 会话，含版本史。action：get（任何会话可读：全体团队概要 + 指定 team 详情含 history）/ upsert-team（创建或幂等更新；团队名 [a-z0-9-]+；已存在时只有 policy 属于可更新面，本工具无 policy 参数，故 policy 由用户经设置 UI 修改）/ set-role（换现任：current 替换 + history 追加，旧任记录 until=now；不迁移 pairs——那是 M4 rotation 的专属动作）/ retire（退役：仅现任协调者会话发起，current 置空 + history 记退役；随后可选一个用户确认对话框清理指向退役会话的 pairs/trustedSenders/rememberTargets）。写权限：policy.writer=coordinator 时只有该团队 coordinator 角色的现任会话可写，现任空缺时会话路径一律拒绝（用户经设置 UI 永远是超级写者）；writer=any 时任何会话可写。",
		parameters: {
			action: { type: "string", required: true, enum: ["get", "upsert-team", "set-role", "retire"], description: "get / upsert-team / set-role / retire" },
			team: { type: "string", description: "团队名（[a-z0-9-]+）" },
			role: { type: "string", description: "set-role / retire：角色名（约定角色名 coordinator，允许自定义如 reviewer）" },
			session: { type: "string", description: "set-role：新现任会话 id" },
			note: { type: "string", description: "set-role / retire：写入版本史的备注" },
		},
		output: textOutput(),
		timeoutMs: 60000,
		async execute(args, exec) {
			try {
				const action = typeof args.action === "string" ? args.action : "";
				const teams = policy.get().teams;
				const caller = agentSessionId(exec);
				const now = Date.now();

				if (action === "get") {
					const wanted = args.team === undefined || args.team === null || args.team === "" ? null : readTeamName(args.team);
					if (wanted !== null && wanted.error !== undefined) return wellFormed(`读取失败：${wanted.error}`);
					const lines = [`团队注册表（共 ${teams.length} 个团队）：`];
					if (teams.length === 0) lines.push("（无团队：用 action=upsert-team 创建，团队名 [a-z0-9-]+）");
					for (const team of teams) {
						lines.push(`- ${team.name} — 创建于 ${readStamp(team.createdAt)} · policy.writer=${team.policy.writer} · 角色 ${team.roles.length} 个 · workspace=${team.workspace === "" ? "（未捕获）" : team.workspace}`);
						for (const entry of team.roles) {
							lines.push(`    角色 ${entry.role}：${entry.current === null ? "空缺（vacant）" : `现任 ${entry.current}（自 ${readStamp(tenureStartOf(entry, team))}）`}`);
						}
					}
					if (wanted !== null) {
						const team = teams.find((candidate) => candidate.name === wanted.value);
						if (team === undefined) {
							lines.push("", `读取失败：团队 ${wanted.value} 不在注册表中。`);
							return wellFormed(lines.join("\n"));
						}
						lines.push("", `团队 ${team.name} 详情：`);
						lines.push(`- workspace：${team.workspace === "" ? "（未捕获）" : team.workspace}`);
						lines.push(`- policy.writer：${team.policy.writer}（coordinator=仅现任协调者会话可写；any=任何会话可写）`);
						lines.push(`- 黑板目录：${team.workspace === "" ? "（未捕获 workspace，黑板不可用）" : blackboardPaths(team).dir}`);
						for (const entry of team.roles) {
							lines.push(`- 角色 ${entry.role}：${entry.current === null ? "空缺（vacant）" : `现任 ${entry.current}（自 ${readStamp(tenureStartOf(entry, team))}）`}`);
							lines.push(`    pending：${entry.pending === null ? "（无）" : `${entry.pending.session}（token ${entry.pending.token}，到期 ${readStamp(entry.pending.expiresAt)}）`}`);
							lines.push(`    版本史（共 ${entry.history.length} 条，退役≠删除）：`);
							if (entry.history.length === 0) lines.push("      - （无）");
							for (const record of entry.history) {
								const until = record.until === null ? "现任" : readStamp(record.until);
								const note = record.note === undefined ? "" : `　备注：${preview(record.note, 200)}`;
								lines.push(`      - ${record.session}　${readStamp(record.from)} → ${until}${note}`);
							}
						}
					}
					lines.push("", `（读数 ${readStamp(now)}，${READ_STALE_NOTE}）`);
					return wellFormed(lines.join("\n"));
				}

				if (action === "upsert-team") {
					const name = readTeamName(args.team);
					if (name.error !== undefined) return wellFormed(`创建/更新失败：${name.error}`);
					const existing = teams.find((team) => team.name === name.value) ?? null;
					if (existing !== null) {
						const gate = writerGate(existing, caller);
						if (gate.error !== undefined) return wellFormed(gate.error);
					}
					if (caller === undefined) {
						return wellFormed("创建/更新失败：需要可交互的活动代理——workspace 在团队创建时从执行会话的 agentCwd 捕获（exec.agent.id 缺失时无法定位黑板根目录）。");
					}
					const applied = applyTeamUpsert(teams, { name: name.value, workspace: agentCwd(exec), now });
					try {
						await policy.update({ teams: applied.teams });
					} catch (error) {
						return wellFormed(`创建/更新失败：写入设置失败（${describeError(error)}）。`);
					}
					const mirror = await writeRosterMirror(applied.team);
					const lines = [
						applied.created
							? `已创建团队 ${applied.team.name}：policy.writer=coordinator，workspace=${applied.team.workspace}（自执行会话 agentCwd 捕获）。`
							: `团队 ${applied.team.name} 已存在：upsert-team 幂等——roles / 版本史 / createdAt / policy 均未改动${applied.capturedWorkspace ? `（仅补记首次捕获的 workspace=${applied.team.workspace}）` : ""}。`,
						`现状：policy.writer=${applied.team.policy.writer} · 角色 ${applied.team.roles.length} 个 · 创建于 ${readStamp(applied.team.createdAt)}。`,
						mirrorNote(mirror),
					];
					if (applied.created) lines.push("下一步：用 action=set-role 指定 coordinator 现任。注意 policy.writer=coordinator 且现任空缺时会话路径写不进去——首任协调者需由用户经设置 UI 指定。");
					return wellFormed(lines.join("\n"));
				}

				if (action === "set-role") {
					const name = readTeamName(args.team);
					if (name.error !== undefined) return wellFormed(`写入失败：${name.error}`);
					const team = teams.find((candidate) => candidate.name === name.value) ?? null;
					if (team === null) return wellFormed(`写入失败：团队 ${name.value} 不在注册表中（先用 action=upsert-team 创建）。`);
					const gate = writerGate(team, caller);
					if (gate.error !== undefined) return wellFormed(gate.error);
					const role = readRoleName(args.role);
					if (role.error !== undefined) return wellFormed(`写入失败：${role.error}`);
					const session = readSessionId(args.session);
					if (session.error !== undefined) return wellFormed(`写入失败：${session.error}`);
					const note = readNote(args.note);
					const applied = applySetRole(team, { role: role.value, session: session.value, note, now });
					try {
						await policy.update({ teams: teams.map((entry) => (entry.name === team.name ? applied.team : entry)) });
					} catch (error) {
						return wellFormed(`写入失败：写入设置失败（${describeError(error)}）。`);
					}
					const mirror = await writeRosterMirror(applied.team);
					const entry = roleOf(applied.team, role.value);
					return wellFormed([
						`已设置：团队 ${team.name} 的角色 ${role.value} —— ${applied.previous === null ? "原为空缺，现指定" : `原任 ${applied.previous} 被替换为`} ${session.value}（自 ${readStamp(now)}）。`,
						`版本史 ${entry === null ? 0 : entry.history.length} 条${applied.previous === null ? "" : `（旧任 ${applied.previous} 记录 until=${readStamp(now)}）`}${note === undefined ? "" : `；备注：${preview(note, 200)}`}。`,
						"未迁移 pairs：换届的信任迁移是 rotation（M4）的专属动作，set-role 只换身份（§3.3.2）。",
						mirrorNote(mirror),
					].join("\n"));
				}

				if (action === "retire") {
					const name = readTeamName(args.team);
					if (name.error !== undefined) return wellFormed(`退役失败：${name.error}`);
					const team = teams.find((candidate) => candidate.name === name.value) ?? null;
					if (team === null) return wellFormed(`退役失败：团队 ${name.value} 不在注册表中。`);
					const gate = retireGate(team, caller);
					if (gate.error !== undefined) return wellFormed(gate.error);
					const role = readRoleName(args.role);
					if (role.error !== undefined) return wellFormed(`退役失败：${role.error}`);
					const note = readNote(args.note);
					const applied = applyRetire(team, { role: role.value, note, now });
					if (applied.error !== undefined) return wellFormed(`退役失败：${applied.error}`);
					try {
						await policy.update({ teams: teams.map((entry) => (entry.name === team.name ? applied.team : entry)) });
					} catch (error) {
						return wellFormed(`退役失败：写入设置失败（${describeError(error)}）。`);
					}
					const mirror = await writeRosterMirror(applied.team);
					const lines = [
						`已退役：团队 ${team.name} 的角色 ${role.value} —— 现任 ${applied.retired} 置空（vacant），版本史记录 until=${readStamp(now)}${note === undefined ? "" : `，备注：${preview(note, 200)}`}。`,
						mirrorNote(mirror),
					];
					// §3.3.2 optional cleanup: one dialog listing every trust reference that
					// still points at the retired session, in both directions. Retire itself
					// already happened — the cleanup can only fail soft.
					const view = policy.get();
					const references = trustReferencesTo(view, applied.retired);
					const userQuestions = ctx.get?.("userQuestions");
					if (references.total === 0) {
						lines.push("信任清理：没有指向该会话的 pairs / trustedSenders / rememberTargets，无需清理。");
					} else if (userQuestions === undefined || typeof userQuestions.ask !== "function") {
						lines.push(`信任清理已跳过：确认服务（userQuestions）不可用。退役本身已完成；${references.pairs.length} 个 pairs、${references.trustedSenders.length} 个 trustedSenders、${references.rememberTargets.length} 个 rememberTargets 仍指向该会话（不是安全洞——pairs 照旧过门——只是死数据），可由用户在设置 team-link 中删除。`);
					} else {
						let choice;
						try {
							const answer = await userQuestions.ask({
								questions: [{
									id: "retire-cleanup",
									header: "退役信任清理",
									question: wellFormed([
										`会话 ${applied.retired} 已从团队 ${team.name} 的角色 ${role.value} 退役。`,
										"",
										"以下信任引用仍指向该会话（含跨端两个方向）：",
										`- pairs（${references.pairs.length} 个，双向配对）：${references.pairs.length === 0 ? "（无）" : references.pairs.map((pair) => `${pair.a} ↔ ${pair.b}`).join("，")}`,
										`- trustedSenders（${references.trustedSenders.length} 个，该会话在「免确认接收的发送方」列表中）：${references.trustedSenders.length === 0 ? "（无）" : references.trustedSenders.join("，")}`,
										`- rememberTargets（${references.rememberTargets.length} 个，该会话在「免确认发送目标」列表中）：${references.rememberTargets.length === 0 ? "（无）" : references.rememberTargets.join("，")}`,
										"",
										"确认后清理这些引用；保留则它们原样留在设置里（配对通道照旧过门，不是安全洞，只是死数据堆积）。",
									].join("\n")),
									options: [
										{ label: "清理", description: "删除全部指向退役会话的 pairs / trustedSenders / rememberTargets" },
										{ label: "保留", description: "不改动信任数据（死数据保留，可随时在设置里删除）" },
									],
								}],
								agent: exec.agent,
								signal: exec.signal,
							});
							choice = answer?.answers?.[0]?.selected?.[0];
						} catch (error) {
							lines.push(`信任清理未完成：确认对话框失败（${describeError(error)}）；引用保持原样，退役本身已完成。`);
						}
						if (choice === "清理") {
							try {
								await policy.update({
									pairs: view.pairs.filter((pair) => pair.a !== applied.retired && pair.b !== applied.retired),
									trustedSenders: view.trustedSenders.filter((id) => id !== applied.retired),
									rememberTargets: view.rememberTargets.filter((id) => id !== applied.retired),
								});
								lines.push(`已清理：${references.pairs.length} 个 pairs / ${references.trustedSenders.length} 个 trustedSenders / ${references.rememberTargets.length} 个 rememberTargets。`);
							} catch (error) {
								lines.push(`信任清理失败：写入设置失败（${describeError(error)}）；退役本身已完成。`);
							}
						} else if (choice === "保留") {
							lines.push("已保留全部信任引用（未做任何清理）。");
						} else if (choice !== undefined) {
							lines.push(`信任清理未执行：对话框返回「${choice}」，不是明确同意。`);
						}
					}
					return wellFormed(lines.join("\n"));
				}

				return "操作失败：action 必须是 get / upsert-team / set-role / retire。";
			} catch (error) {
				return wellFormed(`roster 操作失败：${describeError(error)}`);
			}
		},
	})), "team-link: roster tool");

	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_team_read",
		description: "读团队黑板（M2，§3.3.3）：一次返回 roster 概要 + decisions.md 末 20 条 + discipline.md 全文 + 各文件 baseHash（供 append 的乐观锁使用）。任何会话可读；写黑板没有权限门，但读要一次读齐省轮次。文件不存在按空处理并如实标注。黑板根目录 = <team.workspace>/team/<name>/（workspace 在团队首次创建时从会话 agentCwd 捕获）。",
		parameters: {
			team: { type: "string", required: true, description: "团队名（须已在 roster 中注册）" },
		},
		output: textOutput(),
		timeoutMs: 30000,
		async execute(args) {
			try {
				const name = readTeamName(args.team);
				if (name.error !== undefined) return wellFormed(`读取失败：${name.error}`);
				const team = policy.get().teams.find((candidate) => candidate.name === name.value) ?? null;
				if (team === null) return wellFormed(`读取失败：团队 ${name.value} 不在注册表中（先用 team_link_roster action=upsert-team 创建）。`);
				if (team.workspace === "") return wellFormed(`读取失败：团队 ${name.value} 没有 workspace 记录，黑板根目录未知（workspace 在团队首次创建时从会话 agentCwd 捕获；可由用户经设置 UI 补写路径）。`);
				const paths = blackboardPaths(team);
				const decisions = await readBlackboardFile(paths.decisions);
				if (decisions.error !== undefined) return wellFormed(`读取失败：decisions.md 无法读取（${decisions.error}）。`);
				const discipline = await readBlackboardFile(paths.discipline);
				if (discipline.error !== undefined) return wellFormed(`读取失败：discipline.md 无法读取（${discipline.error}）。`);
				const rows = blackboardLines(decisions.text);
				const shown = rows.slice(-DECISIONS_WINDOW);
				const decisionsHash = blackboardHash(decisions.text);
				const disciplineHash = blackboardHash(discipline.text);
				const lines = [
					`团队 ${team.name} 黑板（根：${paths.dir}）`,
					"",
					"--- roster（概要；事实源 = 设置 team-link 的 teams 键）---",
					`- policy.writer=${team.policy.writer} · 角色 ${team.roles.length} 个`,
				];
				for (const entry of team.roles) lines.push(`- 角色 ${entry.role}：${entry.current === null ? "空缺（vacant）" : `现任 ${entry.current}`}`);
				lines.push("", `--- decisions.md（只追加；此处显示末 ${DECISIONS_WINDOW} 条）---`);
				lines.push(decisions.exists
					? `共 ${rows.length} 条，显示 ${shown.length} 条 · baseHash=${decisionsHash}`
					: `（文件不存在，按空处理：0 条）baseHash=${decisionsHash}（空内容哈希）`);
				for (const row of shown) lines.push(row);
				lines.push("", "--- discipline.md（整文件替换，带 baseHash 乐观锁）---");
				lines.push(discipline.exists ? `baseHash=${disciplineHash}` : `（文件不存在，按空处理）baseHash=${disciplineHash}（空内容哈希）`);
				lines.push(discipline.text === "" ? "（空）" : discipline.text);
				lines.push("", `单行上限 ${BLACKBOARD_LINE_LIMIT} 字符（§4.1）。写黑板用 team_link_team_append：file=decisions 只追加（无需 baseHash，seq 由插件分配）；file=discipline 整文件替换（必须携带上面的 baseHash）。`);
				lines.push("", `（读数 ${readStamp(Date.now())}，${READ_STALE_NOTE}）`);
				return wellFormed(lines.join("\n"));
			} catch (error) {
				return wellFormed(`读取失败：${describeError(error)}`);
			}
		},
	})), "team-link: team read tool");

	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_team_append",
		description: "写团队黑板（M2，§3.3.3）：file=decisions 只追加一条裁决（格式 'seq | ISO时间 | author-session-id | 正文'，seq 由插件分配、单调递增，无需 baseHash）；file=discipline 整文件替换纪律条款（必须携带 team_link_team_read 返回的当前 baseHash，不匹配则拒绝并要求重读——乐观锁，防两个 worker 并发改稿互相覆盖）。两者都受单行 500 字符上限（§4.1）。任何会话都可写：黑板没有写权限门，写入者身份记录在行内 author 字段（透明可审计）。",
		parameters: {
			team: { type: "string", required: true, description: "团队名（须已在 roster 中注册）" },
			file: { type: "string", required: true, enum: ["decisions", "discipline"], description: "decisions（只追加）/ discipline（整文件替换）" },
			line: { type: "string", description: "decisions：单行正文；discipline：新的整份内容" },
			baseHash: { type: "string", description: "discipline 必填：team_link_team_read 返回的当前 baseHash" },
		},
		output: textOutput(),
		timeoutMs: 30000,
		async execute(args, exec) {
			try {
				const name = readTeamName(args.team);
				if (name.error !== undefined) return wellFormed(`写入失败：${name.error}`);
				const team = policy.get().teams.find((candidate) => candidate.name === name.value) ?? null;
				if (team === null) return wellFormed(`写入失败：团队 ${name.value} 不在注册表中（先用 team_link_roster action=upsert-team 创建）。`);
				if (team.workspace === "") return wellFormed(`写入失败：团队 ${name.value} 没有 workspace 记录，黑板根目录未知。`);
				const file = typeof args.file === "string" ? args.file : "";
				if (!BLACKBOARD_FILES.has(file)) return wellFormed("写入失败：file 必须是 decisions 或 discipline（白名单，不接受任何路径）。");
				const paths = blackboardPaths(team);
				const author = blackboardAuthor(exec);

				if (file === "decisions") {
					const text = readBlackboardLine(args.line, "line");
					if (text.error !== undefined) return wellFormed(`写入失败：${text.error}`);
					if (/[\r\n]/u.test(text.value)) return wellFormed("写入失败：decisions 的正文必须单行——每行是一条账本记录，换行会破坏 seq | 时间 | author | 正文 的解析。");
					const existing = await readBlackboardFile(paths.decisions);
					if (existing.error !== undefined) return wellFormed(`写入失败：decisions.md 无法读取（${existing.error}）。`);
					const seq = lastDecisionSeq(existing.text) + 1;
					const row = decisionRow(seq, new Date().toISOString(), author, text.value);
					// Append, do not rewrite: the ledger is append-only, so a concurrent append
					// from another session can at worst duplicate a seq number, never lose a row
					// (§3.3.3 puts the optimistic lock on discipline only). The leading newline
					// repairs a file whose last append was interrupted before its terminator.
					const prefix = existing.text === "" || existing.text.endsWith("\n") ? "" : "\n";
					try {
						await mkdir(paths.dir, { recursive: true });
						await appendFile(paths.decisions, `${prefix}${row}\n`, "utf8");
					} catch (error) {
						return wellFormed(`写入失败：decisions.md 写入出错（${describeError(error)}）。`);
					}
					return wellFormed([
						`已追加 decisions #${seq}（author=${author}）→ ${paths.decisions}`,
						"行格式：seq | ISO 时间 | author-session-id | 正文（seq 由插件分配、单调递增；只追加不删除）。",
						`单行上限 ${BLACKBOARD_LINE_LIMIT} 字符（本次 ${[...text.value].length} 字符，§4.1）。`,
					].join("\n"));
				}

				if (typeof args.line !== "string") return wellFormed("写入失败：discipline 需要 line（新的整份内容）。");
				const contentLines = args.line.split(/\r?\n/u);
				const tooLong = contentLines.findIndex((row) => [...row].length > BLACKBOARD_LINE_LIMIT);
				if (tooLong !== -1) return wellFormed(`写入失败：discipline 第 ${tooLong + 1} 行超过单行上限 ${BLACKBOARD_LINE_LIMIT} 字符（当前 ${[...contentLines[tooLong]].length} 字符；§4.1）。`);
				const baseHash = typeof args.baseHash === "string" ? args.baseHash.trim() : "";
				if (baseHash === "") return wellFormed("写入失败：discipline 是整文件替换，必须携带 team_link_team_read 返回的当前 baseHash（乐观锁，防双写覆盖）。");
				const existing = await readBlackboardFile(paths.discipline);
				if (existing.error !== undefined) return wellFormed(`写入失败：discipline.md 无法读取（${existing.error}）。`);
				const currentHash = blackboardHash(existing.text);
				if (baseHash !== currentHash) {
					return wellFormed(`写入失败：discipline baseHash 不匹配——文件已被其他会话改写（当前 baseHash=${currentHash}，你携带的是 ${baseHash}）。请重新 team_link_team_read 取回最新内容与 baseHash 后再写（乐观锁）。`);
				}
				try {
					await mkdir(paths.dir, { recursive: true });
					await writeFile(paths.discipline, args.line, "utf8");
				} catch (error) {
					return wellFormed(`写入失败：discipline.md 写入出错（${describeError(error)}）。`);
				}
				return wellFormed([
					`已替换 discipline.md（author=${author}）→ ${paths.discipline}`,
					`baseHash ${currentHash} → ${blackboardHash(args.line)}（下次替换必须携带新值）。`,
					`共 ${contentLines.length} 行；单行上限 ${BLACKBOARD_LINE_LIMIT} 字符（§4.1）。`,
				].join("\n"));
			} catch (error) {
				return wellFormed(`写入失败：${describeError(error)}`);
			}
		},
	})), "team-link: team append tool");
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

/** Register the M1 model-facing tools on the tools service: the listing with its
 * liveness rows, the export, the cross-session send and the watchdog (§3.1/§3.2). */
function registerTools(ctx, policy, watchdog) {
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_list_sessions",
		description: "列出当前工作区（同目录）的其他 DSH 会话：id、标题/主题摘要、运行状态、创建时间、最近动态，以及每个会话的活性信号行（verdict 五态：ok / goal-disarmed / silent-idle / long-running / dead，含 goal 状态与静默时长）；供跨会话导出、发送前查目标、或判断队友是否失联。读数是快照：行尾附读数时间戳，超过 2 分钟应重新读取。",
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
				// One surface read per listed session feeds both faces below: the
				// liveness signal (§3.1) needs the last assistant/inbound times and the
				// running turn's start, and the digest folds the same surface into a
				// topic + last-activity preview. A cold or unreadable log is not an
				// error here — both faces degrade to "unknown" and the row still lists.
				const surfaces = new Map();
				for (const record of shown) {
					try {
						surfaces.set(record.header.id, await ctx.sessionQuery.readSurface(record.header.id));
					} catch {
						/* liveness/digest are best-effort; cold or unreadable logs still list */
					}
				}
				const topics = new Map();
				const activities = new Map();
				for (const record of shown.slice(0, PREVIEW_SESSIONS)) {
					const surface = surfaces.get(record.header.id);
					if (surface === undefined) continue;
					const topic = firstSurfaceUserText(surface.events);
					if (topic !== undefined) topics.set(record.header.id, topic);
					const activity = lastSurfaceText(surface.events);
					if (activity !== undefined) activities.set(record.header.id, activity);
				}
				// One reading time for the whole listing: the liveness rows are a
				// snapshot, and every session row says when it was taken and when it
				// stops being trustworthy (§3.1 防偏离).
				const now = Date.now();
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
					lines.push(`- ${header.id}${origin} — ${state}${title !== undefined ? `「${title}」` : ""} · 创建于 ${new Date(header.createdAt).toLocaleString()}${other}（读数 ${readStamp(now)}，${READ_STALE_NOTE}）`);
					const topic = topics.get(header.id);
					if (topic !== undefined) lines.push(`    主题：${preview(topic, 90)}`);
					const activity = activities.get(header.id);
					if (activity !== undefined && activity !== topic) lines.push(`    最近：${preview(activity, 90)}`);
					const signal = buildLivenessSignal(ctx, header.id, { now, agent, surface: surfaces.get(header.id) });
					lines.push(`    活性：${livenessLine(signal)}`);
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

	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_watch",
		description: "跨会话看门狗（M1）：给自己注册盯人 —— 被盯会话出现失联征兆（verdict 为 silent-idle / goal-disarmed / dead）且你自己空闲且未处于 armed-active 节奏时，本插件向你自己的会话投递一条固定文案的 tick（你需自己判断是否催办/转派）。action：register（注册，只能给自己注册，targets 不能含自己）/ list（查看注册）/ clear（清除，幂等）。注册上限 3 个/会话；silentMinutes>=10、intervalMinutes>=5（默认 5）、TTL<=24h（默认 12h），到点自动清理。",
		parameters: {
			action: { type: "string", required: true, enum: ["register", "list", "clear"], description: "register / list / clear" },
			targets: { type: "array", items: { type: "string" }, description: "register：被盯会话 id 列表（不能包含自己）" },
			silentMinutes: { type: "integer", description: "register：失联阈值（分钟，>=10，默认 10）" },
			intervalMinutes: { type: "integer", description: "register：巡检间隔（分钟，>=5，默认 5）" },
			ttlHours: { type: "number", description: "register：注册有效期（小时，<=24，默认 12）" },
			id: { type: "string", description: "clear：要清除的注册 id（缺省 = 清除自己全部注册）" },
		},
		output: textOutput(),
		timeoutMs: 30000,
		async execute(args, exec) {
			const caller = agentSessionId(exec);
			if (caller === undefined || ctx.agents.get(caller) !== exec?.agent) {
				return "操作失败：看门狗注册需要可交互的活动代理（exec.agent.id）——看门狗只能给自己注册。";
			}
			const action = typeof args.action === "string" ? args.action : "";
			const now = Date.now();
			const current = policy.get().watchdogs;
			const own = current.filter((entry) => entry.watcherSession === caller);

			if (action === "register") {
				if (own.length >= WATCHDOG_MAX_PER_SESSION) {
					return wellFormed(`注册失败：单个会话最多 ${WATCHDOG_MAX_PER_SESSION} 个看门狗注册（当前 ${own.length} 个）。先用 team_link_watch clear 清理不再需要的注册。`);
				}
				const built = buildWatchdogRegistration({
					caller,
					now,
					targets: args.targets,
					silentMinutes: args.silentMinutes,
					intervalMinutes: args.intervalMinutes,
					ttlHours: args.ttlHours,
				});
				if (built.error !== undefined) return wellFormed(`注册失败：${built.error}`);
				const entry = built.value;
				try {
					await policy.update({ watchdogs: [...current, entry] });
				} catch (error) {
					return wellFormed(`注册失败：写入设置失败（${describeError(error)}）。`);
				}
				watchdog.schedule(entry);
				return wellFormed([
					`已注册看门狗 ${entry.id}：观察者 ${caller} 盯 ${entry.targets.join(", ")}。`,
					`阈值：静默 ${entry.silentMinutes}min · 巡检 ${entry.intervalMinutes}min · TTL ${((entry.expiresAt - now) / 3600000).toFixed(2)}h（到期 ${readStamp(entry.expiresAt)}）。`,
					"观察者空闲且目标出现 silent-idle / goal-disarmed / dead 时，插件会向你自己的会话投递 tick（同一目标一个静默期最多一次；TTL 到点自动清理）。",
				].join("\n"));
			}

			if (action === "list") {
				const lines = [`看门狗注册（共 ${current.length} 个，其中自己 ${own.length} 个）：`];
				if (current.length === 0) lines.push("（无）");
				for (const entry of current) {
					const watcherAgent = ctx.agents.get(entry.watcherSession);
					const watcherState = watcherAgent === undefined ? "未运行" : watcherAgent.status === "running" ? "运行中" : "空闲";
					const dead = watchdog.deadWatchers.has(entry.id) ? " · 观察者=dead（代理不存在，等待用户；注册保留至 TTL）" : "";
					lines.push(`- ${entry.id}${entry.watcherSession === caller ? " [自己]" : ""} — 观察者 ${entry.watcherSession}（${watcherState}${dead}）`);
					lines.push(`    目标：${entry.targets.length === 0 ? "（无）" : entry.targets.join(", ")}`);
					lines.push(`    阈值：静默 ${entry.silentMinutes}min · 巡检 ${entry.intervalMinutes}min · 到期 ${readStamp(entry.expiresAt)} · 团队 ${entry.team ?? "—"}`);
				}
				lines.push("", `（读数 ${readStamp(now)}，${READ_STALE_NOTE}）`);
				return wellFormed(lines.join("\n"));
			}

			if (action === "clear") {
				const wanted = typeof args.id === "string" && args.id !== "" ? args.id : undefined;
				const removable = wanted === undefined ? own : own.filter((entry) => entry.id === wanted);
				if (wanted !== undefined && removable.length === 0) {
					if (current.some((entry) => entry.id === wanted)) {
						return wellFormed(`清除失败：注册 ${wanted} 的观察者不是当前会话，只能清除自己的注册。`);
					}
					return wellFormed(`已清理 0 个注册（${wanted} 不存在或已清除；clear 幂等）。`);
				}
				try {
					await policy.update({ watchdogs: current.filter((entry) => !removable.includes(entry)) });
				} catch (error) {
					return wellFormed(`清除失败：写入设置失败（${describeError(error)}）。`);
				}
				for (const entry of removable) watchdog.cancel(entry.id);
				return wellFormed(wanted === undefined
					? `已清理自己的全部看门狗注册（${removable.length} 个）。`
					: `已清理看门狗注册 ${wanted}。`);
			}

			return "操作失败：action 必须是 register / list / clear。";
		},
	})), "team-link: watch tool");
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
	const watchdog = createWatchdog(ctx, policy);
	WATCHDOG_BY_CTX.set(ctx, watchdog);
	registerDeepLinks(ctx);
	registerTools(ctx, policy, watchdog);
	registerTeamTools(ctx, policy);
	registerExportRoute(ctx);
	// The patrol timers are this plugin's only background work, so they are armed
	// inside one effect: disposing the plugin (unload, reload, config teardown)
	// disposes every timer and the process-local tick state with it.
	ctx.effect(() => watchdog.start(), "team-link: watchdog patrol timers");
}

export { apply, inject, name };

/**
 * Internal surface for `host-half.test.mjs` only: the pure liveness/verdict
 * helpers, the live watchdog controller of a context, and the pure roster /
 * blackboard helpers of §3.3. Nothing else imports it — the model-facing surface
 * is exactly the registered tools.
 */
export const __testing = Object.freeze({
	verdictOf,
	buildLivenessSignal,
	readGoalSignal,
	buildWatchdogRegistration,
	tickMessage,
	watchdogFor: (ctx) => WATCHDOG_BY_CTX.get(ctx),
	normalizeTeams,
	writerGate,
	retireGate,
	applyTeamUpsert,
	applySetRole,
	applyRetire,
	tenureStartOf,
	renderRosterMirror,
	trustReferencesTo,
	readBlackboardLine,
	blackboardHash,
	lastDecisionSeq,
	decisionRow,
});
