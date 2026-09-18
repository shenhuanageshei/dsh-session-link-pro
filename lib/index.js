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
//  6. M3 (0.3.3) grows team_link_send into the §3.4 broadcast: an optional
//     `targets` fan-out (session id / team:<name>/<role> / coordinator-only
//     team:<name>/*, one full gate pass per target, ≤8 targets) and an optional
//     `meta` envelope rendered into the banner's first line (V10 keeps the
//     source at exactly three members). Delivery replies carry the §3.5 busy
//     prediction.
//  7. team_link_rotate — the M4 two-phase hand-over (§3.6): `prepare` mints a
//     one-time token bound to (team, role, successor), snapshots the trust state
//     for revocation and freezes the team; `claim` (only by the successor, only
//     with that token) migrates the in-team pairs through a single confirmation
//     dialog — or provisionally, with a 24h rollback, when nobody is there to
//     confirm — revokes the outgoing coordinator's trust symmetrically and
//     settles the roster. Expired tokens and provisional windows are swept by the
//     same patrol timer as the M1 watchdog (§3.6.2 评审 #4/#5).
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
 * while the export tool keeps working. `settings` and `webServer` are read
 * through that same runtime channel, but a single read at apply time is a
 * time-of-activation snapshot (cordis `ctx.get` only returns ACTIVE providers,
 * §9.1.2) — so both are re-tried after activation via `ctx.inject([...])`, the
 * policy store additionally retries lazily on every `get()`/`update()`, and any
 * failure to attach leaves a log line instead of degrading silently
 * (§9.1.3 / §5.3). */
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
/** Cap on sessions given a surface read — the topic/activity digest AND the §3.1
 * liveness signal both fold the same surface. One cold log costs a zstd
 * decompression plus a surface projection, so the list tool reads a bounded
 * window and the rows past it say so instead of showing a verdict computed from
 * nothing (see {@link LV_WINDOW_NOTE}). */
const PREVIEW_SESSIONS = 12;
/** Liveness line of a row outside that window: the readings below it are a
 * snapshot of a BOUNDED read, so an unread row labels itself unread rather than
 * omitting the line or printing a verdict with no surface behind it. The row
 * itself still lists (id, agent state, creation time, provisional marks). */
const LV_WINDOW_NOTE = `未读（超出快照窗口 ${PREVIEW_SESSIONS}）—— 本行未读取会话日志：verdict / 静默时长 / goal / 主题 / 最近动态均未判定（代理状态见该行的运行标志）。`;
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
	/** M4 (§3.6.2): timestamp of the last COMPLETED rotation of this role — the
	 * second half of the ten-minute anti-storm window (rateLimit(team, role, 10min)),
	 * the half a live pending cannot express. */
	rotationAt: z.number().default(0),
	/** M4 (§3.6.2 评审 #5): the open ratification window of an unconfirmed
	 * rotation — {at, expiresAt} — or null once ratified or rolled back. */
	provisional: z.any().default(null),
	/** M4 (§3.6.2 评审 #10): the verdict word the last settled rotation recorded
	 * — 已批准 / 待批准(24h) / 无待迁移对. Declared here on purpose, for the same
	 * reason the pair fields are: this namespace round-trips through the schema,
	 * so a field it does not declare is stripped and the replay would fall back to
	 * re-deriving the word from state that cannot tell a dialog answered with
	 * nothing checked from a rotation that never had a candidate. */
	rotationStatus: z.string().default(""),
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
	/** M4 (§3.6.2): the pre-rotation snapshot a prepare takes
	 * ({at, pairs, trustedSenders, rememberTargets, roster}) — the evidence a
	 * symmetric revocation is rolled back against by hand. */
	rotationBackup: z.any().default(null),
});

const PolicyConfig = z.object({
	receiveMode: z.string().default("ask"),
	trustedSenders: z.array(z.string()).default([]),
	blockedSenders: z.array(z.string()).default([]),
	rememberTargets: z.array(z.string()).default([]),
	// M4 (§3.6.2): a pair migrated by a rotation may be PROVISIONAL — granted
	// without a present user and revoked automatically when the ratification
	// window closes. Both fields are declared here on purpose: the settings
	// namespace round-trips through this schema, so a pair field the schema does
	// not declare would be stripped by the settings provider and the TTL would
	// silently become permanent trust.
	pairs: z.array(z.object({
		a: z.string(),
		b: z.string(),
		createdAt: z.number().default(0),
		provisional: z.boolean().default(false),
		expiresAt: z.number().default(0),
	})).default([]),
	watchdogs: z.array(WatchdogConfig).default([]),
	teams: z.array(TeamConfig).default([]),
});

/** Coerce any stored/patched value into a complete, well-typed policy view. */
function normalizePolicy(value) {
	const stringList = (list) => Array.isArray(list) ? list.filter((item) => typeof item === "string") : [];
	const pairList = (list) => Array.isArray(list) ? list.filter((pair) => typeof pair?.a === "string" && typeof pair?.b === "string").map((pair) => ({
		a: pair.a,
		b: pair.b,
		createdAt: typeof pair.createdAt === "number" ? pair.createdAt : 0,
		provisional: pair.provisional === true,
		expiresAt: typeof pair.expiresAt === "number" && Number.isFinite(pair.expiresAt) ? pair.expiresAt : 0,
	})) : [];
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
	const expiresAt = typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) ? value.expiresAt : 0;
	const pending = {
		session,
		token,
		team: typeof value.team === "string" ? value.team : "",
		role: typeof value.role === "string" ? value.role : "",
		expiresAt,
		// The anti-storm window needs to know when this pending was minted; a
		// hand-written row without it is dated from its TTL (the invariant
		// expiresAt = createdAt + ROTATION_TTL_MS holds for every row we write).
		createdAt: typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : Math.max(0, expiresAt - ROTATION_TTL_MS),
	};
	if (typeof value.note === "string" && value.note !== "") pending.note = value.note;
	// The idempotency marker of §3.6.2: the pairs this claim already migrated.
	// Non-empty ⇒ a previous claim got as far as the marker, so a retry replays
	// the recorded list instead of migrating twice.
	if (Array.isArray(value.migratedPairs)) pending.migratedPairs = value.migratedPairs.filter((pair) => pair !== null && typeof pair === "object" && typeof pair.a === "string" && typeof pair.b === "string").map((pair) => ({
		a: pair.a,
		b: pair.b,
		createdAt: typeof pair.createdAt === "number" && Number.isFinite(pair.createdAt) ? pair.createdAt : 0,
		provisional: pair.provisional === true,
		expiresAt: typeof pair.expiresAt === "number" && Number.isFinite(pair.expiresAt) ? pair.expiresAt : 0,
	}));
	return pending;
}

/** Normalized M4 ratification window of one role (§3.6.2 评审 #5), or null. */
function normalizeProvisional(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const expiresAt = typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) ? value.expiresAt : 0;
	if (expiresAt <= 0) return null;
	return {
		at: typeof value.at === "number" && Number.isFinite(value.at) ? value.at : 0,
		expiresAt,
		session: typeof value.session === "string" ? value.session : "",
	};
}

/** Normalized M4 revocation snapshot of one team (§3.6.2), or null. */
function normalizeRotationBackup(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const snapshot = {
		at: typeof value.at === "number" && Number.isFinite(value.at) ? value.at : 0,
		pairs: Array.isArray(value.pairs) ? value.pairs.filter((pair) => typeof pair?.a === "string" && typeof pair?.b === "string").map((pair) => ({ a: pair.a, b: pair.b, createdAt: typeof pair.createdAt === "number" ? pair.createdAt : 0, provisional: pair.provisional === true, expiresAt: typeof pair.expiresAt === "number" ? pair.expiresAt : 0 })) : [],
		trustedSenders: Array.isArray(value.trustedSenders) ? value.trustedSenders.filter((id) => typeof id === "string") : [],
		rememberTargets: Array.isArray(value.rememberTargets) ? value.rememberTargets.filter((id) => typeof id === "string") : [],
		roster: value.roster === null || typeof value.roster !== "object" ? null : value.roster,
	};
	return snapshot;
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
			rotationAt: typeof entry.rotationAt === "number" && Number.isFinite(entry.rotationAt) ? entry.rotationAt : 0,
			provisional: normalizeProvisional(entry.provisional),
			rotationStatus: typeof entry.rotationStatus === "string" ? entry.rotationStatus : "",
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
			rotationBackup: normalizeRotationBackup(entry.rotationBackup),
		});
	}
	return teams;
}

/** True when the two sessions share an approved auto-relay pair that is still
 * live at `now` — see {@link pairRecordBetween} for the expiry rule. */
function pairBetween(view, a, b, now = Date.now()) {
	return pairRecordBetween(view, a, b, now) !== null;
}

/** §3.6.2 评审 #8 (防御纵深): a rotation-granted pair whose 24h ratification
 * window has run out is already back on the ordinary gates — the sweep deletes
 * the row, but between the deadline and the next sweep the row must not keep
 * granting a channel that bypasses both approval gates, or the "24h 自动回退"
 * promise would be silently false for exactly that window. */
function isExpiredProvisionalPair(pair, now) {
	return pair.provisional === true && pair.expiresAt > 0 && pair.expiresAt <= now;
}

/** The LIVE pair record joining two sessions, or null. The record (not just the
 * boolean) is what the M4 provisional face needs: a rotation may have granted
 * the channel without a present user, and the sender has to be told that this
 * delivery rides a channel with a 24h rollback (§3.6.2 评审 #3).
 *
 * 评审 #8: an expired provisional record counts as NO pair (the delivery side
 * stops honouring the channel at its deadline, not only when the sweep happens
 * to run), and a live record wins over an expired one — a pairing created after
 * the deadline must never be shadowed by the dead row it superseded. */
function pairRecordBetween(view, a, b, now = Date.now()) {
	const matches = view.pairs.filter((pair) => (pair.a === a && pair.b === b) || (pair.a === b && pair.b === a));
	return matches.find((pair) => !isExpiredProvisionalPair(pair, now)) ?? null;
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
 *
 * §9.1.3: the read is NOT a one-shot snapshot. cordis `ctx.get` returns only
 * providers whose fiber is already active, and the settings provider finishes
 * its `[Service.init]` (load from disk → publish) asynchronously — so an
 * apply-time read can legitimately come back `undefined` and used to switch
 * this store to memory **silently and forever** (teams / watchdogs / pairs
 * never reaching `settings.yaml`). The three-part fix: try once immediately
 * (the fast path: a synchronous provider, tests included), otherwise leave one
 * warn and wait for the provider through the OPTIONAL `ctx.inject(["settings"],
 * cb)` — ordered but not a hard dependency, so a host without settings still
 * loads this plugin — and retry lazily on every `get()` / `update()`. The warn
 * is emitted at most once: no second silent fallback, and no warn storm either
 * (§5.3 红线).
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
	const memory = structuredClone(DEFAULT_POLICY);
	/** Registered settings scopes; `scope !== null` means "attached". */
	let scope = null;
	let legacyScope = null;
	/** The activation-window warn is written once and never repeated, so the
	 * lazy retries below cannot turn into a warn storm (U11: 有且仅有一行). */
	let attachWarned = false;
	/** Set when a write landed in process memory — i.e. inside the startup
	 * window, before the store could attach (§9.1.3 数据一致性). */
	let memoryDirty = false;

	/**
	 * The live view: settings once attached, process memory before that. A call
	 * that finds the store unattached is the third retry hook of §9.1.3 — a tool
	 * call (or the watchdog tick) is the earliest moment a provider that came up
	 * late can be picked up without a fiber of our own.
	 */
	function get() {
		if (scope === null) attachFrom(ctx);
		try {
			return normalizePolicy(scope !== null ? scope.get() : memory);
		} catch {
			return normalizePolicy(memory);
		}
	}

	/** Mirror of {@link get} on the write side: retry, then write through the
	 * attached scope or into process memory (the startup-window fallback). */
	async function update(patch) {
		if (scope === null) attachFrom(ctx);
		if (scope !== null) {
			await scope.update(patch);
			return;
		}
		memoryDirty = true;
		for (const [key, value] of Object.entries(patch)) memory[key] = structuredClone(value);
	}

	/**
	 * One-time rename migration: when the legacy namespace (this plugin's
	 * identity before 0.3.0) still carries data and the current namespace
	 * is at defaults, copy everything over and reset the legacy namespace
	 * to base so the migration never repeats. Both non-default → the user
	 * already diverged under the new name; current wins, legacy kept.
	 *
	 * §9.1.3: called from {@link attach}, i.e. only once the current namespace
	 * really exists. At apply time this is a guaranteed no-op (nothing is
	 * registered yet), which is why the call site moved.
	 */
	async function migrateLegacyPolicy() {
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
		const current = get();
		const currentIsDefault = current.pairs.length === 0 && current.trustedSenders.length === 0
			&& current.blockedSenders.length === 0 && current.rememberTargets.length === 0
			&& current.receiveMode === DEFAULT_POLICY.receiveMode;
		if (!currentIsDefault) {
			ctx.logger?.info?.(`${PLUGIN_LABEL}: legacy policy namespace "${LEGACY_POLICY_NAMESPACE}" still holds data; kept untouched (current namespace already in use)`);
			return;
		}
		try {
			await update({
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
	}

	/**
	 * Attach the store to one settings service (§9.1.3). Idempotent: the first
	 * successful attach wins and everything after it is a no-op. A provider that
	 * refuses `register` leaves the store memory-only — with a warn, never
	 * silently.
	 */
	function attach(settings) {
		if (scope !== null) return;
		try {
			scope = settings.register(POLICY_NAMESPACE, PolicyConfig, { base: structuredClone(DEFAULT_POLICY) });
		} catch (error) {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: settings register failed (${describeError(error)}) — 状态仅存进程内存`);
			return;
		}
		try {
			legacyScope = settings.register(LEGACY_POLICY_NAMESPACE, PolicyConfig, { base: structuredClone(DEFAULT_POLICY) });
		} catch {
			legacyScope = null; // legacy namespace is best-effort only
		}
		ctx.logger?.info?.(`${PLUGIN_LABEL}: policy store attached to settings namespace "${POLICY_NAMESPACE}"`);
		// §9.1.3 调用点迁移：the one-time legacy migration is driven from here, not
		// from apply — before the attach there is no current namespace to compare
		// the legacy one against (at apply time the call was a guaranteed no-op).
		// The order matters: any write made during the memory-only window is folded
		// in FIRST, so the migration's "current namespace already in use?" test
		// sees the final state and cannot overwrite newer data with legacy data.
		void adoptMemoryWindow()
			.then(() => migrateLegacyPolicy())
			.catch(() => { /* logged inside */ });
	}

	/**
	 * §9.1.3 数据一致性（防御性冗余）: the memory engine can only be written inside
	 * the startup window — before the attach, and in practice before any agent
	 * exists to call a tool. Should it nevertheless happen, the write must not be
	 * silently dropped when settings finally arrives: fold it in under the same
	 * rule as the legacy migration (only while the settings namespace is still at
	 * defaults — settings stays the source of truth), and say so in one line.
	 */
	async function adoptMemoryWindow() {
		if (!memoryDirty) return;
		const current = get();
		const currentIsDefault = current.pairs.length === 0 && current.trustedSenders.length === 0
			&& current.blockedSenders.length === 0 && current.rememberTargets.length === 0
			&& current.receiveMode === DEFAULT_POLICY.receiveMode
			&& current.watchdogs.length === 0 && current.teams.length === 0;
		if (!currentIsDefault) return;
		try {
			await update({
				receiveMode: memory.receiveMode,
				trustedSenders: [...memory.trustedSenders],
				blockedSenders: [...memory.blockedSenders],
				rememberTargets: [...memory.rememberTargets],
				pairs: [...memory.pairs],
				watchdogs: [...memory.watchdogs],
				teams: [...memory.teams],
			});
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: policy store attached with writes from the memory-only startup window — 这些写入已并入设置命名空间 "${POLICY_NAMESPACE}"（该窗口理论不可达，本次确实发生了）`);
		} catch (error) {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: failed to fold the memory-only startup window into settings (${describeError(error)}) — 窗口内的写入仍在进程内存里，本次未能落盘`);
		}
	}

	/** Attach from whatever one context can hand over right now. Never throws,
	 * never logs: `undefined` just means "not (yet) available here". */
	function attachFrom(target) {
		if (scope !== null) return true;
		const settings = target.get?.("settings");
		if (settings !== undefined && typeof settings.register === "function") {
			attach(settings);
			return true;
		}
		return false;
	}

	// ① Fast path — a provider that is already active (or a synchronous stub).
	if (!attachFrom(ctx)) {
		// ② Not there yet: leave exactly one line (§5.3 红线: 不得静默失效) and
		// register the optional ordered injection. `ctx.inject` is not a hard
		// dependency: when the service never appears, this plugin still loads and
		// runs on the memory engine.
		const immediate = ctx.get?.("settings");
		if (!attachWarned) {
			attachWarned = true;
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: settings not active at activation (${immediate === undefined ? "not yet active" : "no register()"}) — memory-only until it attaches; no persistence meanwhile`);
		}
		if (typeof ctx.inject === "function") {
			ctx.inject(["settings"], (child) => { attachFrom(child); });
		} else {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: ctx.inject unavailable — 依赖首次工具调用时的惰性重试兜底`);
		}
	}
	// ③ 惰性兜底 lives in get()/update() above: retry silently, attach on
	//    success (one info line), and never repeat the activation warn.

	return { get, update, migrateLegacyPolicy };
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
function createWatchdog(ctx, policy, rotation) {
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
		// §3.6.2 评审 #4: the M4 expiry sweep rides this same patrol timer — one
		// background timer for both jobs, and it dies with the plugin. The timer only
		// exists per registration (§3.2.4), so the roster/rotate/team-read lazy calls
		// are what keep a team without a single watchdog from staying frozen.
		await runRotationSweep(now);
	}

	/** Best-effort M4 sweep: a sweep failure is logged, never a patrol failure. */
	async function runRotationSweep(now) {
		if (rotation === null || rotation === undefined || typeof rotation.sweep !== "function") return;
		try {
			await rotation.sweep({ now });
		} catch (error) {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: rotation sweep failed: ${describeError(error)}`);
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

/** Role name reading: non-empty, bounded, free of control characters, and never
 * the addressing grammar's reserved word — a role name is stored in settings,
 * rendered as a markdown heading AND is a path segment of `team:<name>/<role>`.
 * A role literally named `*` would make `team:<name>/*` ambiguous: the wildcard
 * branch of §3.4 is matched first, so the role could never be addressed (R6, M3
 * review). */
function readRoleName(value) {
	if (typeof value !== "string" || value.trim() === "") return { error: "需要 role（角色名；约定角色名 coordinator）。" };
	const role = value.trim();
	if (role === "*") return { error: "角色名不能是 *（寻址文法保留字：team:<name>/* 表示全队广播，§3.4；以 * 命名的角色永远无法被点对点寻址）。" };
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

/**
 * One role record in the canonical field order of {@link normalizeRoles}. Every
 * internal constructor goes through here: a stored row must round-trip through
 * normalize → write → normalize without changing shape (the U4 idempotency
 * assertion compares the stored JSON), and that includes the M4 fields a caller
 * may not have thought about.
 */
function roleRecord(fields) {
	return {
		role: fields.role,
		current: fields.current ?? null,
		pending: fields.pending ?? null,
		rotationAt: typeof fields.rotationAt === "number" && Number.isFinite(fields.rotationAt) ? fields.rotationAt : 0,
		provisional: fields.provisional ?? null,
		rotationStatus: typeof fields.rotationStatus === "string" ? fields.rotationStatus : "",
		history: fields.history ?? [],
	};
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
 *
 * §3.3.2「创建即认领」(§9.2.2): a team created through this tool seeds its
 * `coordinator` role with the CREATING session as the incumbent, inside the same
 * write. The creation path deliberately does not pass `writerGate` (bootstrap
 * has to be reachable), while `writerGate` refuses every session path once the
 * coordinator is vacant — so without this seed a tool-created team would be born
 * un-writable and M2–M4 would be unreachable from the tool surface. It happens
 * only on creation, only for the session doing the creating; `request.coordinator`
 * is absent for an existing team (whose roles this function never touches), so
 * upsert-team stays idempotent and non-incumbents still cannot hijack a team.
 */
function applyTeamUpsert(teams, request) {
	const { name, workspace, now } = request;
	const existing = teams.find((team) => team.name === name) ?? null;
	if (existing === null) {
		const coordinator = typeof request.coordinator === "string" && request.coordinator !== "" ? request.coordinator : null;
		// `roleRecord` writes the canonical row (every TeamRoleConfig field
		// explicit), so a seeded roster round-trips through settings exactly like
		// one that set-role built.
		const roles = coordinator === null ? [] : [roleRecord({
			role: COORDINATOR_ROLE,
			current: coordinator,
			history: [{ session: coordinator, from: now, until: null, note: "创建者自举" }],
		})];
		// Every field the schema declares is written explicitly: this object may go
		// straight into renderRosterMirror, which reads team.rotationBackup.
		const team = { name, createdAt: now, workspace, policy: { writer: "coordinator" }, roles, rotationBackup: null };
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
 * the rotation token — and a set-role that seats a rotation's PREPARED successor
 * clears that pending instead (评审 #9, see below): the token may not survive an
 * explicit change of identity, or the successor's own claim would read it as an
 * already-settled rotation and skip the symmetric revocation.
 * @returns `{ team, previous, clearedPending }` — `clearedPending` is true when
 *   this call invalidated an in-flight rotation token.
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
	// rotationAt/provisional ride along untouched: set-role换的是身份，不是换届
	// 记账（那些字段属于 M4 的 rotation 流程）。
	const next = existing === null
		? { role, current: session, history, pending: null }
		: { ...existing, current: session, history };
	// §3.6.2 评审 #9: seating the very session a rotation PREPARED as successor
	// invalidates that token. The pending survives otherwise, and the successor's
	// later claim then reads `current === pending.session` as "the previous claim
	// already settled" and replays: it would report the hand-over as landed while
	// the symmetric revocation (the retiree's pairs/trustedSenders/rememberTargets)
	// never ran — leaving the old coordinator's 免门通道 alive — and the claim path
	// would skip it silently. Identity changed by an explicit writer action, so the
	// token dies here and the claim hits the ordinary "没有 pending" refusal.
	const clearedPending = existing !== null && existing.pending !== null && existing.pending !== undefined && existing.pending.session === session;
	if (clearedPending) next.pending = null;
	const record = roleRecord(next);
	const roles = existing === null
		? [...team.roles, record]
		: team.roles.map((entry) => (entry.role === role ? record : entry));
	return { team: { ...team, roles }, previous, clearedPending };
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
 * next roster change. A pending rotation token is rendered MASKED (first four /
 * last four characters): the mirror is a file on disk, and the full token is
 * handed out exactly once, in the `prepare` result (§3.6.2 评审 #3). */
function renderRosterMirror(team) {
	const lines = [
		`# 团队 roster：${team.name}`,
		"",
		`- 生成时间：${localStamp()}`,
		`- 创建时间：${readStamp(team.createdAt)}`,
		`- workspace：${team.workspace === "" ? "（未捕获）" : team.workspace}`,
		`- policy.writer：${team.policy.writer}（coordinator=仅现任协调者会话可写；any=任何会话可写）`,
		"- 事实源：设置命名空间 `team-link` 的 `teams` 键；本文件由 dsh-team-link 与设置变更同一事务内 best-effort 镜像，读以 settings 为准。",
	];
	if (team.rotationBackup !== null) {
		lines.push(`- 换届撤销快照（rotationBackup）：${readStamp(team.rotationBackup.at)} 时的 pairs ${team.rotationBackup.pairs.length} 条 / trustedSenders ${team.rotationBackup.trustedSenders.length} 项 / rememberTargets ${team.rotationBackup.rememberTargets.length} 项（对称撤销的还原依据）。`);
	}
	lines.push(
		"",
		"## 角色",
		"",
	);
	if (team.roles.length === 0) lines.push("（无角色：用 team_link_roster action=set-role 指定现任）", "");
	for (const entry of team.roles) {
		lines.push(`### ${entry.role}`, "");
		lines.push(`- 现任：${entry.current === null ? "空缺（vacant）" : `${entry.current}（自 ${readStamp(tenureStartOf(entry, team))}）`}`);
		lines.push(`- pending：${entry.pending === null ? "（无）" : `${entry.pending.session}（token ${maskToken(entry.pending.token)}（掩码；完整令牌只在 prepare 的一次性返回里），创建 ${readStamp(entry.pending.createdAt)}，到期 ${readStamp(entry.pending.expiresAt)}，team=${entry.pending.team} role=${entry.pending.role}，已迁移 ${entry.pending.migratedPairs === undefined ? 0 : entry.pending.migratedPairs.length} 条）`}`);
		lines.push(`- provisional：${entry.provisional === null ? "（无）" : `${entry.provisional.session === "" ? "" : `${entry.provisional.session} 的 `}信任迁移待批准（自 ${readStamp(entry.provisional.at)}，${readStamp(entry.provisional.expiresAt)} 到期未批准则自动回退）`}`);
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
function registerTeamTools(ctx, policy, rotation) {
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_roster",
		description: "团队角色注册表（roster，M2）：团队 -> 角色 -> 会话，含版本史。action：get（任何会话可读：全体团队概要 + 指定 team 详情含 history）/ upsert-team（创建或幂等更新；团队名 [a-z0-9-]+；**创建时把调用会话播种为 coordinator 现任**（创建即认领：否则 policy.writer=coordinator 下的空缺团队谁都写不进）；已存在时只有 policy 属于可更新面，roles/history 原样保留，本工具无 policy 参数，故 policy 由用户经设置 UI 修改）/ set-role（换现任：current 替换 + history 追加，旧任记录 until=now；不迁移 pairs——那是 M4 rotation 的专属动作）/ retire（退役：仅现任协调者会话发起，current 置空 + history 记退役；随后可选一个用户确认对话框清理指向退役会话的 pairs/trustedSenders/rememberTargets）。写权限：policy.writer=coordinator 时只有该团队 coordinator 角色的现任会话可写，现任空缺时会话路径一律拒绝（用户经设置 UI 永远是超级写者）；writer=any 时任何会话可写。",
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
				// §3.6.2 评审 #4 (「定时 + roster 触碰时懒检查」): every roster touch is a
				// moment a stranded rotation token or an unratified provisional window
				// would be noticed, so the sweep runs here too — awaited, so it can
				// never race this call's own settings write.
				const swept = await rotation.sweep({ now: Date.now(), signal: exec.signal });
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
						lines.push(`- 换届撤销快照（rotationBackup）：${team.rotationBackup === null ? "（无）" : `${readStamp(team.rotationBackup.at)} 时的 pairs ${team.rotationBackup.pairs.length} 条 / trustedSenders ${team.rotationBackup.trustedSenders.length} 项 / rememberTargets ${team.rotationBackup.rememberTargets.length} 项`}`);
						for (const entry of team.roles) {
							lines.push(`- 角色 ${entry.role}：${entry.current === null ? "空缺（vacant）" : `现任 ${entry.current}（自 ${readStamp(tenureStartOf(entry, team))}）`}`);
							lines.push(`    pending：${entry.pending === null ? "（无）" : `${entry.pending.session}（token ${maskToken(entry.pending.token)}（掩码——完整令牌只在 prepare 的一次性返回里给出），创建 ${readStamp(entry.pending.createdAt)}，到期 ${readStamp(entry.pending.expiresAt)}，绑定 team=${entry.pending.team} role=${entry.pending.role}，已迁移 ${entry.pending.migratedPairs === undefined ? 0 : entry.pending.migratedPairs.length} 条）`}`);
							lines.push(`    provisional：${entry.provisional === null ? "（无）" : `${entry.provisional.session === "" ? "" : `${entry.provisional.session} 的 `}信任迁移待批准（自 ${readStamp(entry.provisional.at)}，${readStamp(entry.provisional.expiresAt)} 到期未批准则自动回退为过门投递）`}`);
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
					if (swept.lines.length > 0) lines.push("", "换届过期清扫（本次 roster 读取触发）：", ...swept.lines);
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
					// §3.3.2 创建即认领: the creation path seeds `caller` as the
					// coordinator incumbent, so the team is writable the moment it
					// exists. An existing team ignores `coordinator` entirely.
					const applied = applyTeamUpsert(teams, { name: name.value, workspace: agentCwd(exec), now, coordinator: caller });
					try {
						await policy.update({ teams: applied.teams });
					} catch (error) {
						return wellFormed(`创建/更新失败：写入设置失败（${describeError(error)}）。`);
					}
					const mirror = await writeRosterMirror(applied.team);
					const lines = [
						applied.created
							? `已创建团队 ${applied.team.name}：policy.writer=coordinator，coordinator 已由创建会话 ${caller} 认领（创建即认领，§3.3.2 bootstrap），workspace=${applied.team.workspace}（自执行会话 agentCwd 捕获）。`
							: `团队 ${applied.team.name} 已存在：upsert-team 幂等——roles / 版本史 / createdAt / policy 均未改动${applied.capturedWorkspace ? `（仅补记首次捕获的 workspace=${applied.team.workspace}）` : ""}。`,
						`现状：policy.writer=${applied.team.policy.writer} · 角色 ${applied.team.roles.length} 个 · 创建于 ${readStamp(applied.team.createdAt)}。`,
						mirrorNote(mirror),
					];
					if (applied.created) lines.push("下一步：直接开始协作（team_link_team_append 写黑板 / team_link_send 派活），用 action=set-role 增补其它角色；换届走 team_link_rotate。注意 policy.writer=coordinator 下只有现任协调者会话可写——创建者现在就是现任，若要交给别的会话，请在交班时用 action=set-role 显式指定。");
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
						// §3.6.2 评审 #9: seating the rotation's own successor kills that
						// token, and the successor has to hear it here — otherwise its later
						// claim just says「没有 pending」with no visible reason.
						...(applied.clearedPending
							? [`已作废在飞令牌：本次指定的会话正是换届 pending 的继任者（${session.value}）——身份已由本次显式变更，令牌失效、冻结随之解除；该换届不再可能用原令牌 claim（claim 会报「没有 pending」）。要重建信任迁移请由现任重新 prepare。`]
							: []),
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
										{ label: "清理", description: "删除上面列出的、指向退役会话的 pairs / trustedSenders / rememberTargets（对话框打开期间新增的信任引用不受影响）" },
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
								// R1 (M2 review): the dialog spans an unbounded human wait, so the
								// reference list collected BEFORE it is a display artifact, not the
								// write basis — writing `view` back would silently drop every pair and
								// trust entry created while the dialog was open. Re-read the store and
								// remove only the references the dialog listed AND that are still
								// present, which shrinks the read-modify-write window from the length
								// of the dialog to this synchronous block.
								const latest = policy.get();
								const listedPairs = new Set(references.pairs.map((pair) => `${pair.a}\n${pair.b}\n${pair.createdAt}`));
								const pairs = latest.pairs.filter((pair) => !listedPairs.has(`${pair.a}\n${pair.b}\n${pair.createdAt}`));
								const trustedSenders = latest.trustedSenders.filter((id) => !references.trustedSenders.includes(id));
								const rememberTargets = latest.rememberTargets.filter((id) => !references.rememberTargets.includes(id));
								await policy.update({ pairs, trustedSenders, rememberTargets });
								lines.push(`已清理：${latest.pairs.length - pairs.length} 个 pairs / ${latest.trustedSenders.length - trustedSenders.length} 个 trustedSenders / ${latest.rememberTargets.length - rememberTargets.length} 个 rememberTargets（按最新设置视图过滤：对话框里列出、期间已被其它变更删掉的引用不再计入；对话框期间新增的信任引用不受影响）。`);
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
		description: "读团队黑板（M2，§3.3.3）：读取前先跑一次换届过期清扫（过期的 pending / provisional 窗口不因没人注册看门狗而漏），再返回 roster 概要 + decisions.md 末 20 条 + discipline.md 全文 + 各文件 baseHash（decisions 的**仅供参考/审计**——decisions 只追加、不接受 baseHash 参数；discipline 的供整文件替换的乐观锁使用）。任何会话可读；写黑板没有权限门，但读要一次读齐省轮次。文件不存在按空处理并如实标注。黑板根目录 = <team.workspace>/team/<name>/（workspace 在团队首次创建时从会话 agentCwd 捕获）。",
		parameters: {
			team: { type: "string", required: true, description: "团队名（须已在 roster 中注册）" },
		},
		output: textOutput(),
		timeoutMs: 30000,
		async execute(args, exec) {
			try {
				// §3.6.2 评审 #4/#7: the lazy half of the expiry sweep — a team frozen
				// by a stranded token (or holding an unratified provisional window) also
				// gets its notice when somebody reads the board, not only on a roster
				// touch or a watchdog patrol. The pass is awaited so the lines below
				// describe the post-sweep roster.
				await rotation.sweep({ now: Date.now(), signal: exec?.signal });
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
					? `共 ${rows.length} 条，显示 ${shown.length} 条 · baseHash=${decisionsHash}（仅供参考/审计：decisions 只追加、不接受 baseHash 参数）`
					: `（文件不存在，按空处理：0 条）baseHash=${decisionsHash}（空内容哈希；仅供参考/审计）`);
				for (const row of shown) lines.push(row);
				lines.push("", "--- discipline.md（整文件替换，带 baseHash 乐观锁）---");
				lines.push(discipline.exists ? `baseHash=${disciplineHash}（乐观锁：整文件替换必须携带此值）` : `（文件不存在，按空处理）baseHash=${disciplineHash}（空内容哈希；乐观锁：整文件替换必须携带此值）`);
				lines.push(discipline.text === "" ? "（空）" : discipline.text);
				lines.push("", `单行上限 ${BLACKBOARD_LINE_LIMIT} 字符（§4.1）。写黑板用 team_link_team_append：file=decisions 只追加（无需 baseHash，seq 由插件分配——上面的 decisions baseHash 仅供参考/审计）；file=discipline 整文件替换（必须携带上面的 discipline baseHash，那是唯一的乐观锁）。`);
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

/**
 * Register the M4 tool: the two phases of a rotation (§3.6.2). Kept in its own
 * registration (rather than folded into the M2 roster tool) because the two
 * phases have different actors, different preconditions and a token.
 */
function registerRotationTools(ctx, policy, rotation) {
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_rotate",
		description: "团队换届（M4，两阶段）。action=prepare（Phase A，只能由该角色的现行会话发起）：生成一次性令牌（绑定 team+role+successor，30 分钟有效）、把待迁移的信任状态快照进 rotationBackup（撤销依据）、向全队广播 rotation-freeze 固定冻结清单，并返回交接指引（令牌只在这里出现一次，此后一律掩码 tok-xxxx…yyyy）。action=claim（Phase B，只能由 pending 指定的继任者会话凭令牌发起）：单个确认对话框列出全部「退役者↔同 team 成员」的 pairs 供逐项勾选（无人值守/超时/无确认服务 → 全部以 provisional 迁移，24h 内未批准自动回退）；迁移成功后对称吊销退役者的 pairs/trustedSenders/rememberTargets，落定 roster（current=新任、版本史追加），广播 rotation-done，并清除 pending。令牌过期未认领由过期清扫自动取消（广播 rotation-cancelled，旧任仍为 current，解除冻结）。域限定：团队外的 pairs 与未勾选的 pairs 一律随退役清理、不迁移；claim 幂等（同一令牌重放返回既有迁移清单、不重复迁移，判据是 current 已是继任者——域内没有候选 pair 时迁移清单本就是空的，同样走重放）。10 分钟速率限制防换届风暴。",
		parameters: {
			action: { type: "string", required: true, enum: ["prepare", "claim"], description: "prepare（Phase A：现任发起，出令牌 + 广播冻结）/ claim（Phase B：继任者凭令牌认领）" },
			team: { type: "string", required: true, description: "团队名（[a-z0-9-]+，须已在 roster 中）" },
			role: { type: "string", required: true, description: "要换届的角色名（约定角色名 coordinator）" },
			successor: { type: "string", description: "prepare 必填：继任者会话 id（令牌绑定 (team, role, successor) 三元组；须由该会话自己 claim）" },
			token: { type: "string", description: "claim 必填：prepare 返回的一次性令牌（掩码形式 tok-xxxx…yyyy 不是令牌）" },
			note: { type: "string", description: "写入版本史的备注（记在旧任任期的 until 记录上）；prepare 时给出则随 pending 保存，claim 时可直接覆盖" },
		},
		output: textOutput(),
		// The claim dialog may legitimately wait ROTATION_CONFIRM_TIMEOUT_MS (3min)
		// for a present user; the tool timeout has to sit above it.
		timeoutMs: 300000,
		async execute(args, exec) {
			try {
				const action = typeof args.action === "string" ? args.action : "";
				if (!ROTATION_ACTIONS.has(action)) return "操作失败：action 必须是 prepare 或 claim。";
				const name = readTeamName(args.team);
				if (name.error !== undefined) return wellFormed(`换届失败：${name.error}`);
				const role = readRoleName(args.role);
				if (role.error !== undefined) return wellFormed(`换届失败：${role.error}`);
				const caller = agentSessionId(exec);
				const now = Date.now();
				// The lazy half of the expiry sweep (§3.6.2 评审 #4). A claim excludes its
				// own team+role so that an expired token still gets its specific refusal
				// (and its cancellation) from the claim path below.
				const swept = await rotation.sweep({
					now,
					signal: exec.signal,
					// A claim must not sweep AWAY the very pending it is about to
					// validate: that one is handled (and reported specifically) by claim.
					except: action === "claim" ? { team: name.value, role: role.value } : null,
				});
				const preamble = swept.lines.length === 0 ? [] : ["换届过期清扫（本次调用触发）：", ...swept.lines, ""];
				const note = readNote(args.note);
				if (action === "prepare") {
					if (args.successor === undefined || args.successor === null || args.successor === "") {
						return wellFormed("prepare 失败：需要 successor（继任者会话 id）——令牌绑定三元组 (team, role, successor)，没有继任者就无法换届（§3.6.1 原则 1）。§3.6.4 的半自动兜底：先在壳里打开/创建一个继任者会话，再把它的事务 id 传进来；令牌随交接 prompt 交给该会话。只想让角色空出来请用 team_link_roster action=retire。");
					}
					const successor = readSessionId(args.successor);
					if (successor.error !== undefined) return wellFormed(`prepare 失败：${successor.error}`);
					const result = await rotation.prepare({ teamName: name.value, roleName: role.value, successor: successor.value, note, caller, now, signal: exec.signal });
					if (result.error !== undefined) return wellFormed(result.error);
					return wellFormed([...preamble, ...result.lines].join("\n"));
				}
				const token = readRotationToken(args.token);
				if (token.error !== undefined) return wellFormed(`claim 失败：${token.error}`);
				const result = await rotation.claim({ teamName: name.value, roleName: role.value, token: token.value, note, caller, now, signal: exec.signal, agent: exec.agent });
				if (result.error !== undefined) return wellFormed(result.error);
				return wellFormed([...preamble, ...result.lines].join("\n"));
			} catch (error) {
				return wellFormed(`换届操作失败：${describeError(error)}`);
			}
		},
	})), "team-link: rotate tool");
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
// broadcast fan-out + envelope meta (§3.4, M3)
// ---------------------------------------------------------------------------

/** Address-expression prefix. Anything else is taken as a session id — the
 * legacy meaning of a send target, and §3.4's first resolution step. */
const TEAM_EXPR_PREFIX = "team:";
/** §4.1: one fan-out travels to at most this many targets (counted on the raw
 * argument, before duplicates are collapsed, so a batch can never smuggle extra
 * work past the bound). */
const FANOUT_MAX_TARGETS = 8;
/** The closed `meta.type` set of §3.4. */
const META_TYPES = new Set(["ruling", "receipt", "report", "ask"]);
/** The closed `meta.pri` set of §3.4 (P0 = highest). */
const META_PRIS = new Set(["P0", "P1", "P2"]);
/** §4.1: `meta.ref` is a short reference; a longer one is truncated to this many
 * code points (the `preview` counting unit, so an astral character costs one). */
const META_REF_LIMIT = 16;
/** Exactly the three keys §3.4 gives the envelope — no more, no fewer. */
const META_KEYS = new Set(["type", "pri", "ref"]);
/** How many live sessions a `no-agent` refusal names before it stops. The list is
 * a self-healing hint on a refusal path, not a session listing tool (that is
 * `team_link_list_sessions`, which is bounded by `LIST_LIMIT`); ten ids are
 * enough to spot a transcription slip and small enough to keep the refusal
 * readable. A longer match set declares the bound instead of hiding it. */
const NO_AGENT_LIST_LIMIT = 10;
/** The ❌ lead of the `no-agent` refusal: a failure that a model might read as a
 * queued send (the reported incident) must say so in its very first character —
 * the field the eye lands on before any of the explanatory text. */
const NO_DELIVERY_PREFIX = "❌ 未投递";

/**
 * §3.4 envelope reading. The whole object is rejected as a unit: a half-accepted
 * envelope would make the delivered banner say something the caller did not ask
 * for, and an undefined key or an out-of-enum value is reported as a parameter
 * error rather than silently dropped.
 *
 * @returns `{ value: meta|null, notes }` (`notes` carries the truncation report)
 *   or `{ error }`.
 */
function readMeta(value) {
	if (value === undefined || value === null) return { value: null, notes: [] };
	if (typeof value !== "object" || Array.isArray(value)) {
		return { error: "meta 必须是对象 { type?, pri?, ref? }：type ∈ ruling/receipt/report/ask，pri ∈ P0/P1/P2，ref 为不超过 16 字符的短引用。" };
	}
	const unknown = Object.keys(value).filter((key) => !META_KEYS.has(key));
	if (unknown.length > 0) {
		return { error: `meta 含 §3.4 未定义的字段 ${unknown.join("、")}——信封只有 type（ruling/receipt/report/ask）、pri（P0/P1/P2）、ref（≤16 字符）三个键，未定义字段一律拒绝而不是静默丢弃。` };
	}
	const meta = {};
	const notes = [];
	if (value.type !== undefined && value.type !== null) {
		if (typeof value.type !== "string" || !META_TYPES.has(value.type)) {
			return { error: `meta.type 非法：${typeof value.type === "string" ? value.type : safeJson(value.type)}——枚举 ruling / receipt / report / ask。` };
		}
		meta.type = value.type;
	}
	if (value.pri !== undefined && value.pri !== null) {
		if (typeof value.pri !== "string" || !META_PRIS.has(value.pri)) {
			return { error: `meta.pri 非法：${typeof value.pri === "string" ? value.pri : safeJson(value.pri)}——枚举 P0 / P1 / P2。` };
		}
		meta.pri = value.pri;
	}
	if (value.ref !== undefined && value.ref !== null) {
		if (typeof value.ref !== "string") return { error: "meta.ref 必须是字符串（短引用，≤16 字符）。" };
		if (/[\u0000-\u001F\u007F]/u.test(value.ref)) return { error: "meta.ref 不能包含控制字符或换行——它是 banner 首行的单行字段。" };
		const chars = [...value.ref];
		if (chars.length === 0) return { error: "meta.ref 不能是空字符串——不需要该字段就不要传这个键。" };
		meta.ref = chars.length <= META_REF_LIMIT ? value.ref : chars.slice(0, META_REF_LIMIT).join("");
		if (chars.length > META_REF_LIMIT) {
			notes.push(`meta.ref 超过 ${META_REF_LIMIT} 字符（原 ${chars.length} 字符），已按码点截断为「${meta.ref}」。`);
		}
	}
	return { value: meta, notes };
}

/**
 * The §3.4 banner first-line fields, in the design's order and shape
 * (`type=ruling pri=P0 ref=slp-a1b2`) — only the keys the caller actually gave,
 * so a partial envelope renders a partial line instead of an empty slot.
 */
function metaBannerFields(meta) {
	if (meta === null || meta === undefined) return "";
	const parts = [];
	if (meta.type !== undefined) parts.push(`type=${meta.type}`);
	if (meta.pri !== undefined) parts.push(`pri=${meta.pri}`);
	if (meta.ref !== undefined) parts.push(`ref=${meta.ref}`);
	return parts.length === 0 ? "" : ` · ${parts.join(" ")}`;
}

/** Append the envelope notes (a truncated `ref`) to one send result. */
function withMetaNotes(text, notes) {
	return notes.length === 0 ? text : `${text}\n注意：${notes.join("；")}`;
}

/**
 * §3.4 address resolution for ONE expression. Priority, verbatim: a session id
 * is taken as-is (and still passes both gates per target — V8 is never
 * relaxed); `team:<name>/<role>` is point-to-point and open to any session;
 * `team:<name>/*` is the whole team and coordinator-only, because the
 * coordinator's value is partly the curation of what each worker sees
 * (《调研》§5.3 论据 (a): the incident notice was a curated forward) — and a
 * flash worker's scarcest resource is context.
 *
 * A vacant role becomes the typed `no-holder` row of §3.4 (评审 #7: never a
 * `[null]` target); it is neither a delivery nor a failure, so it counts in
 * neither. A team that is not in the roster refuses the whole call.
 *
 * @param expr - one `targets` entry.
 * @param teams - the normalized roster (`policy.get().teams`).
 * @param caller - `exec.agent.id`, the identity the wildcard rule compares.
 * @param options - `isLive(sessionId)`, the live-member filter of §3.4's
 *   `allLiveMembers` (defaults to "everyone is live", which keeps the resolver
 *   a pure function for the unit tests).
 * @returns `{ rows }` — id rows `{ sessionId, expr }` or typed rows
 *   `{ target, outcome: "no-holder", detail }` — or `{ error }` for a refusal
 *   that ends the whole call.
 */
function resolveTargets(expr, teams, caller, options = {}) {
	const isLive = typeof options.isLive === "function" ? options.isLive : () => true;
	if (!expr.startsWith(TEAM_EXPR_PREFIX)) return { rows: [{ sessionId: expr, expr }] };
	const body = expr.slice(TEAM_EXPR_PREFIX.length);
	const slash = body.indexOf("/");
	if (slash === -1 || slash === body.length - 1) {
		return { error: `寻址表达式 ${expr} 非法：形如 team:<name>/<role> 或 team:<name>/*（name 为 [a-z0-9-]+），或直接给会话 id。` };
	}
	const name = body.slice(0, slash);
	const member = body.slice(slash + 1);
	const team = teams.find((candidate) => candidate.name === name) ?? null;
	if (team === null) {
		return { error: `寻址表达式 ${expr} 指向的团队 ${name} 不在注册表中（先用 team_link_roster action=upsert-team 创建，或直接用会话 id 发送）。` };
	}
	if (member === "*") {
		const coordinator = roleOf(team, COORDINATOR_ROLE);
		const incumbent = coordinator === null ? null : coordinator.current;
		if (incumbent === null || caller === undefined || caller !== incumbent) {
			return { error: `全队广播被拒绝：team:${name}/* 只能由团队 ${name} 的现任协调者会话发起（现任 ${incumbent ?? "空缺"}，当前调用会话 ${caller ?? "（无会话身份）"}）。理由（《调研》§5.3 论据 (a)）：协调者的价值部分在于策展每个 worker 看到什么，而 flash worker 最稀缺的资源是上下文——全连通群播会让每个 worker 的上下文互相污染。请点对点发送（team:<name>/<role> 或会话 id），或由协调者发起全队广播。` };
		}
		// §3.4 `allLiveMembers`: every role that is filled AND live. A vacant role
		// is not a member, and a member whose agent is gone has nowhere to land —
		// point-to-point addressing is the form that reports such a target back.
		// The caller itself is skipped: the relay path refuses self-send by
		// construction, so keeping it would put a guaranteed refusal row in every
		// broadcast.
		const rows = [];
		for (const entry of team.roles) {
			if (entry.current === null || entry.current === caller) continue;
			if (!isLive(entry.current)) continue;
			rows.push({ sessionId: entry.current, expr });
		}
		return { rows };
	}
	const role = roleOf(team, member);
	if (role === null) {
		return { rows: [{ target: expr, outcome: "no-holder", detail: `团队 ${name} 没有角色 ${member}（未注册，等同空缺）` }] };
	}
	if (role.current === null) return { rows: [{ target: expr, outcome: "no-holder", detail: "该角色当前空缺" }] };
	return { rows: [{ sessionId: role.current, expr }] };
}

/**
 * §3.4 resolution of a whole `targets` array. Every expression is resolved
 * first and any expression-level refusal ends the call BEFORE a single message
 * is delivered — so a batch is never half-sent because of a bad address. Duplicate
 * session ids (and repeated `no-holder` expressions) collapse into one row; the
 * dropped count is reported in the summary.
 *
 * @returns `{ rows, duplicates }` or `{ error }`.
 */
function resolveTargetList(targets, teams, caller, options = {}) {
	if (targets.length === 0) return { error: "targets 不能是空数组——给至少一个目标（会话 id、team:<name>/<role> 或 team:<name>/*）。" };
	if (targets.length > FANOUT_MAX_TARGETS) {
		return { error: `单次 fan-out 最多 ${FANOUT_MAX_TARGETS} 个目标（本次 ${targets.length} 个；§4.1 防偏离）。请拆成多次广播。` };
	}
	const rows = [];
	const seenSessions = new Set();
	const seenExpressions = new Set();
	let duplicates = 0;
	for (const item of targets) {
		if (typeof item !== "string" || item.trim() === "") {
			return { error: "targets 的每一项都必须是非空字符串（会话 id、team:<name>/<role> 或 team:<name>/*）。" };
		}
		const resolved = resolveTargets(item.trim(), teams, caller, options);
		if (resolved.error !== undefined) return { error: resolved.error };
		for (const row of resolved.rows) {
			if (row.sessionId === undefined) {
				if (seenExpressions.has(row.target)) { duplicates += 1; continue; }
				seenExpressions.add(row.target);
				rows.push(row);
				continue;
			}
			if (seenSessions.has(row.sessionId)) { duplicates += 1; continue; }
			seenSessions.add(row.sessionId);
			rows.push(row);
		}
	}
	return { rows, duplicates };
}

/** Result-row label of one resolved target: the resolved session id, with the
 * expression it came from when that is something else (`session-x（via team:t/*）`). */
function targetLabel(row) {
	return row.expr === row.sessionId ? row.sessionId : `${row.sessionId}（via ${row.expr}）`;
}

/**
 * §3.5 (the P3 prevention face): one sentence about the semantics the sender just
 * bought. `turnStartedAt` comes from §3.1's signal — the same reading the
 * liveness face prints — and when the surface cannot be read the steer semantics
 * are still stated, just without a number.
 */
function busyGuidance(signal, now) {
	if (signal.agent !== "running") return "";
	if (typeof signal.turnStartedAt !== "number") {
		return "目标回合运行中，起始时间不可读（steer 注入当前回合）；需新回合语义请等其空闲。";
	}
	const minutes = Math.max(0, Math.floor((now - signal.turnStartedAt) / 60000));
	return `目标回合已运行 ${minutes} 分钟（steer 注入当前回合）；需新回合语义请等其空闲。`;
}

/**
 * Live sessions of the caller's own workspace, rendered as `id（运行中/空闲）`
 * rows: the self-healing half of a `no-agent` refusal.
 *
 * The agent registry is the ONLY source — no surface read, no log
 * decompression — so the enumeration costs nothing on a path a mistyped id
 * lands on. The filter is the caller's own view of "another root session here":
 * a live root agent (the same `roots()` judgement `deliverToTarget`'s subagent
 * guard uses, so a subagent is never advertised as an addressable peer), in the
 * caller's workspace, and never the caller itself. When the execution context
 * carries no session identity (the rotation notice path builds its sender from
 * an id alone) the workspace column is unknown and the cwd filter is skipped —
 * excluding the caller is then all that can honestly be done.
 *
 * @param ctx - plugin context; `ctx.agents.list()` is the registry read
 *   (goal-round-driver uses the same API).
 * @param exec - the tool-call context; `exec.agent` carries the caller's own
 *   `session.header.cwd` when it has one.
 * @param selfId - the caller's session id, excluded from its own hint list.
 * @returns `{ rows, total }` — `total` is the match count BEFORE the
 *   `NO_AGENT_LIST_LIMIT` cut, so the caller can declare the bound rather than
 *   hide it.
 */
function liveWorkspaceSessions(ctx, exec, selfId) {
	const rows = [];
	if (typeof ctx?.agents?.list !== "function") return { rows, total: 0 };
	const roots = typeof ctx.agents.roots === "function" ? ctx.agents.roots() : null;
	const caller = exec?.agent;
	const callerCwd = caller?.session?.header?.cwd;
	const scoped = typeof callerCwd === "string" && callerCwd !== "";
	let total = 0;
	for (const agent of ctx.agents.list()) {
		if (agent === undefined || agent === null) continue;
		if (agent === caller || (selfId !== undefined && agent.id === selfId)) continue;
		// Two independent subagent judgements, both already used by the delivery
		// guard: the coarse `origin` class and roots() membership.
		if (agent.session?.header?.origin === "subagent") continue;
		if (roots !== null && !roots.includes(agent)) continue;
		if (scoped && agent.session?.header?.cwd !== callerCwd) continue;
		total += 1;
		if (rows.length < NO_AGENT_LIST_LIMIT) {
			rows.push(`${agent.id}（${agent.status === "running" ? "运行中" : "空闲"}）`);
		}
	}
	return { rows, total };
}

/**
 * The `no-agent` refusal, made self-healing. Reported incident: a coordinator
 * mistyped one digit of a target id, got "没有活动代理", and had nothing to
 * compare the id against — so it carried on reporting the send as fine while
 * the target session was alive. Three parts, in order:
 *
 * 1. the ❌ 未投递 lead — a failure may never be read as a queued send;
 * 2. the legacy sentence, kept word for word (目标会话 <id> 没有活动代理) so the
 *    refusal stays recognisable, followed by the live same-workspace sessions
 *    from {@link liveWorkspaceSessions};
 * 3. the recovery hint: compare the id (transcription slip is the common case),
 *    re-open the session in the sidebar after a DSH restart (that is what
 *    restores it as a live agent), or re-read the list before retrying.
 *
 * `targetId` is the caller's own tool argument echoed back — the wellFormed
 * repair rides here as it does on every other refusal.
 */
function noAgentRefusal(ctx, exec, targetId) {
	const { rows, total } = liveWorkspaceSessions(ctx, exec, agentSessionId(exec));
	const listed = total === 0
		? "当前工作区无其他存活会话。"
		: [
			`当前工作区其他存活会话（共 ${total} 个${total > rows.length ? `，仅列前 ${rows.length} 个` : ""}）：`,
			...rows.map((row) => `  - ${row}`),
		].join("\n");
	return wellFormed([
		`${NO_DELIVERY_PREFIX}：目标会话 ${targetId} 没有活动代理（未在本壳中打开或已退出）。仅支持投递到存活会话。`,
		listed,
		"提示：请对照上列 id 核对目标 id（常见错误：转录错位）；若 id 无误且刚重启过 DSH，请在侧边栏打开目标会话一次使其恢复为活动代理；也可先调 team_link_list_sessions 查询。",
	].join("\n"));
}

/**
 * Deliver one relay message to one target session — the complete legacy send
 * path, unchanged: the self / dead / subagent guards, the explicit block (which
 * also drops a stale pair), the pairing fast path, gate 1 (sender approval),
 * gate 2 (receiver policy) and the steer/followup delivery. §3.5's busy
 * prediction rides on the success sentence.
 *
 * The single-target call and every fan-out iteration both go through here, so a
 * batch can never skip a gate a single send would have raised (§3.4/§4.1:
 * fan-out 不放宽任何门; V8).
 *
 * `options.internal` is the §3.6.2 "内部广播路径" used by the rotation notices:
 * the body is a plugin constant (no model can inject into it), so the SENDER-side
 * approval gate is skipped — but the receiver's inbound policy, its block list
 * and the pair fast path are all still walked exactly as below (the plugin never
 * gets a channel the user did not grant; §5.3 红线 "fan-out 不绕门").
 * An internal notice NEVER opens the receiver's "ask" dialog (§3.6.2 评审 #3): it
 * is delivered inside a tool call or a background patrol, one recipient after the
 * other, so a three-minute dialog per unpaired member could eat the caller's whole
 * budget (the rotation tool is allowed 300s) — the receiver is skipped with an
 * explicit row (refused-ask semantics) whose text names the two ways to receive
 * the notice later (trustedSenders / pairing). Sweep-originated notices take the
 * same path: the two broadcast modes are one.
 *
 * @returns `{ outcome: "delivered"|"refused"|"no-agent", text }`; `text` is the
 *   legacy result sentence, reused verbatim as the fan-out row detail.
 */
async function deliverToTarget(ctx, policy, sender, exec, targetId, text, meta, options = {}) {
	const internal = options.internal === true;
	if (targetId === sender.id) return { outcome: "refused", text: "发送失败：目标会话不能是当前会话。" };
	const target = ctx.agents.get(targetId);
	// `targetId` is a model-supplied tool argument echoed straight back into the
	// caller's history — the "tool argument echo" carrier — so the refusal is
	// repaired here and does not rely on the output.render gate alone.
	if (target === undefined) return { outcome: "no-agent", text: noAgentRefusal(ctx, exec, targetId) };
	if (target?.session?.header?.origin === "subagent") return { outcome: "refused", text: "发送失败：目标会话是子代理会话，不支持接收跨会话消息。" };
	if (typeof ctx.agents.roots === "function" && !ctx.agents.roots().includes(target)) {
		return { outcome: "refused", text: "发送失败：目标代理不是根代理（可能是子代理），不支持接收跨会话消息。" };
	}

	// ---- block check + pairing fast path ----------------------------------
	const initialView = policy.get();
	// One instant for every pair decision of this delivery: an expired provisional
	// channel must be judged by the same clock as the gate it is denied (§3.6.2 评审 #8).
	const gateNow = Date.now();
	if (initialView.blockedSenders.includes(sender.id)) {
		// An explicit block always wins, even over an established pair.
		if (pairBetween(initialView, sender.id, targetId, gateNow)) {
			try {
				await policy.update({ pairs: initialView.pairs.filter((pair) => !((pair.a === sender.id && pair.b === targetId) || (pair.a === targetId && pair.b === sender.id))) });
			} catch {
				/* best-effort pair cleanup once the sender is blocked */
			}
		}
		return { outcome: "refused", text: "未投递：目标会话已屏蔽来自当前会话的消息。" };
	}
	// 评审 #8: an expired provisional record is NO pair here — the delivery falls
	// back to the two ordinary gates the moment the 24h window closes, whether or
	// not the sweep has deleted the row yet.
	const pair = pairRecordBetween(initialView, sender.id, targetId, gateNow);
	const paired = pair !== null;
	const userQuestions = paired ? undefined : ctx.get?.("userQuestions");
	const askable = userQuestions !== undefined && typeof userQuestions.ask === "function";
	// Deliberately fail-closed: without the confirmation service an unpaired send
	// refuses, even in a configuration whose gates would not have asked (sender
	// already remembered AND the receiver trusting/accepting). Relaxing this to
	// "ask only if a gate would prompt" is a policy decision, not a bug fix — and
	// the fan-out inherits it per target, so a batch is never a way around it.
	// An INTERNAL notice has no sender-side gate to answer, so this guard does not
	// apply to it; its receiver-side dialog is checked where that dialog is raised.
	if (!internal && !paired && !askable) {
		return { outcome: "refused", text: "发送失败：跨会话发送需要用户批准，但确认服务（userQuestions）不可用。" };
	}

	// ---- gate 1: sender-side approval (skipped for plugin-internal notices) --
	if (!internal && !paired && !policy.get().rememberTargets.includes(targetId)) {
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
			return { outcome: "refused", text: wellFormed(`发送失败：发送确认未完成（${describeError(error)}）。`) };
		}
		if (choice === "取消") return { outcome: "refused", text: "已取消：用户拒绝了本次发送。" };
		if (choice !== "发送" && choice !== "记住该目标并发送") return { outcome: "refused", text: "发送失败：发送确认未得到明确同意。" };
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
		if (view.receiveMode === "reject") return { outcome: "refused", text: "未投递：目标会话的接收策略为全部拒绝（可在设置 team-link 中调整）。" };
		if (view.receiveMode === "ask") {
			if (!askable) return { outcome: "refused", text: "未投递：目标会话的接收策略为逐条确认（ask），但确认服务（userQuestions）不可用。" };
			if (internal) {
				// §3.6.2 评审 #3: an internal notice never blocks on a confirmation
				// dialog — not for a sweep (no present user) and not for prepare/claim
				// either (N unpaired "ask" members × a 3-minute dialog would overrun the
				// caller's tool budget). The row is the record; the ask mode itself is
				// not overridden, so the receiver can still be reached by making the
				// sender trusted or by pairing.
				return { outcome: "refused", text: "未投递：目标会话的接收策略为逐条确认（ask），而插件内部通知（rotation-freeze / rotation-done / rotation-cancelled / rotation-expired）一律不弹确认框——通知在工具调用或巡逻里逐个串行投递，3 分钟弹框会拖垮调用方（几个 ask 成员就吃掉全部工具预算）。可把发送方加入 trustedSenders 或建立配对后补收。" };
			}
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
					? { outcome: "refused", text: "未投递：目标会话用户未在 3 分钟内确认接收。" }
					: { outcome: "refused", text: wellFormed(`未投递：目标会话用户未能确认（${describeError(error)}）。`) };
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
				return { outcome: "refused", text: "未投递：目标会话用户拒绝并屏蔽了来自当前会话的消息。" };
			}
			if (choice === "配对：双向免确认") {
				try {
					const current = policy.get();
					const pairedAt = Date.now();
					if (!pairBetween(current, sender.id, targetId, pairedAt)) {
						await policy.update({ pairs: [...current.pairs, { a: sender.id, b: targetId, createdAt: pairedAt }] });
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
				return { outcome: "refused", text: "未投递：目标会话用户未确认接收。" };
			}
		}
		// receiveMode === "accept" → deliver without asking
	}

	// ---- §3.5 busy prediction (read before delivering, so the minutes are the
	// turn the message actually lands in) ------------------------------------
	const now = Date.now();
	const running = target.status === "running";
	const busy = running ? busyGuidance(buildLivenessSignal(ctx, targetId, { now, agent: target, surface: await readSessionSurface(ctx, targetId) }), now) : "";

	// ---- deliver -----------------------------------------------------------
	// The banner is written into the TARGET session's log, where a lone
	// surrogate would kill that session's next request — so the payload is
	// made well-formed here, at the door, not merely where it is displayed.
	// §3.4's envelope rides on the first line; the source below still carries
	// exactly the three audited members (V10).
	const banner = wellFormed([
		`📨 [跨会话消息 · 来自会话 ${sessionLabel(sender.id, senderTitle)} · ${localStamp()}${metaBannerFields(meta)}]`,
		"",
		text,
		"",
		"（如需回复，可让本会话调用 team_link_send 工具发回）",
	].join("\n"));
	// The source is the audited cross-session relay shape the DSH 0.1.5
	// session-format migration admits — exactly `{kind, form, senderSessionId}`.
	// An unknown kind (or any extra member) refuses the WHOLE session log at
	// migration time, so the sender, the plugin name, the delivery time AND the
	// envelope fields live in the banner text instead of the source.
	const message = {
		id: `slp-${randomUUID()}`,
		role: "user",
		source: { kind: "agent-message", form: "relay", senderSessionId: sender.id },
		content: [{ type: "text", text: banner }],
	};
	if (running) target.steer(message);
	else target.followup(message);
	// §3.6.2 评审 #3 (provisional 可见面): a delivery that rides a rotation-granted
	// channel says so — the sender has to know the channel is not ratified yet and
	// that it rolls back in 24h. The banner deliberately gains no field (the
	// envelope stays the §3.4 three-key object) — this suffix is the face of record.
	const channelNote = paired
		? pair.provisional === true
			? "（provisional 通道，24h 内未批准自动回退）"
			: "（已配对通道，免确认自动投递）"
		: "";
	return {
		outcome: "delivered",
		text: wellFormed(`已投递到 ${sessionLabel(targetId, targetTitle)}${channelNote}：${running ? `目标正在运行，消息将在步边界注入当前回合。${busy}` : "目标空闲，已唤醒目标会话并作为新回合处理（消息与回复稍后出现在目标会话中）"}。`),
	};
}

/**
 * §3.4 fan-out: {@link deliverToTarget} once per resolved target, one result row
 * each, then the summary line. Nothing here relaxes a gate — the loop calls the
 * legacy path itself, approval dialog and all, so N targets cost N approvals.
 * `no-holder` rows are the typed vacancy results: neither a delivery nor a
 * failure, and the design counts them in neither.
 *
 * Failure lead (reported incident: a caller read "1 投递 / 2 拒绝" as "broadcast
 * done" while two thirds of the team never heard anything): as soon as ONE
 * target did not come back `delivered`, the report OPENS with
 * `❌ N 个目标未投递（M 个已投递）` — the shape a fully successful batch has, in
 * which the header, the per-target rows and the summary simply follow, is kept
 * exactly for the all-delivered case. `no-holder` counts as 未投递 here for the
 * same reason it counts in neither 投递 nor 拒绝 below: the message did not
 * reach that target, and the lead-in says 未投递, never 失败 — the detailed
 * summary keeps the vacancy in its own, separate bucket.
 *
 * @returns `{ lines, results }` — the report lines of the fan-out.
 */
async function fanout(ctx, policy, sender, exec, request) {
	const { rows, duplicates, meta, payload } = request;
	const results = [];
	for (const row of rows) {
		if (row.sessionId === undefined) {
			results.push({ label: row.target, outcome: "no-holder", text: row.detail });
			continue;
		}
		// R5 (M3 review): one target's failure must not be able to take the whole
		// report down. An exception raised while delivering to target N (a throwing
		// steer/followup, a service that vanished mid-loop) becomes that target's
		// own refused row — the other targets keep their deliveries and the summary
		// line is always produced. Single-target sends keep their legacy behavior:
		// there the thrown error IS the answer, and no second target is at risk.
		try {
			const outcome = await deliverToTarget(ctx, policy, sender, exec, row.sessionId, payload, meta);
			results.push({ label: targetLabel(row), outcome: outcome.outcome, text: outcome.text });
		} catch (error) {
			results.push({ label: targetLabel(row), outcome: "refused", text: `发送失败：投递到该目标时异常（${describeError(error)}），其余目标不受影响。` });
		}
	}
	const count = (wanted) => results.filter((entry) => entry.outcome === wanted).length;
	const summary = [`${count("delivered")} 投递`, `${count("refused")} 拒绝`];
	if (count("no-agent") > 0) summary.push(`${count("no-agent")} 无活动代理`);
	if (count("no-holder") > 0) summary.push(`${count("no-holder")} 空缺目标（no-holder，不计入投递与失败）`);
	if (duplicates > 0) summary.push(`${duplicates} 个重复目标已去重`);
	// Failure lead (see the doc comment): the first line of a batch that lost a
	// target says so, so the shape of a successful batch can never stand in for
	// one that did not reach everyone.
	const undelivered = results.filter((entry) => entry.outcome !== "delivered").length;
	const lines = [];
	if (undelivered > 0) lines.push(`❌ ${undelivered} 个目标未投递（${count("delivered")} 个已投递）`);
	lines.push(`广播 fan-out：${results.length} 个目标${duplicates > 0 ? `（重复目标已去重 ${duplicates} 个）` : ""}`);
	for (const entry of results) lines.push(`- ${entry.label} → ${entry.outcome}：${entry.text}`);
	lines.push(`汇总：${summary.join(" / ")}。`);
	return { lines, results };
}

// ---------------------------------------------------------------------------
// rotation: two-phase team hand-over (§3.6, M4)
// ---------------------------------------------------------------------------

/** Phase A token lifetime (§3.6.2): a prepared hand-over must be claimed inside
 * this window, otherwise the sweep cancels it and releases the team freeze. */
const ROTATION_TTL_MS = 30 * 60000;
/** Phase B provisional trust lifetime (§3.6.2 评审 #5): a migration granted
 * without a present user is revoked after this window unless ratified. */
const ROTATION_PROVISIONAL_TTL_MS = 24 * 3600000;
/** Anti-storm window of §3.6.2 (`rateLimit(team, role, 10min)`): one prepare per
 * team+role per window, counting a live pending AND a completed rotation. */
const ROTATION_RATE_LIMIT_MS = 10 * 60000;
/** How long the single rotation dialog waits for a present user before the claim
 * falls back to the unattended (provisional) path (§3.6.1 principle 4). */
const ROTATION_CONFIRM_TIMEOUT_MS = 180000;
/** The tool's closed `action` set (§3.6.2: exactly two phases). */
const ROTATION_ACTIONS = new Set(["prepare", "claim"]);
/** Display prefix of a masked token (§3.6.2 评审 #3 / M2 评审 #3). */
const ROTATION_TOKEN_LABEL = "tok-";
/** The history note a rolled-back provisional migration leaves behind. */
const ROTATION_PROVISIONAL_NOTE = "provisional 未批准过期";
/** The third rotation verdict (§3.6.2 评审 #5): a claim with no in-domain
 * candidate opens no dialog, so neither "已批准" (nobody was asked, nobody
 * approved) nor "待批准(24h)" (no provisional window exists) is true. */
const ROTATION_STATUS_NONE = "无待迁移对";
/** Question id of the rotation dialog — the answer is matched by id, not order. */
const ROTATION_DIALOG_ID = "rotation-migrate";

/** Masked rendering of a one-time rotation token: `tok-<head4>…<tail4>`. The full
 * value is handed to the preparing caller exactly once and never rendered again —
 * not in the mirror, not in `roster get` (§3.6.2 评审 #3). */
function maskToken(token) {
	const text = String(token ?? "");
	if (text.length <= 4) return `${ROTATION_TOKEN_LABEL}…`;
	return `${ROTATION_TOKEN_LABEL}${text.slice(0, 4)}…${text.slice(-4)}`;
}

/** One status field of an internal notice, reduced to a single injection-free
 * line. Notice bodies are plugin constants (§3.6.2) — the only values that ever
 * enter one are validated identifiers, and this pass keeps even those from
 * carrying a newline (or a `|`) into the body. */
function noticeField(value) {
	return String(value ?? "").replace(/[\u0000-\u001F\u007F|]/gu, "_");
}

/** The filled roles of one team, deduplicated, in roster order — "同 team 成员" of
 * §3.6.1 principle 2, and the recipient set of an internal notice. A vacant role
 * is not a member. */
function teamMembers(team) {
	const members = [];
	for (const entry of team.roles) {
		if (entry.current === null || members.includes(entry.current)) continue;
		members.push(entry.current);
	}
	return members;
}

/** The remaining part of an anti-storm window, for the refusal sentence. */
function fmtWindowRest(until, now) {
	return `窗口剩余约 ${Math.max(0, Math.ceil((until - now) / 60000))} 分钟`;
}

/** §3.6.2 `rateLimit(team, role, 10min)`: refuse a prepare while a pending minted
 * inside the window exists, or a rotation of the same role completed inside it.
 * Pure — `now` is the caller's clock, so both branches are testable directly. */
function rotationRateLimited(entry, now) {
	if (entry === null || entry === undefined) return { limited: false };
	const pending = entry.pending;
	if (pending !== null && pending !== undefined) {
		const minted = pending.createdAt > 0 ? pending.createdAt : pending.expiresAt - ROTATION_TTL_MS;
		if (now - minted < ROTATION_RATE_LIMIT_MS) {
			return { limited: true, reason: `该角色已有 pending（创建于 ${readStamp(minted)}，${fmtWindowRest(minted + ROTATION_RATE_LIMIT_MS, now)}）` };
		}
	}
	if (entry.rotationAt > 0 && now - entry.rotationAt < ROTATION_RATE_LIMIT_MS) {
		return { limited: true, reason: `该角色刚完成过一次换届（${readStamp(entry.rotationAt)}，${fmtWindowRest(entry.rotationAt + ROTATION_RATE_LIMIT_MS, now)}）` };
	}
	return { limited: false };
}

/** §3.6.2 prepare permission, verbatim: the incumbent session of that role. The
 * user path is the settings UI (the user is the super-writer there), not a tool
 * call — so a caller that is not the incumbent is refused, never guessed at. */
function rotateGate(team, entry, caller) {
	if (entry.current === null) {
		return { error: `prepare 被拒绝：团队 ${team.name} 的角色 ${entry.role} 当前空缺（current=null），没有「现任」可以发起换届。请由用户经设置 UI 指定现任后再换。` };
	}
	if (caller === undefined || caller !== entry.current) {
		return { error: `prepare 被拒绝：只有该角色的现任会话 ${entry.current} 可以发起换届（当前调用会话 ${caller ?? "（无会话身份）"}）。用户路径是设置 UI（直接改设置命名空间 team-link 的 teams 键），不是工具调用（§3.6.2）。` };
	}
	return { ok: true };
}

/** Stable identity of one pair record (the R1 convention): a rotation must tell
 * "the pair the dialog listed" from "a pair added while the dialog was open". */
function pairKey(pair) {
	return `${pair.a}\n${pair.b}\n${pair.createdAt}`;
}

/**
 * §3.6.1 principle 2 in one place: which pairs a rotation MAY migrate. A pair
 * qualifies only when it touches the outgoing holder AND its other end is a
 * member of the same roster ("爆炸半径限团队域"); the pair that would only join
 * the successor to itself does not qualify either. Everything else is dropped
 * with the retirement and never migrated.
 *
 * @returns `{ candidates, dropped }` — `candidates` in dialog order; several
 *   records naming the same counterpart yield one candidate, the rest are
 *   reported as duplicates.
 */
function planRotationMigration(view, request) {
	const { members, retiree, successor } = request;
	const candidates = [];
	const dropped = [];
	for (const pair of view.pairs) {
		if (pair.a !== retiree && pair.b !== retiree) continue;
		const other = pair.a === retiree ? pair.b : pair.a;
		if (other === successor) {
			dropped.push({ pair, other, reason: "对端就是继任者（迁移后会变成自己与自己配对）" });
			continue;
		}
		if (!members.has(other)) {
			dropped.push({ pair, other, reason: "对端不在本团队域内（§3.6.1 原则 2）" });
			continue;
		}
		if (candidates.some((candidate) => candidate.other === other)) {
			dropped.push({ pair, other, reason: "同一对端已有一条待迁移通道（重复记录）" });
			continue;
		}
		candidates.push({ pair, other });
	}
	return { candidates, dropped };
}

/**
 * The trust half of a claim: migrate the chosen in-domain pairs onto the new
 * holder, and revoke the outgoing holder symmetrically (§3.6.1 principle 3 —
 * every pair touching it, plus its two entries in the global trust lists).
 * Pure: it returns the three policy lists, it does not write them.
 */
function applyRotationTrust(view, request) {
	const { retiree, successor, chosen, now, provisional } = request;
	const removed = view.pairs.filter((pair) => pair.a === retiree || pair.b === retiree);
	const kept = view.pairs.filter((pair) => pair.a !== retiree && pair.b !== retiree);
	const additions = [];
	for (const candidate of chosen) {
		const exists = kept.some((pair) => (pair.a === successor && pair.b === candidate.other) || (pair.a === candidate.other && pair.b === successor));
		if (exists) continue;
		additions.push({
			a: successor,
			b: candidate.other,
			createdAt: now,
			provisional: provisional === true,
			expiresAt: provisional === true ? now + ROTATION_PROVISIONAL_TTL_MS : 0,
		});
	}
	return {
		pairs: [...kept, ...additions],
		trustedSenders: view.trustedSenders.filter((id) => id !== retiree),
		rememberTargets: view.rememberTargets.filter((id) => id !== retiree),
		additions,
		removed,
		revoked: {
			trustedSenders: view.trustedSenders.filter((id) => id === retiree),
			rememberTargets: view.rememberTargets.filter((id) => id === retiree),
		},
	};
}

/**
 * The roster half of a claim (§3.6.2 "roster 落定"): the old tenure closes with
 * the note, the new one opens, and the pending keeps the migrated-pairs marker —
 * the idempotency record, written BEFORE the pending is cleared, so a crash in
 * between leaves a replayable state instead of a second migration. An unconfirmed
 * rotation also opens its ratification window here. Pure.
 *
 * §3.6.2 评审 #10: the claim's verdict word (`status`) is recorded on the role
 * here, in the same write as the settlement. The replay used to RE-DERIVE it
 * from the leftover state, and that derivation is lossy: a dialog answered with
 * every candidate unchecked is ratified (status 已批准) yet migrates no pair and
 * opens no window, so `provisional === null && migrated.length === 0` replayed
 * it as 无待迁移对 — a different word about the same rotation.
 */
function settleRotation(team, request) {
	const { role, now, note, migratedPairs, provisional, status } = request;
	const existing = roleOf(team, role);
	const previous = existing.current;
	const history = existing.history.map((record) => ({ ...record }));
	if (previous !== null) closeTenure(history, previous, now, note);
	history.push({ session: existing.pending.session, from: now, until: null });
	const record = roleRecord({
		role,
		current: existing.pending.session,
		history,
		rotationAt: now,
		provisional: provisional === true ? { at: now, expiresAt: now + ROTATION_PROVISIONAL_TTL_MS, session: existing.pending.session } : null,
		rotationStatus: status ?? "",
		pending: { ...existing.pending, migratedPairs },
	});
	return {
		team: { ...team, roles: team.roles.map((entry) => (entry.role === role ? record : entry)) },
		previous,
		successor: existing.pending.session,
	};
}

/** The verdict word of a settled rotation, read from the role the claim recorded
 * it on (§3.6.2 评审 #10). The fallback is only for a role row written before
 * that field existed — the derivation it uses is exactly the lossy one the
 * recorded word replaces, so it stays as the legacy path rather than as a
 * second source of truth. */
function rotationStatusOf(entry, migrated) {
	if (typeof entry.rotationStatus === "string" && entry.rotationStatus !== "") return entry.rotationStatus;
	if (entry.provisional !== null && entry.provisional !== undefined) return "待批准(24h)";
	return migrated.length === 0 ? ROTATION_STATUS_NONE : "已批准";
}

/** Drop one role's pending — the last step of a claim, and of a cancellation. */
function clearRotationPending(team, role) {
	return { ...team, roles: team.roles.map((entry) => (entry.role === role ? { ...entry, pending: null } : entry)) };
}

/** The pairs one provisional window actually has to roll back (§3.6.2 评审 #2):
 * still provisional, already past their deadline, and granted to THIS window's
 * successor — the exact shape a rotation migration writes. An empty result means
 * the window has nothing to roll back (its pairs were ratified in the settings UI,
 * or the migration never created one), which is what makes the rotation-expired
 * notice and the "provisional 未批准过期" history entry false in that state. Pure. */
function doomedProvisionalPairs(pairs, successor, now) {
	// The expiry half is {@link isExpiredProvisionalPair} (评审 #8) — one definition
	// of "past its deadline" for the window query, the delivery-side gate and the
	// sweep's unconditional deletion.
	return pairs.filter((pair) => isExpiredProvisionalPair(pair, now) && (pair.a === successor || pair.b === successor));
}

// --- internal notices (§3.6.2 "内部广播路径") -------------------------------
// Four bodies, all plugin constants: only status fields (team, role, session
// ids, reading time) are interpolated, and every interpolated identifier passes
// `noticeField` first. No model-supplied text (a `note`, a message body) can
// reach a notice, so a notice can never smuggle a prompt into a peer's next
// request — the same red line the watchdog tick body is built on.

/** rotation-freeze: the freeze check-list is plugin constant text (§4.2). */
function freezeNotice(team, role, caller, successor, now) {
	return `[rotation-freeze] 团队 ${noticeField(team)} 的角色 ${noticeField(role)} 开始换届（发起会话 ${noticeField(caller)}，继任者 ${noticeField(successor)}，读数 ${readStamp(now)}）。冻结清单：① 停掉本会话的哨兵/看门狗与后台 job；② 确认没有在飞的动作（未完成的投递或工具调用）；③ 向协调者回报「状态已冻结」；④ 等待交接结果通知（rotation-done / rotation-cancelled）。冻结期间不要发起换届，也不要改动信任配置。`;
}

/** rotation-done: `status` is the ratified / provisional / no-candidate verdict of
 * the claim. The three verdicts carry three different sentences: the middle one
 * claims a rollback window that does not exist when nothing was migrated (§3.6.2
 * 评审 #5), so it must not be reached by the no-candidate status. */
function doneNotice(team, role, previous, successor, status, now) {
	const verdict = status === "已批准"
		? "迁移的 pairs 已是正式通道（旧任持有的 pairs/trustedSenders/rememberTargets 已对称吊销）。"
		: status === ROTATION_STATUS_NONE
			? "本次换届域内没有待迁移的通道（未弹确认框，也没有 provisional 回退窗口）：退役者持有的 pairs/trustedSenders/rememberTargets 已对称吊销，团队内不需要重建任何通道。"
			: "迁移的 pairs 是 provisional 通道：24h 内未获批准将自动回退为过门投递，期间经该通道投递的消息不可回收（§3.6.1 诚实声明）。";
	return `[rotation-done] 团队 ${noticeField(team)} 的角色 ${noticeField(role)} 换届完成（读数 ${readStamp(now)}）：旧任 ${noticeField(previous)} → 新任 ${noticeField(successor)}；信任迁移状态：${status}。${verdict}`;
}

/** rotation-cancelled: a token nobody claimed inside its 30 minutes (§3.6.2 评审 #4). */
function cancelledNotice(team, role, incumbent, caller, now) {
	return `[rotation-cancelled] 团队 ${noticeField(team)} 的角色 ${noticeField(role)} 的换届令牌过期未认领（发起会话 ${noticeField(caller)}，清扫读数 ${readStamp(now)}）：旧任 ${noticeField(incumbent)} 仍为 current（换届未发生），解除冻结——本条通知即解冻信号。需要换人请由现任重新 prepare。`;
}

/** rotation-expired: the 24h ratification window closed unapproved (§3.6.2 评审 #5). */
function expiredNotice(team, role, successor, now) {
	return `[rotation-expired] 团队 ${noticeField(team)} 的角色 ${noticeField(role)} 的 provisional 信任迁移 24h 内未获批准，已自动回退（清扫读数 ${readStamp(now)}）：迁移的 pairs 已删除，${noticeField(successor)} 仍为 current（换届事实已成立，降格需用户显式操作），此后投递按正常过门（首问门）处理。`;
}

/** One-line summary of a notice's delivery rows. */
function noticeSummary(rows) {
	const count = (wanted) => rows.filter((row) => row.includes(`→ ${wanted}`)).length;
	return `${count("delivered")} 投递 / ${count("refused")} 拒绝 / ${count("no-agent")} 无活动代理`;
}

// --- the rotation controller -------------------------------------------------

/**
 * Live rotation controller of one plugin context. `apply` is the only writer;
 * `host-half.test.mjs` reads it through {@link __testing} so the sweep can be
 * driven with an injected clock instead of waiting 24 hours.
 */
const ROTATION_BY_CTX = new WeakMap();

/**
 * The M4 two-phase hand-over (§3.6.2, line by line).
 *
 * `prepare` mints a one-time token bound to (team, role, successor), snapshots
 * the trust state for revocation and broadcasts the freeze; `claim` — only from
 * the successor session and only with that token — migrates the in-team pairs
 * through one confirmation dialog (or provisionally, when nobody is there to
 * confirm), revokes the outgoing holder symmetrically and settles the roster.
 * `sweep` is the expiry half (评审 #4/#5): it rides the watchdog patrol timer
 * and every roster touch, so a stranded token can never freeze a team forever.
 */
function createRotation(ctx, policy) {
	/**
	 * Deliver one internal notice (§3.6.2 "内部广播路径"): the sender-side approval
	 * gate is skipped — the body is a plugin constant nobody can inject into — but
	 * the receiver's inbound policy and the explicit block list are honoured
	 * exactly as they are for a normal send, and it never opens a receiver
	 * confirmation dialog (§3.6.2 评审 #3 — the notice path is serial, so a dialog
	 * per recipient could overrun the caller's budget; an "ask" receiver is skipped
	 * with an explicit row by {@link deliverToTarget}).
	 *
	 * The sender identity is chosen by the caller and is always the session the
	 * notice is factually about: the caller of prepare/claim, or (for a sweep) the
	 * role's current holder — "旧任仍为 current" for a cancellation, the successor
	 * for an expiry. A caller that has no such identity (a vacant role) leaves the
	 * notice unsent and says so, rather than inventing a sender.
	 *
	 * The receivers are the team's incumbent members PLUS `options.alsoNotify`
	 * (§3.6.2 评审 #6): after a rotation the outgoing holder is no longer anyone's
	 * `current`, so the done/cancelled notice about that very hand-over would never
	 * reach the session it is about. An extra id joins only while it is still live
	 * (A4: nothing can wake a closed session) and never the sender.
	 */
	async function broadcastNotice(teamName, senderId, text, options = {}) {
		const team = policy.get().teams.find((entry) => entry.name === teamName) ?? null;
		if (team === null) return { rows: [`  - （团队 ${teamName} 不在注册表中，未广播）`], summary: "0 投递（团队不在注册表）" };
		if (senderId === undefined || senderId === null || senderId === "") {
			return { rows: ["  - （通知没有可用的发送方会话身份，未广播）"], summary: "0 投递（无发送方身份）" };
		}
		// §3.6.2 评审 #6: members first (a dead member keeps its no-agent row — the
		// roster is the record), then the outgoing holder the caller named, added
		// only while it still resolves to a live agent.
		const recipients = teamMembers(team).filter((id) => id !== senderId);
		for (const id of Array.isArray(options.alsoNotify) ? options.alsoNotify : []) {
			if (typeof id !== "string" || id === "" || id === senderId || recipients.includes(id)) continue;
			if (ctx.agents.get(id) === undefined) continue;
			recipients.push(id);
		}
		const rows = [];
		for (const target of recipients) {
			try {
				const outcome = await deliverToTarget(ctx, policy, { id: senderId }, { signal: options.signal }, target, text, null, {
					internal: true,
				});
				rows.push(`  - ${target} → ${outcome.outcome}：${preview(outcome.text, 200)}`);
			} catch (error) {
				rows.push(`  - ${target} → refused：通知投递异常（${describeError(error)}）`);
			}
		}
		if (recipients.length === 0) rows.push("  - （团队成员只有发起者自身，无需广播）");
		return { rows, summary: noticeSummary(rows) };
	}

	/** The one dialog of a claim (§3.6.1 principle 4): all candidate pairs in a
	 * single request, per-item selection, one batch submission. */
	async function askRotationDialog(request) {
		const userQuestions = ctx.get?.("userQuestions");
		if (userQuestions === undefined || typeof userQuestions.ask !== "function") {
			return { answered: false, reason: "确认服务（userQuestions）不可用——按无人值守路径处理：全部域内 pairs 以 provisional 迁移，24h 内未批准自动回退。" };
		}
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, ROTATION_CONFIRM_TIMEOUT_MS);
		timer.unref?.();
		const forward = () => controller.abort();
		request.signal?.addEventListener?.("abort", forward);
		try {
			const answer = await userQuestions.ask({
				questions: [{
					id: ROTATION_DIALOG_ID,
					header: "换届信任迁移确认",
					question: wellFormed(request.question),
					detail: wellFormed(request.detail),
					options: request.candidates.map((candidate) => ({
						label: candidate.other,
						description: `对端会话 ${candidate.other}（pairs 建立于 ${readStamp(candidate.pair.createdAt)}）——勾选则迁移为 ${request.successor} ↔ ${candidate.other}`,
					})),
					multiSelect: true,
				}],
				agent: request.agent,
				signal: controller.signal,
			});
			const item = Array.isArray(answer?.answers) ? answer.answers.find((entry) => entry?.id === ROTATION_DIALOG_ID) : undefined;
			if (item === undefined || !Array.isArray(item.selected)) {
				return { answered: false, reason: "对话框没有返回本次换届问题的答案——按未确认处理：全部域内 pairs 以 provisional 迁移，24h 内未批准自动回退。" };
			}
			const keys = new Set();
			const claimed = new Set();
			for (const label of item.selected) {
				const index = request.candidates.findIndex((candidate, position) => !claimed.has(position) && candidate.other === label);
				if (index === -1) continue;
				claimed.add(index);
				keys.add(pairKey(request.candidates[index].pair));
			}
			return { answered: true, selected: keys };
		} catch (error) {
			return {
				answered: false,
				reason: timedOut
					? "换届确认对话框 3 分钟内未获确认——按无人值守路径处理：全部域内 pairs 以 provisional 迁移，24h 内未批准自动回退。"
					: `换届确认对话框失败（${describeError(error)}）——按无人值守路径处理：全部域内 pairs 以 provisional 迁移，24h 内未批准自动回退。`,
			};
		} finally {
			clearTimeout(timer);
			request.signal?.removeEventListener?.("abort", forward);
		}
	}

	/** Phase A (§3.6.2). @returns `{ lines, token }` or `{ error }`. */
	async function prepare(request) {
		const { teamName, roleName, successor, note, caller, now } = request;
		const view = policy.get();
		const team = view.teams.find((entry) => entry.name === teamName) ?? null;
		if (team === null) return { error: `prepare 失败：团队 ${teamName} 不在注册表中（先用 team_link_roster action=upsert-team 创建）。` };
		const entry = roleOf(team, roleName);
		if (entry === null) return { error: `prepare 失败：团队 ${teamName} 没有角色 ${roleName}（先用 team_link_roster action=set-role 指定现任）。` };
		const gate = rotateGate(team, entry, caller);
		if (gate.error !== undefined) return { error: gate.error };
		if (successor === entry.current) {
			return { error: `prepare 失败：继任者不能是现任自己（${successor}）——自换会先把现任的 pairs/trustedSenders/rememberTargets 全部吊销，再以 provisional 迁回，等于一次没有意义的信任重建。换人请指定另一个会话；纯粹的降低信任用 team_link_roster action=retire。` };
		}
		const limited = rotationRateLimited(entry, now);
		if (limited.limited) {
			return { error: `prepare 失败：换届速率限制（§3.6.2 rateLimit(team, role, 10min)，防换届风暴）——${limited.reason}。请等窗口结束，或先让当前 pending 被认领/过期清扫。` };
		}
		const token = randomUUID();
		const pending = { session: successor, token, team: teamName, role: roleName, expiresAt: now + ROTATION_TTL_MS, createdAt: now, migratedPairs: [] };
		if (note !== undefined) pending.note = note;
		const backup = {
			at: now,
			pairs: view.pairs.map((pair) => ({ ...pair })),
			trustedSenders: [...view.trustedSenders],
			rememberTargets: [...view.rememberTargets],
			roster: structuredClone(team),
		};
		const nextTeam = { ...team, rotationBackup: backup, roles: team.roles.map((record) => (record.role === roleName ? { ...record, pending } : record)) };
		try {
			await policy.update({ teams: view.teams.map((record) => (record.name === teamName ? nextTeam : record)) });
		} catch (error) {
			return { error: `prepare 失败：写入设置失败（${describeError(error)}）——未生成令牌，也未广播冻结。` };
		}
		const mirror = await writeRosterMirror(nextTeam);
		const notice = await broadcastNotice(teamName, caller, freezeNotice(teamName, roleName, caller, successor, now), { signal: request.signal });
		return {
			token,
			lines: [
				`换届包已就绪：团队 ${teamName} 的角色 ${roleName}，现任 ${entry.current} → 继任者 ${successor}（读数 ${readStamp(now)}）。`,
				`令牌（一次性，30 分钟内有效）：${token}`,
				`此后一切渲染都是掩码形式 ${maskToken(token)}——完整令牌只在本条返回里出现这一次（roster get 与 roster.md 镜像都只给掩码）。`,
				`把令牌随交接 prompt 交给 ${successor}（交接内容——prompt / 交接文档——由你起草：机制与判断分离，§3.6.2）。`,
				`继任者拿到令牌后调用：team_link_rotate action=claim，team=${teamName}，role=${roleName}，token=<令牌>。`,
				`提交时间与状态（§3.6.1 原则 1）：令牌绑定 (team, role, successor)，30 分钟 TTL；过期未认领由清扫自动取消并解除冻结；成功认领后立即作废。`,
				"提示继任者：上任首个动作建议 /goal resume 或新建 goal（armed-active = 内建心跳，防重蹈 00:31 的静默；插件绝不代调 goals.resume，§3.7 合规 resume 回路）。",
				"错峰默认（§3.6.1）：先换协调者 → 稳定 → 再换 worker——任何时刻保留一个活记忆（纪律与协议上下文是最贵的重建物）。一次全换之前必须先跑上面的 FREEZE 清单，并把交接文档落盘。",
				`半自动兜底（§3.6.4）：本插件不能编程创建会话（V9 未验证）。若 ${successor} 还没开，请先在壳里新建会话、用 team_link_list_sessions 取它的会话 id 后重新 prepare；交接 prompt/交接文档由你起草，机制部分（令牌、迁移、广播、清理）全部由本工具承担。`,
				`撤销依据（rotationBackup）：已快照 ${now} 时的 pairs ${backup.pairs.length} 条 / trustedSenders ${backup.trustedSenders.length} 项 / rememberTargets ${backup.rememberTargets.length} 项与 roster。`,
				`冻结广播（rotation-freeze 固定清单）：${notice.summary}`,
				...notice.rows,
				mirrorNote(mirror),
			],
		};
	}
	/** The idempotent replay of a claim that already settled the roster (§3.6.2).
	 * The settlement (with its migratedPairs marker) is written in ONE update and
	 * the pending is cleared in the next, so a pending that survives next to a
	 * settled roster proves the previous claim did not finish its last step: the
	 * pairs are migrated, the roster is settled, and the only things left are the
	 * bookkeeping and — at worst — the rotation-done notice the team waits on to
	 * leave the freeze. The notice is therefore re-emitted here (at-least-once,
	 * never a second migration); a duplicate notice is noise, a missing one keeps
	 * workers frozen.
	 *
	 * 评审 #1 decides what "settled" means: `current === pending.session`. The
	 * migratedPairs marker is NOT the signal — a migration can legitimately add no
	 * record at all (no in-domain candidate, or every checked counterpart already
	 * paired with the successor), and that empty marker must not be mistaken for an
	 * unclaimed token. 评审 #4: the replay is the step that finishes the
	 * bookkeeping, so it rewrites the roster mirror too. */
	async function replayClaim(request) {
		const { teamName, roleName, entry, pending, now } = request;
		const view = policy.get();
		const settled = entry.current === pending.session;
		const clearedTeams = view.teams.map((record) => (record.name === teamName ? clearRotationPending(record, roleName) : record));
		let cleared = true;
		try {
			await policy.update({ teams: clearedTeams });
		} catch (error) {
			cleared = false;
		}
		// The outgoing holder is read from the revocation snapshot the prepare took
		// (the settled history no longer names it unambiguously): never invented.
		const snapshot = view.teams.find((record) => record.name === teamName)?.rotationBackup?.roster ?? null;
		const previousId = (snapshot?.roles ?? []).find((record) => record.role === roleName)?.current ?? null;
		const previous = previousId ?? "（旧任，见 rotationBackup）";
		const migrated = pending.migratedPairs ?? [];
		// 评审 #5 decided which words exist; 评审 #10 decides where they come from.
		// The claim recorded its verdict word on the role when it settled, so the
		// replay reads it back. Re-deriving it here was lossy: a dialog answered with
		// every candidate unchecked is ratified (已批准) yet migrates nothing and
		// opens no window, and the old derivation replayed it as 无待迁移对 — a
		// different word about the same rotation, which the waiting team reads.
		const status = rotationStatusOf(entry, migrated);
		const notice = settled
			? await broadcastNotice(teamName, pending.session, doneNotice(teamName, roleName, previous, pending.session, status, now), { signal: request.signal, alsoNotify: [previousId] })
			: { rows: ["  - （现任已另行变更，不再重复广播 rotation-done）"], summary: "0 投递（换届已被后续变更取代）" };
		const mirrorSource = (cleared ? clearedTeams : view.teams).find((record) => record.name === teamName);
		const mirror = mirrorSource === undefined ? { ok: false, error: `团队 ${teamName} 不在注册表中` } : await writeRosterMirror(mirrorSource);
		return {
			lines: [
				`claim 重放（同一令牌）：团队 ${teamName} 的角色 ${roleName} 的这次换届已由上一次 claim 完成落定——本次不重复迁移、不重复改动信任数据，只收尾。`,
				`已迁移的通道（${migrated.length} 条，记录来自 pending.migratedPairs）：`,
				...(migrated.length === 0
					? ["  - （无：上次 claim 没有迁移任何 pair——域内没有候选，或对端与继任者本已配对）"]
					: migrated.map((pair) => `  - ${pair.b} ↔ ${pair.a}（${pair.provisional ? "provisional，到期 " + readStamp(pair.expiresAt) : "正式通道"}）`)),
				`现任：${entry.current ?? "（空缺）"}（pending 记录的继任者 ${pending.session}）。`,
				cleared ? "pending 已清除（本次收尾完成）。" : "pending 清除失败：写入设置失败——重试 claim 即可（仍不会重复迁移）。",
				settled
					? `本轮通知：rotation-done 重发（${notice.summary}）。`
					: "本轮不广播 rotation-done：现任已不是这次换届的继任者，重发会与事实矛盾。",
				...notice.rows,
				mirrorNote(mirror),
				`（读数 ${readStamp(now)}，${READ_STALE_NOTE}）`,
			],
		};
	}

	/** Phase B (§3.6.2). @returns `{ lines }` or `{ error }`. */
	async function claim(request) {
		const { teamName, roleName, token, note, caller, now } = request;
		const view = policy.get();
		const team = view.teams.find((entry) => entry.name === teamName) ?? null;
		if (team === null) return { error: `claim 失败：团队 ${teamName} 不在注册表中。` };
		const entry = roleOf(team, roleName);
		if (entry === null) return { error: `claim 失败：团队 ${teamName} 没有角色 ${roleName}。` };
		const pending = entry.pending;
		if (pending === null || pending === undefined) {
			return { error: `claim 失败：团队 ${teamName} 的角色 ${roleName} 当前没有 pending——令牌尚未 prepare、已过期被清扫、或本次换届已认领成功并作废（§3.6.1 原则 1：成功即作废）。` };
		}
		if (pending.team !== teamName || pending.role !== roleName) {
			return { error: `claim 失败：令牌绑定不匹配——pending 绑定的是 (team=${pending.team}, role=${pending.role})，本次调用是 (team=${teamName}, role=${roleName})。令牌绑定三元组 (team, role, successor)，不匹配一律拒绝（§3.6.1 原则 1）。` };
		}
		if (caller === undefined || caller !== pending.session) {
			return { error: `claim 失败：只有 pending 指定的继任者会话 ${pending.session} 可以认领（当前调用会话 ${caller ?? "（无会话身份）"}）——主张权靠令牌，且必须由继任者会话本身发起（§3.6.1 原则 1）。` };
		}
		if (token !== pending.token) {
			return { error: "claim 失败：令牌不匹配（令牌一次性，只在 prepare 的返回里给出过一次；掩码形式 tok-xxxx…yyyy 不是令牌）。" };
		}
		// 评审 #1: the settled signal is `current === pending.session`, and it is read
		// here (before the expiry branch) because the two states it splits have
		// opposite truths — an unclaimed token is cancelled, a settled roster with a
		// stranded pending only needs its bookkeeping finished.
		const settled = entry.current === pending.session;
		if (pending.expiresAt > 0 && pending.expiresAt <= now) {
			// §3.6.2 评审 #4: an unclaimed token may not leave the team frozen —
			// run the cancellation for exactly this role, then refuse. The refusal
			// states what the sweep actually did: a settled roster is cleared
			// silently (nothing was cancelled), so it must not be described as a
			// cancelled hand-over that left the old incumbent in place.
			const swept = await sweep({ now, signal: request.signal, only: { team: teamName, role: roleName } });
			const tail = swept.lines.length === 0 ? "" : `\n${swept.lines.join("\n")}`;
			return { error: settled
				? `claim 失败：令牌已过期（到期 ${readStamp(pending.expiresAt)}，30 分钟有效）——但这次换届其实已经落定：current 已是继任者 ${pending.session}，只是 pending 残留（上次 claim 的最后一步没写完）。已按落定态静默清除 pending（不广播 rotation-cancelled——「换届未发生」与事实相反），冻结在落定那一刻就已解除。无需重新 prepare（换届已完成）；如果确实要再换一次，请由现任重新 prepare。${tail}`
				: `claim 失败：令牌已过期（到期 ${readStamp(pending.expiresAt)}，30 分钟有效）。已按过期清扫取消本次换届并广播 rotation-cancelled——旧任 ${entry.current} 仍为 current，冻结解除。${tail}请由现任重新 prepare。` };
		}

		const migrated = Array.isArray(pending.migratedPairs) ? pending.migratedPairs : [];
		// §3.6.2 评审 #1: a non-empty marker is not the only proof that the previous
		// claim already settled. A migration that added no record (no in-domain
		// candidate, or every checked counterpart already paired with the successor)
		// leaves `migratedPairs` empty, and re-running the migration path in that
		// state would treat the successor as the retiree and revoke the successor's
		// own pairs. `current === pending.session` cannot hold for a fresh pending
		// (prepare refuses a self-succession), so it is the settled signal.
		if (migrated.length > 0 || settled) {
			return await replayClaim({ teamName, roleName, team, entry, pending, now, signal: request.signal });
		}

		// ---- the single rotation dialog (§3.6.1 principle 4) ------------------
		const members = new Set(teamMembers(team));
		const plan = planRotationMigration(view, { members, retiree: entry.current, successor: pending.session });
		const exclusions = plan.dropped.length === 0
			? "退役者与团队外没有任何 pairs，全部相关 pairs 都在本次确认范围内。"
			: `以下 ${plan.dropped.length} 条 pairs 与退役者相关但不在迁移范围（随退役清理，不迁移）：${plan.dropped.map((item) => `${item.other}（${item.reason}）`).join("；")}。`;
		let ratified;
		let chosen;
		let ratification;
		if (plan.candidates.length === 0) {
			// 评审 #5: there is nothing to ratify, so no dialog is raised and no
			// approval is claimed — the status word says exactly that (below).
			ratified = true;
			chosen = [];
			ratification = "无域内待迁移对：未弹确认框（没有需要迁移的通道，因此没有任何确认被征求），全部与退役者相关的 pairs 随退役清理。";
		} else {
			const dialog = await askRotationDialog({
				candidates: plan.candidates,
				successor: pending.session,
				agent: request.agent,
				signal: request.signal,
				question: `团队 ${teamName} 的角色 ${roleName} 交接到 ${pending.session}（旧任 ${entry.current}）。勾选要迁移给新任的免确认通道（pairs）；未勾选的通道将随退役清理，今后该对端走正常首问门（发送方确认 + 接收方策略）。`,
				detail: `迁移后的通道是双向免确认通道，会绕过两道批准门——所以只迁移你确实要保留的对。候选 ${plan.candidates.length} 条，对端必须是本团队成员。${exclusions}`,
			});
			if (dialog.answered) {
				ratified = true;
				chosen = plan.candidates.filter((candidate) => dialog.selected.has(pairKey(candidate.pair)));
				ratification = `已获在场确认（单个对话框，逐项勾选 + 整批提交）：勾选 ${chosen.length} / 候选 ${plan.candidates.length} 条，迁移为正式通道（provisional=false）。`;
			} else {
				ratified = false;
				chosen = [...plan.candidates];
				ratification = `${dialog.reason}（全部 ${plan.candidates.length} 条域内候选以 provisional 迁移。）`;
			}
		}
		const provisional = !ratified;
		const selectedKeys = new Set(chosen.map((candidate) => pairKey(candidate.pair)));
		// The hand-over note: the claim's own note wins, the one prepare carried
		// through the pending is the fallback (§3.6.2 "history 追加（旧任 until=now+note）").
		const effectiveNote = note ?? pending.note;
		// §3.6.2 评审 #5 / #10: the verdict word is decided HERE — where the dialog
		// outcome and the candidate count are both still known — and handed to the
		// settlement, which records it on the role. A later replay reads the recorded
		// word instead of re-deriving it from state that cannot tell "a dialog was
		// answered with nothing checked" from "there was never a candidate".
		const status = plan.candidates.length === 0 ? ROTATION_STATUS_NONE : ratified ? "已批准" : "待批准(24h)";
		const trust = applyRotationTrust(view, { retiree: entry.current, successor: pending.session, chosen, now, provisional });
		const settlement = settleRotation(team, { role: roleName, now, note: effectiveNote, migratedPairs: trust.additions, provisional, status });
		const teams = view.teams.map((record) => (record.name === teamName ? settlement.team : record));
		try {
			// One write carries the trust lists AND the settled roster (with the
			// migratedPairs marker): the marker can therefore never exist without the
			// settlement, which is what makes the replay path below sound.
			await policy.update({ pairs: trust.pairs, trustedSenders: trust.trustedSenders, rememberTargets: trust.rememberTargets, teams });
		} catch (error) {
			return { error: `claim 失败：写入设置失败（${describeError(error)}）——迁移与落定是同一笔写入，本次没有产生任何变更；可用同一令牌重试。` };
		}
		let bookkeeping = "pending 已清除（migratedPairs 先落盘再清，崩溃重试走重放路径）。";
		const clearedTeams = teams.map((record) => (record.name === teamName ? clearRotationPending(record, roleName) : record));
		let cleared = true;
		try {
			await policy.update({ teams: clearedTeams });
		} catch (error) {
			cleared = false;
			bookkeeping = `pending 清除失败（${describeError(error)}）：迁移与落定已生效，pending 里留着 migratedPairs 记录——用同一令牌重放 claim 即完成收尾（不会重复迁移）。`;
		}
		// 评审 #4: the mirror is rendered from the roster the claim leaves behind, not
		// from the pre-clear copy — otherwise roster.md keeps advertising a pending
		// that no longer exists (the settings namespace, always the source of truth,
		// has none). When the clear itself failed the mirror stays truthful instead
		// and shows the pending that really is on disk; the next roster change
		// rewrites it anyway (§3.3.1 best-effort).
		const mirrorSource = (cleared ? clearedTeams : teams).find((record) => record.name === teamName) ?? settlement.team;
		const mirror = await writeRosterMirror(mirrorSource);
		// 评审 #6: the retiree is no longer anyone's `current`, so without the union it
		// would never learn that the hand-over it prepared actually completed.
		const notice = await broadcastNotice(teamName, pending.session, doneNotice(teamName, roleName, settlement.previous ?? "（旧任）", pending.session, status, now), { signal: request.signal, alsoNotify: [settlement.previous] });
		return {
			lines: [
				`换届完成（claim）：团队 ${teamName} 的角色 ${roleName}，旧任 ${settlement.previous} → 新任 ${pending.session}（读数 ${readStamp(now)}）。`,
				`信任迁移（域限定：仅「退役者 ↔ 同 team 成员」，§3.6.1 原则 2）：`,
				...(plan.candidates.length === 0
					? ["  - （域内没有待迁移的 pairs）"]
					: plan.candidates.map((candidate) => {
						// "Selected" is decided by the dialog answer, not by whether a new
						// record was written: a counterpart the successor is already paired
						// with migrates without a second record.
						if (!selectedKeys.has(pairKey(candidate.pair))) {
							return `  - ${candidate.other} ↔ ${entry.current} → 未迁移（未勾选）→ 已随退役清理；今后该对端走正常首问门。`;
						}
						const added = trust.additions.find((pair) => pair.b === candidate.other);
						if (added === undefined) {
							return `  - ${candidate.other} ↔ ${entry.current} → 已迁移（新任与该对端已有配对记录，未新增重复记录）。`;
						}
						return `  - ${candidate.other} ↔ ${entry.current} → 已迁移为 ${candidate.other} ↔ ${pending.session}（${provisional ? `provisional，24h 内未批准自动回退，到期 ${readStamp(added.expiresAt)}` : "正式通道"}）。`;
					})),
				...(plan.dropped.length === 0
					? []
					: plan.dropped.map((item) => `  - ${item.other} ↔ ${entry.current} → 未迁移（${item.reason}）→ 已随退役清理。`)),
				`对称撤销（§3.6.1 原则 3）：退役者 ${entry.current} 持有的 pairs ${trust.removed.length} 条已全部清除（其中迁移 ${trust.additions.length} 条）；trustedSenders 移除 ${trust.revoked.trustedSenders.length} 项；rememberTargets 移除 ${trust.revoked.rememberTargets.length} 项。`,
				`批准状态：${ratification}`,
				`roster 落定：${roleName}.current = ${pending.session}；版本史新增旧任 until=${readStamp(now)}${effectiveNote === undefined ? "" : `（备注：${preview(effectiveNote, 200)}）`}；${bookkeeping}`,
				provisional
					? `provisional 回退窗口：${readStamp(now + ROTATION_PROVISIONAL_TTL_MS)} 到期。到期未批准 → 迁移的 pairs 自动删除、version history 记「${ROTATION_PROVISIONAL_NOTE}」、广播 rotation-expired；${pending.session} 保持 current，信任回退为过门投递（§3.6.2 评审 #5 终态）。补批准：在设置 UI 把该 pair 的 provisional 置 false 即转正式（回退前有效；已转正式的窗口到期时静默关闭，不记版本史、不广播 rotation-expired——没有回退发生）。`
					: status === ROTATION_STATUS_NONE
						? "回退窗口：本次换届没有新建任何通道（域内无待迁移对），因此没有 provisional 回退窗口——回退窗口只随迁移出的 pair 产生。"
						: "迁移的 pairs 已是正式通道（无回退窗口）。",
				`通知广播（rotation-done，新任为发送方）：${notice.summary}`,
				...notice.rows,
				mirrorNote(mirror),
				`（读数 ${readStamp(now)}，${READ_STALE_NOTE}）`,
			],
		};
	}

	/**
	 * The expiry half of §3.6.2 (评审 #4/#5), hung on the same patrol timer as the
	 * M1 watchdog and touched lazily by every roster touch, rotate call and team
	 * read. It cancels a pending nobody claimed inside its 30 minutes (which
	 * releases the freeze), and closes a provisional window whose 24h ratification
	 * window ran out.
	 *
	 * The notice sender is the role's current holder — "旧任仍为 current" for a
	 * cancellation, and the successor for an expiry — because that is the session
	 * the notice is factually about, and it is the identity the receivers' gates
	 * (pairing / trustedSenders) were already established against. A leftover
	 * pending whose role is already settled is only bookkeeping: it is cleared
	 * silently, because the CANCELLED notice would state the opposite of the truth.
	 *
	 * @returns `{ cancelled, expired, closed, lines }` — the three actions the pass
	 *   took (a cancellation, a rollback, a silent window close), so a caller can
	 *   assert on the decision and not only on its text. 评审 #8 adds a fourth,
	 *   unconditional one: every expired provisional pair is deleted even when no
	 *   role needed bookkeeping (a hand-deleted window leaves that as the only work).
	 */
	async function sweep(options = {}) {
		const now = typeof options.now === "number" ? options.now : Date.now();
		const only = options.only ?? null;
		const except = options.except ?? null;
		const view = policy.get();
		const cancelled = [];
		const expired = [];
		const closed = [];
		// §3.6.2 评审 #1: a settled pending is cleared with no notice and no row, so it
		// is invisible in the three lists above — without this flag the pass would
		// return before writing and the pending would come back on the next read.
		// 评审 #8: this flag guards the TEAMS write only; the doomed-pair deletion
		// below is decided on its own and must not depend on any role bookkeeping.
		let touched = false;
		const teams = view.teams.map((team) => ({ ...team, roles: team.roles.map((entry) => ({ ...entry })) }));
		for (const team of teams) {
			if (only !== null && team.name !== only.team) continue;
			for (const entry of team.roles) {
				if (only !== null && entry.role !== only.role) continue;
				if (except !== null && except.team === team.name && except.role === entry.role) continue;
				const pending = entry.pending;
				if (pending !== null && pending !== undefined && pending.expiresAt > 0 && pending.expiresAt <= now) {
					// §3.6.2 评审 #1: `current === pending.session` alone is the settled
					// signal. A rotation whose migration added no record (no in-domain
					// candidate, or every checked counterpart already paired with the
					// successor) leaves `migratedPairs` empty, so requiring a non-empty
					// marker would read a settled roster as an unclaimed token and
					// broadcast the exact opposite of the truth ("旧任仍为 current").
					const settled = entry.current === pending.session;
					entry.pending = null;
					touched = true;
					if (!settled) {
						// §3.6.2 评审 #6: the session the hand-over was prepared for, read
						// from the revocation snapshot (never invented). For a plain
						// cancellation it is the role's current holder again — already a
						// member and the sender of this notice — so the union only bites
						// when set-role moved the role on while the token was in flight.
						const backupRoles = team.rotationBackup?.roster?.roles;
						const snapshotIncumbent = (Array.isArray(backupRoles) ? backupRoles.find((record) => record.role === entry.role)?.current : null) ?? null;
						cancelled.push({ team: team.name, role: entry.role, incumbent: entry.current, caller: pending.session, snapshotIncumbent });
					}
				}
				const provisional = entry.provisional;
				if (provisional !== null && provisional !== undefined && provisional.expiresAt > 0 && provisional.expiresAt <= now) {
					const successor = provisional.session !== "" ? provisional.session : entry.current;
					entry.provisional = null;
					touched = true;
					// §3.6.2 评审 #2: the window only has something to roll back while
					// its migration is STILL provisional and past its deadline.
					// Ratifying is a settings-UI edit that flips `pair.provisional`
					// alone (README「补批准」), so the role's window can run out with
					// nothing left to delete — and then both the version-history entry
					// and the rotation-expired notice ("迁移的 pairs 已删除") would be
					// false. That case closes the window silently: no history entry,
					// no broadcast, because no rollback happened and the plugin never
					// observed the ratification it would have to name.
					if (doomedProvisionalPairs(view.pairs, successor, now).length === 0) {
						closed.push({ team: team.name, role: entry.role, successor });
					} else {
						const history = entry.history.map((record) => ({ ...record }));
						history.push({ session: successor ?? "（未知）", from: provisional.at, until: now, note: ROTATION_PROVISIONAL_NOTE });
						entry.history = history;
						expired.push({ team: team.name, role: entry.role, successor });
					}
				}
			}
		}
		// §3.6.2 评审 #8: the doomed pairs are computed BEFORE the write guard, and
		// deleted whether or not the pass found any role bookkeeping to do. A user can
		// hand-delete a role's `provisional` window (or the whole role/team row) in the
		// settings UI while the pairs it granted stay behind: the loop above then sets
		// nothing, `touched` stays false, and the old early return let the expired
		// channel survive forever — still riding the pair fast path and still bypassing
		// both gates, which is exactly the "24h 自动回退" promise going silently false.
		const doomed = view.pairs.filter((pair) => isExpiredProvisionalPair(pair, now));
		const patch = {};
		if (touched) patch.teams = teams;
		if (doomed.length > 0) {
			const keys = new Set(doomed.map(pairKey));
			patch.pairs = view.pairs.filter((pair) => !keys.has(pairKey(pair)));
		}
		if (Object.keys(patch).length === 0) return { cancelled, expired, closed, lines: [] };
		try {
			await policy.update(patch);
		} catch (error) {
			return { cancelled: [], expired: [], closed: [], lines: [`换届过期清扫写入失败（${describeError(error)}）：本次未生效，下次巡逻/roster 触碰会重试。`] };
		}
		const lines = [];
		for (const item of cancelled) {
			// §3.6.2 评审 #6: the recipients are the members UNION the session the
			// hand-over was prepared for (see the push above) — the freeze was raised
			// at that session's request, so its release belongs in its inbox too.
			const notice = await broadcastNotice(item.team, item.incumbent, cancelledNotice(item.team, item.role, item.incumbent ?? "（空缺）", item.caller, now), { signal: options.signal, alsoNotify: [item.snapshotIncumbent] });
			lines.push(`- 令牌过期取消：团队 ${item.team} 的角色 ${item.role}（旧任 ${item.incumbent ?? "（空缺）"} 仍为 current，已广播 rotation-cancelled：${notice.summary}）`);
			lines.push(...notice.rows);
		}
		for (const item of expired) {
			const notice = await broadcastNotice(item.team, item.successor, expiredNotice(item.team, item.role, item.successor ?? "（空缺）", now), { signal: options.signal });
			lines.push(`- provisional 未批准回退：团队 ${item.team} 的角色 ${item.role}（迁移的 pairs 已删除，${item.successor ?? "（空缺）"} 仍为 current，已广播 rotation-expired：${notice.summary}）`);
			lines.push(...notice.rows);
		}
		for (const item of closed) {
			lines.push(`- provisional 窗口静默关闭：团队 ${item.team} 的角色 ${item.role}（域内已无待回退的 provisional pair——迁移已转正式、或本次换届本就没有新建通道；未记版本史、未广播 rotation-expired）`);
		}
		return { cancelled, expired, closed, lines };
	}

	return { prepare, claim, sweep, broadcastNotice };
}

/** Token argument reading (§3.6.2): a one-time opaque string. The masked display
 * form `tok-xxxx…yyyy` is deliberately NOT accepted — it is a rendering, and the
 * whole point of the mask is that the rendering is not the token. */
function readRotationToken(value) {
	if (typeof value !== "string" || value.trim() === "") {
		return { error: "需要 token（prepare 返回的一次性令牌；掩码形式 tok-xxxx…yyyy 不是令牌）。" };
	}
	const token = value.trim();
	if (/[\u0000-\u001F\u007F\s]/u.test(token)) return { error: "token 不能包含空白或控制字符。" };
	return { value: token };
}
// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

/** Register the M1 model-facing tools on the tools service: the listing with its
 * liveness rows, the export, the cross-session send and the watchdog (§3.1/§3.2). */
function registerTools(ctx, policy, watchdog) {
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_list_sessions",
		description: "列出当前工作区（同目录）的其他 DSH 会话：id、标题/主题摘要、运行状态、创建时间、最近动态，以及每个会话的活性信号行（verdict 五态：ok / goal-disarmed / silent-idle / long-running / dead，含 goal 状态与静默时长）。会话日志只读前 12 个会话且并行读，第 13 行起的活性行标「未读（超出快照窗口）」（verdict/静默/主题均未判定，行本身照常列出）；供跨会话导出、发送前查目标、或判断队友是否失联。读数是快照：行尾附读数时间戳，超过 2 分钟应重新读取。",
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
				// One surface read per row of the WINDOW feeds both faces below: the
				// liveness signal (§3.1) needs the last assistant/inbound times and the
				// running turn's start, and the digest folds the same surface into a
				// topic + last-activity preview. A cold or unreadable log is not an
				// error here — both faces degrade to "unknown" and the row still lists.
				//
				// The window is what keeps this tool inside its budget: a cold log costs a
				// zstd decompression plus a surface projection, so reading one per listed
				// session (LIST_LIMIT = 50) overruns the tool timeout on a real workspace.
				// Rows past the window still list, and their liveness line says the row was
				// not read (LV_WINDOW_NOTE).
				const readWindow = shown.slice(0, PREVIEW_SESSIONS);
				// Parallel, not serial: a window of N cold logs costs one decompression's
				// latency, not N. Each read settles alone (an async executor turns even a
				// synchronous throw into a rejection), so one failing log cannot take the
				// rest of the window's liveness rows down with it.
				const settled = await Promise.allSettled(readWindow.map(async (record) => await ctx.sessionQuery.readSurface(record.header.id)));
				const surfaces = new Map();
				for (let index = 0; index < readWindow.length; index += 1) {
					const outcome = settled[index];
					if (outcome.status === "fulfilled") surfaces.set(readWindow[index].header.id, outcome.value);
				}
				const topics = new Map();
				const activities = new Map();
				for (const record of readWindow) {
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
				// §3.6.2 评审 #3 (provisional 可见面): an unratified rotation channel is
				// marked on the session row of both parties, so a worker can see that a
				// message arriving over it rides trust that rolls back in 24h.
				// 口径与投递侧对齐（§9.6 ⑧ / 评审 #8）: a provisional record past its
				// deadline is NOT a pair any more — the delivery path already walks the
				// ordinary gates for it. Counting it here would advertise a bypass
				// channel that has already closed (exactly the window between the 24h
				// deadline and the next sweep), so the row uses the same liveness
				// predicate as `pairRecordBetween`.
				const provisionalBySession = new Map();
				for (const pair of policy.get().pairs) {
					if (pair.provisional !== true) continue;
					if (isExpiredProvisionalPair(pair, now)) continue;
					provisionalBySession.set(pair.a, (provisionalBySession.get(pair.a) ?? 0) + 1);
					provisionalBySession.set(pair.b, (provisionalBySession.get(pair.b) ?? 0) + 1);
				}
				const lines = [];
				lines.push(`当前工作区：${cwd}${selfId !== undefined ? `（当前会话：${selfId}）` : ""}`);
				lines.push(`共 ${pool.length} 个其他会话${pool.length > shown.length ? `，按新到旧显示前 ${shown.length} 个` : ""}：`);
				lines.push("");
				if (shown.length === 0) lines.push("（无）");
				for (let index = 0; index < shown.length; index += 1) {
					const record = shown[index];
					const header = record.header;
					const agent = ctx.agents.get(header.id);
					const running = agent?.status === "running";
					const state = running ? "▶ 运行中" : agent !== undefined ? "○ 空闲" : "✕ 未运行";
					const origin = header.origin === "subagent" ? " [子代理]" : "";
					const title = titles.get(header.id);
					const other = args.includeOtherProjects === true && header.cwd !== cwd ? ` · ${header.cwd}` : "";
					const provisionalCount = provisionalBySession.get(header.id) ?? 0;
					const provisionalNote = provisionalCount === 0 ? "" : ` · provisional 配对 ${provisionalCount} 条（换届临时信任：24h 内未批准自动回退，见 team_link_roster）`;
					lines.push(`- ${header.id}${origin} — ${state}${title !== undefined ? `「${title}」` : ""} · 创建于 ${new Date(header.createdAt).toLocaleString()}${other}${provisionalNote}（读数 ${readStamp(now)}，${READ_STALE_NOTE}）`);
					const topic = topics.get(header.id);
					if (topic !== undefined) lines.push(`    主题：${preview(topic, 90)}`);
					const activity = activities.get(header.id);
					if (activity !== undefined && activity !== topic) lines.push(`    最近：${preview(activity, 90)}`);
					// A row past the read window (index >= readWindow.length, which is
					// exactly the rows whose surface we chose not to read) labels itself
					// unread: a verdict built on a missing surface is a reading nobody took,
					// and printing one would hide the bound instead of declaring it (§3.1).
					if (index >= readWindow.length) {
						lines.push(`    活性：${LV_WINDOW_NOTE}`);
					} else {
						const signal = buildLivenessSignal(ctx, header.id, { now, agent, surface: surfaces.get(header.id) });
						lines.push(`    活性：${livenessLine(signal)}`);
					}
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
		description: "向一个或多个会话发送跨会话消息（多会话联调用）。寻址二选一：targetSessionId（单目标）或 targets（广播 fan-out，≤8 项）——每项可以是会话 id、team:<name>/<role> 或 team:<name>/*。team:<name>/* 全队广播只能由该团队现任协调者会话发起（策展理由见《调研》§5.3 论据 (a)），否则整次调用拒绝；team:<name>/<role> 任何会话都可点对点，角色当前空缺时返回 no-holder 结果（不算投递也不算失败）；团队不存在则整次调用拒绝。fan-out 逐目标照走完整投递路径（双门、配对快路径、屏蔽检查都不放宽），返回逐目标结果行与末行汇总；**只要有一个目标不是 delivered，返回文案的首行就是「❌ N 个目标未投递（M 个已投递）」**，之后才是逐目标结果行与汇总——全部投递成功时才维持原形状；重复目标去重后只投一次并在汇总注明。目标会话没有活动代理时（常见成因：目标 id 转录错位）拒绝文案以「❌ 未投递」开头，并列出当前同工作区其他存活会话（id + 运行中/空闲）与核对提示——它不是「已发送」，请对照列表确认 id 后再重发。可选 meta 信封 { type?: 'ruling'|'receipt'|'report'|'ask', pri?: 'P0'|'P1'|'P2', ref?: 不超过 16 字符 } 渲染进 banner 首行紧凑字段（只出现调用方给的键；source 仍恰好三成员，不扩字段），fan-out 时所有目标共享同一 meta。发送前需当前用户批准；目标运行中→消息在步边界注入其当前回合（steer，返回文案带该回合已运行的分钟数），空闲→唤醒目标作为新回合处理。已配对的两个会话互发免确认（接收确认时选「配对：双向免确认」即可建立）。",
		parameters: {
			targetSessionId: { type: "string", description: "目标会话 id（可用 team_link_list_sessions 查询）；与 targets 互斥" },
			targets: { type: "array", items: { type: "string" }, description: "广播 fan-out 的目标列表（最多 8 项）：会话 id、team:<name>/<role> 或 team:<name>/*（全队，仅该团队现任协调者会话）；与 targetSessionId 互斥" },
			message: { type: "string", required: true, description: "要投递的消息文本" },
			meta: { type: "json", description: "可选信封，渲染进 banner 首行（不扩 source）：{ type?: 'ruling'|'receipt'|'report'|'ask', pri?: 'P0'|'P1'|'P2', ref?: string }。只出现调用方给的键；ref 超过 16 字符按码点截断并在返回文案注明；枚举外的值与未定义字段一律拒绝（明确参数错误，不静默丢弃）" },
		},
		output: textOutput(),
		async execute(args, exec) {
			const text = args.message;
			const sender = exec?.agent;
			if (sender === undefined || ctx.agents.get(sender.id) !== sender) {
				return "发送失败：跨会话发送需要用户批准，但当前执行上下文没有可交互的活动代理。";
			}
			const meta = readMeta(args.meta);
			if (meta.error !== undefined) return wellFormed(`发送失败：${meta.error}`);
			const wantsTargets = args.targets !== undefined && args.targets !== null;
			const hasTarget = args.targetSessionId !== undefined && args.targetSessionId !== null;
			if (wantsTargets && hasTarget) {
				return "发送失败：targets（广播 fan-out）与 targetSessionId（单目标）互斥——一次调用只能用一种寻址方式。";
			}
			if (!wantsTargets && !hasTarget) {
				return "发送失败：需要 targetSessionId（单目标，沿用原有语义）或 targets（fan-out 广播，最多 8 个目标）之一。";
			}
			if (!wantsTargets) {
				// ---- single target: the legacy path, untouched ---------------------
				const outcome = await deliverToTarget(ctx, policy, sender, exec, args.targetSessionId, text, meta.value);
				return wellFormed(withMetaNotes(outcome.text, meta.notes));
			}
			// ---- §3.4 fan-out: resolve everything first, then deliver per target -
			const resolved = resolveTargetList(Array.isArray(args.targets) ? args.targets : [], policy.get().teams, sender.id, {
				isLive: (sessionId) => ctx.agents.get(sessionId) !== undefined,
			});
			if (resolved.error !== undefined) return wellFormed(`发送失败：${resolved.error}`);
			const report = await fanout(ctx, policy, sender, exec, { rows: resolved.rows, duplicates: resolved.duplicates, meta: meta.value, payload: text });
			for (const note of meta.notes) report.lines.push(`注意：${note}`);
			return wellFormed(report.lines.join("\n"));
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

/**
 * Serve `GET /team-link/export?session=<id>&format=md|json` downloads.
 *
 * §9.1.3 third site: the same time-of-activation race as the policy store. The
 * route used to be registered only if `webServer` happened to be active at
 * apply time; today it usually is (the absence of this function's warn in the
 * logs is the evidence), but the ordering is not guaranteed by anything. So the
 * service is taken through the same late-attach pattern — immediate try, then
 * `ctx.inject(["webServer"], …)` — while the pre-existing degradation stands:
 * no `webServer` ever ⇒ one warn, no route, and the export tool keeps working.
 */
function registerExportRoute(ctx) {
	/** Mount the route on the context that actually holds the service. */
	function mount(target) {
		const webServer = target.get?.("webServer");
		if (webServer === undefined || typeof webServer.register !== "function") return false;
		// The effect belongs to the context the service was found on, so a
		// late-attached route is disposed with its own injection fiber.
		target.effect(() => webServer.register({
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
		return true;
	}

	// ① Fast path — webServer already active (the normal case on this host).
	if (mount(ctx)) return;
	// ② Not available (yet): one warn for the activation window, and wait for the
	// provider instead of sampling it once. Unlike `settings` there is no tool
	// call to retry from, so the injection is the whole retry story here.
	let warned = false;
	const warnUnavailable = (detail) => {
		if (warned) return;
		warned = true;
		ctx.logger?.warn?.(`${PLUGIN_LABEL}: webServer service unavailable at activation (${detail}) — header export button stays disabled unless it attaches later, the export tool keeps working.`);
	};
	if (typeof ctx.inject === "function") {
		ctx.inject(["webServer"], (child) => { if (!mount(child)) warnUnavailable("no register()"); });
	}
	warnUnavailable(ctx.get?.("webServer") === undefined ? "not yet active" : "no register()");
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
	// §9.1.3 调用点迁移：the one-time legacy migration is driven by the policy
	// store itself, from inside `attach` — calling it here would (as it did
	// before this fix, silently) run against a namespace that is not registered
	// yet whenever the settings provider is still initialising.
	const policy = createPolicyStore(ctx);
	// The M4 controller is built first: the watchdog patrol carries its expiry
	// sweep, and the roster/rotate tools call it lazily on every touch.
	const rotation = createRotation(ctx, policy);
	ROTATION_BY_CTX.set(ctx, rotation);
	const watchdog = createWatchdog(ctx, policy, rotation);
	WATCHDOG_BY_CTX.set(ctx, watchdog);
	registerDeepLinks(ctx);
	registerTools(ctx, policy, watchdog);
	registerTeamTools(ctx, policy, rotation);
	registerRotationTools(ctx, policy, rotation);
	registerExportRoute(ctx);
	// The patrol timers are this plugin's only background work, so they are armed
	// inside one effect: disposing the plugin (unload, reload, config teardown)
	// disposes every timer and the process-local tick state with it.
	ctx.effect(() => watchdog.start(), "team-link: watchdog patrol timers");
}

export { apply, inject, name };

/**
 * Internal surface for `host-half.test.mjs` only: the pure liveness/verdict
 * helpers, the live watchdog controller of a context, the pure roster /
 * blackboard helpers of §3.3, and the M3 broadcast helpers of §3.4/§3.5
 * (address resolution, envelope reading, busy guidance). Nothing else imports
 * it — the model-facing surface is exactly the registered tools.
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
	readMeta,
	metaBannerFields,
	resolveTargets,
	resolveTargetList,
	targetLabel,
	busyGuidance,
	readRoleName,
	pairRecordBetween,
	rotationFor: (ctx) => ROTATION_BY_CTX.get(ctx),
	maskToken,
	rotationRateLimited,
	rotateGate,
	teamMembers,
	planRotationMigration,
	applyRotationTrust,
	settleRotation,
	clearRotationPending,
	freezeNotice,
	doneNotice,
	cancelledNotice,
	expiredNotice,
});
