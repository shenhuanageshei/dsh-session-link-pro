// Unit smoke test for the dsh-team-link host half: drives the
// registered agent/pre-step listener through a real cordis waterfall with a
// stubbed sessionReferenceResolver (upstream deep-link behavior, unchanged),
// then exercises the three -pro tools against stubbed services.
// Run after the node_modules junctions are in place (see README).
import { Context } from "@deepseek-ai/cordis";
import { existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { apply, __testing } from "./lib/index.js";

let failures = 0;
/** Assertions executed in this run, printed at the end so the README figure is
 * checkable against the run instead of remembered (§9.6 ⑧). */
let assertions = 0;
function check(label, cond) {
	assertions += 1;
	console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
	if (!cond) failures += 1;
}

// ---------------------------------------------------------------------------
// shared stubs
// ---------------------------------------------------------------------------

const CWD = "C:/dev/demo";

function makeSenderAgent(status, cwd = CWD) {
	const calls = { injected: [], steered: [], followedup: [] };
	const agent = {
		id: "session-self",
		status,
		session: { header: { id: "session-self", cwd } },
		inject(message) { calls.injected.push(message); },
		steer(message) { calls.steered.push(message); },
		followup(message) { calls.followedup.push(message); },
	};
	return { agent, calls };
}

function makeTargetAgent(status = "idle") {
	const calls = { injected: [], steered: [], followedup: [] };
	const agent = {
		id: "session-target",
		status,
		session: { header: { id: "session-target", cwd: CWD } },
		inject(message) { calls.injected.push(message); },
		steer(message) { calls.steered.push(message); }, followup(message) { calls.followedup.push(message); },
	};
	return { agent, calls };
}

/**
 * Settings service stub covering the two namespaces the plugin registers
 * (`team-link` and, for the one-time rename migration, `session-link-pro`).
 * `register` returns the same `get()`/`update(patch)` scope shape the real
 * `settings` service does, so the policy store (and the watchdog list it now
 * carries) is exercised through its real settings path, not the memory fallback.
 * `seed` pre-fills a namespace's data at register time (the state a provider
 * would have loaded from disk), which is how U9 gives the rename migration
 * something to migrate without hand-writing a settings file.
 *
 * `F1` (`settingsRegisterThrows`) models a provider that IS active but refuses
 * `register` — the divergence-audit path where the store can never attach and
 * every lazy retry re-enters the catch. `legacyRegisterThrows` keeps the current
 * namespace working and refuses only `session-link-pro`, the one-line clause of
 * 评审 #4 (an unavailable legacy namespace must say so). `legacyGetThrows` is the
 * other half of that story (评审 round-2 🔵 #3): the legacy namespace registers
 * fine but cannot be READ, which is the branch that used to return with no log
 * at all.
 *
 * `markDead()` (评审 round-2 🟡 #1) models a provider that is gone: the scopes it
 * handed out stop serving. No test flips it by hand — the provider is mounted
 * through a real cordis plugin fiber (see `provideSettingsFiber`) and the fiber's
 * own teardown effect is what retires the stub.
 */
function makeSettings(seed = {}, { settingsRegisterThrows = false, legacyRegisterThrows = false, legacyGetThrows = false } = {}) {
	const namespaces = new Map();
	let alive = true;
	const guard = () => { if (!alive) throw new Error("settings provider disposed (its fiber was torn down)"); };
	return {
		namespaces,
		markDead() { alive = false; },
		service: {
			register(namespace, _schema, options = {}) {
				if (settingsRegisterThrows) throw new Error("register refused by stub");
				if (legacyRegisterThrows && String(namespace) === "session-link-pro") throw new Error("legacy namespace refused by stub");
				guard();
				const isLegacy = String(namespace) === "session-link-pro";
				const state = { base: structuredClone(options.base ?? {}), data: structuredClone(seed[String(namespace)] ?? {}) };
				namespaces.set(String(namespace), state);
				return {
					get() {
						guard();
						if (isLegacy && legacyGetThrows) throw new Error("legacy namespace unreadable by stub");
						return { ...structuredClone(state.base), ...structuredClone(state.data) };
					},
					async update(patch) { guard(); Object.assign(state.data, structuredClone(patch)); },
				};
			},
		},
	};
}

/** Scripted userQuestions service: ask() pops the next scripted answer. */
function makeUserQuestions(script) {
	const requests = [];
	return {
		service: {
			async ask(request) {
				requests.push(request);
				const next = script.shift();
				if (next === undefined) throw Object.assign(new Error("no scripted answer"), { code: "NO_PROVIDER" });
				// A scripted entry may be a FUNCTION: the case then runs while the dialog
				// is still pending, which is how the R1 retire race is reproduced (plugin
				// state changes between the dialog opening and the write-back).
				const choice = typeof next === "function" ? await next() : next;
				// An ARRAY entry is the multi-select answer (the M4 rotation dialog lists every
				// candidate pair as an option of ONE question); a scalar is the single-select
				// answer. Every question of a request gets the same scripted selection — which is
				// exactly one question for every caller in this file.
				const selected = Array.isArray(choice) ? [...choice] : [choice];
				return { answers: request.questions.map((question) => ({ id: question.id, selected: [...selected], custom: undefined })) };
			},
		},
		requests,
	};
}

/**
 * Capturing stand-in for cordis' LoggerService. §5.3 红线 is "a service that
 * fails to attach must leave a line", so the assertions need the lines
 * themselves rather than a console. Callable like the real `ctx.logger()`, so an
 * internal cordis `ctx.logger(...)` call cannot trip over the stub.
 */
function makeLogger() {
	const lines = { warn: [], info: [], error: [] };
	const logger = () => logger;
	for (const level of ["warn", "info", "error"]) logger[level] = (message) => { lines[level].push(String(message)); };
	return { lines, service: logger };
}

/**
 * @param surfaceReadHook - optional probe run at the START of every surface
 * read. The list tool's read window (§3.1: bounded to PREVIEW_SESSIONS, and
 * parallel) is asserted through it: a read sequenced behind the previous one
 * resolves with a different in-flight count than a parallel batch.
 */
function makeQuery(sessions, eventsBySession = {}, surfaceReadHook) {
	const query = {
		/** ids whose surface was read, in call order — the read-window bound. */
		surfaceReads: [],
		async listSessions(_signal) { return sessions; },
		async readTitleSnapshots(ids, _signal) {
			return ids.map((id) => ({ status: "fulfilled", value: { session: { id }, title: id === "session-target" ? "目标会话" : id === "session-runner" ? "跑着呢" : undefined } }));
		},
		async readSession(id) {
			const events = eventsBySession[id];
			if (events === undefined) throw new Error(`session not found: ${id}`);
			return { session: { id, createdAt: 1700000000000, cwd: CWD }, events };
		},
		async readSurface(id) {
			query.surfaceReads.push(id);
			if (surfaceReadHook !== undefined) await surfaceReadHook(id);
			const events = eventsBySession[id];
			if (events === undefined) throw new Error(`session not found: ${id}`);
			return { session: { id }, capturedThroughSeq: events.length, events };
		},
	};
	return query;
}

/** One macrotask of slack: enough for cordis' async fiber work and for the
 * attach-time policy chain (which is fire-and-forget by design) to settle. */
const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/**
 * Build a full plugin environment on a fresh cordis Context.
 *
 * `lateSettings` exists for U9 (§9.1.3/§9.1.4): the settings stub is created but
 * NOT provided before `apply`, so the run reproduces the production order
 * (plugin activates first, the settings provider finishes its `[Service.init]`
 * later). `provideSettings()` then does what the provider does once it is
 * active — `ctx.provide`, which is what fires the plugin's
 * `ctx.inject(["settings"], …)` callback. `lateWebServer` is the same fixture
 * for the second site of that race (the export route), and `noInject` drops
 * `ctx.inject` before `apply` to cover the documented "ctx.inject unavailable"
 * branch.
 */
function setup({ sessions = [], eventsBySession = {}, askScript = [], targetStatus = "idle", contextText = "SNIPPET", omitContext = false, goals, extraAgents = [], selfStatus, useSettings = false, lateSettings = false, lateWebServer = false, noInject = false, settingsSeed, settingsRegisterThrows = false, legacyRegisterThrows = false, legacyGetThrows = false, selfCwd, omitUserQuestions = false, surfaceReadHook, webServerWithoutRegister = false } = {}) {
	const ctx = new Context();
	// Every plugin log line lands in `log.lines` instead of the console: the
	// service-attach red line (§5.3) is asserted on the lines themselves.
	const log = makeLogger();
	ctx.logger = log.service;
	if (noInject) ctx.inject = undefined;
	const prepared = [];
	let failWith = null;
	const resolver = {
		async prepare(agent, content, references, signal) {
			if (failWith !== null) throw failWith;
			prepared.push({ references });
			return {
				content,
				additionalContext: omitContext ? undefined : { id: "injected-1", role: "user", source: { kind: "session-reference" }, content: [{ type: "text", text: contextText }] },
			};
		},
	};
	const registeredTools = [];
	const routes = [];
	const { agent: senderAgent, calls: senderCalls } = makeSenderAgent(selfStatus, selfCwd ?? CWD);
	const { agent: targetAgent, calls: targetCalls } = makeTargetAgent(targetStatus);
	const runnerAgent = { id: "session-runner", status: "running", session: { header: { id: "session-runner", cwd: CWD } } };
	// Extra agents are full message sinks (same shape as the target stub) so a
	// fan-out can be asserted target by target; `extraCalls` records what each
	// one received. `cwd` and `origin` default to the historic stub shape; a
	// fixture can place a peer in another workspace or shape it as a subagent,
	// which is what the no-agent hint list filters on.
	const extraCalls = new Map();
	const extraAgentObjects = extraAgents.map((entry) => {
		const calls = { injected: [], steered: [], followedup: [] };
		extraCalls.set(entry.id, calls);
		return {
			id: entry.id,
			status: entry.status,
			session: { header: { id: entry.id, cwd: entry.cwd ?? CWD, ...(entry.origin === undefined ? {} : { origin: entry.origin }) } },
			inject(message) { calls.injected.push(message); },
			steer(message) { calls.steered.push(message); },
			followup(message) { calls.followedup.push(message); },
		};
	});
	// `hidden` simulates a closed session (A4): the registration stays, but the
	// agent registry no longer resolves that id.
	const hidden = new Set();
	const agents = {
		get(id) {
			if (hidden.has(id)) return undefined;
			if (id === senderAgent.id) return senderAgent;
			if (id === targetAgent.id) return targetAgent;
			if (id === runnerAgent.id) return runnerAgent;
			return extraAgentObjects.find((candidate) => candidate.id === id);
		},
		/** Every live agent, in registration order — the registry face the
		 * no-agent refusal's hint list reads. A `hidden` id is a closed session:
		 * the fixture keeps its registration, so list() must not advertise it. */
		list() { return [senderAgent, targetAgent, runnerAgent, ...extraAgentObjects].filter((agent) => !hidden.has(agent.id)); },
		/** Live top-level agents. A subagent is created under an owning agent, so it
		 * is never a root — the hint list and the delivery guard share both this
		 * membership and the coarse `origin` class. */
		roots() { return [senderAgent, targetAgent, runnerAgent, ...extraAgentObjects.filter((agent) => agent.session?.header?.origin !== "subagent")]; },
	};
	const uq = makeUserQuestions(askScript);
	const settings = useSettings || lateSettings ? makeSettings(settingsSeed, { settingsRegisterThrows, legacyRegisterThrows, legacyGetThrows }) : undefined;
	ctx.provide("sessionReferenceResolver", resolver);
	ctx.provide("tools", { register(tool) { registeredTools.push(tool); return () => {}; } });
	const query = makeQuery(sessions, eventsBySession, surfaceReadHook);
	ctx.provide("sessionQuery", query);
	ctx.provide("agents", agents);
	// `omitUserQuestions` models a shell without the confirmation service (the
	// M2 retirement cleanup and the M1 send gates must both degrade, not crash).
	if (!omitUserQuestions) ctx.provide("userQuestions", uq.service);
	// `lateWebServer` models the second site of the same race (§9.1.3): the
	// header export route is taken from the runtime channel too.
	// `webServerWithoutRegister` (评审 round-3 🔵 #4) models the other reason code
	// of that seam: a service that IS there but cannot take a route — the branch
	// whose wording must come from the same single read.
	const webServerService = webServerWithoutRegister ? {} : { register(route) { routes.push(route); return () => {}; } };
	if (!lateWebServer) ctx.provide("webServer", webServerService);
	if (settings !== undefined && !lateSettings) ctx.provide("settings", settings.service);
	// The `goals` service is optional by design (§3.1): absent here means the
	// degraded path, present means a goal view (or `undefined` for "no goal").
	if (goals !== undefined) ctx.provide("goals", { get(agent) { return goals[agent.id]; } });
	apply(ctx);
	const tool = (name) => registeredTools.find((candidate) => candidate.name === name);
	/** U9 handle: the settings provider going active AFTER the plugin loaded. */
	const provideSettings = async () => {
		ctx.provide("settings", settings.service);
		await new Promise((resolve) => { setTimeout(resolve, 0); });
	};
	/** Same handle for the webServer provider (the export route's race). */
	const provideWebServer = async () => {
		ctx.provide("webServer", webServerService);
		await new Promise((resolve) => { setTimeout(resolve, 0); });
	};
	/** 评审 round-2 🟡 #1 handle: mount the settings stub as a REAL cordis plugin
	 * fiber, so `fiber.dispose()` retires the service through cordis itself (which
	 * deactivates the plugin's `ctx.inject(["settings"], …)` fiber — the event the
	 * store's lifetime binding must react to). Mounting a fresh stub afterwards
	 * models the provider coming back with a new service instance. No hand-rolled
	 * "disposed" switch is involved: the stub only loses its backing store because
	 * the effect below runs when that fiber is torn down. */
	const provideSettingsFiber = async (stub = settings) => {
		const fiber = ctx.plugin({
			name: "settings-provider-stub",
			apply(providerCtx) {
				providerCtx.provide("settings", stub.service);
				providerCtx.effect(() => () => stub.markDead(), "settings-provider-stub: provider teardown");
			},
		});
		await fiber.await();
		await tick();
		return fiber;
	};
	return { ctx, prepared, setFailWith: (error) => { failWith = error; }, setHiddenAgent: (id, value) => { if (value) hidden.add(id); else hidden.delete(id); }, registeredTools, routes, senderAgent, senderCalls, targetAgent, targetCalls, uq, tool, settings, log, query, provideSettings, provideSettingsFiber, provideWebServer, agentFor: (id) => agents.get(id), extraCalls };
}

function execFor(agent) {
	return { agent, signal: new AbortController().signal };
}

// ---------------------------------------------------------------------------
// upstream deep-link behavior (cases 1-9, unchanged expectations)
// ---------------------------------------------------------------------------

const sessions = [
	{ header: { id: "session-target", createdAt: 1000, cwd: CWD }, live: true, persisted: true },
	{ header: { id: "session-runner", createdAt: 2000, cwd: CWD }, live: true, persisted: true },
	{ header: { id: "session-cold", createdAt: 3000, cwd: CWD }, live: false, persisted: true },
	{ header: { id: "session-other", createdAt: 4000, cwd: "D:/elsewhere" }, live: false, persisted: true },
];
const previewEvents = [
	{ type: "user/message", seq: 1, time: 1, data: { id: "p1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "帮我优化会话导出功能" }] } },
	{ type: "assistant/message", seq: 2, time: 2, data: { turn: 1, step: 1, message: { id: "p2", role: "assistant", source: { kind: "model", provider: "p", model: "m" }, content: [{ type: "text", text: "导出已完成优化。" }] } } },
];
const env = setup({ sessions, eventsBySession: { "session-target": previewEvents } });

// Case 1: web deep link in a direct user prompt → context injected before prompt.
const prompt1 = { id: "m1", role: "user", source: { kind: "user", rpcId: "r1" }, content: [{ type: "text", text: "请参考 http://127.0.0.1:3080/s/session-abc123 继续" }] };
const decision1 = await ctx_waterfall(env.ctx, { messages: [prompt1], turn: 1, step: 1 });
check("decision is enter", decision1.kind === "enter");
check("context injected before prompt", decision1.messages.length === 2 && decision1.messages[0].id === "injected-1" && decision1.messages[1].id === "m1");
check("prompt text normalized to @label", decision1.messages[1].content[0].text === "请参考 @session-abc123 继续");
check("references parsed", env.prepared.length === 1 && env.prepared[0].references[0].sessionId === "session-abc123");

// Case 2: plain message without links → untouched, no prepare call.
const prompt2 = { id: "m2", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "普通消息" }] };
const decision2 = await ctx_waterfall(env.ctx, { messages: [prompt2], turn: 2, step: 1 });
check("plain message untouched", decision2.messages.length === 1 && decision2.messages[0].content[0].text === "普通消息");
check("no extra prepare", env.prepared.length === 1);

// Case 3: context (non-user) message with a link is ignored.
const contextMsg = { id: "c1", role: "user", source: { kind: "plugin" }, content: [{ type: "text", text: "http://127.0.0.1:3080/s/session-xyz" }] };
const decision3 = await ctx_waterfall(env.ctx, { messages: [contextMsg], turn: 3, step: 1 });
check("context message ignored", decision3.messages.length === 1);

// Case 4: malformed canonical URI must not break the turn.
const prompt4 = { id: "m4", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "dsh-session:garbage-not-json 消息" }] };
const decision4 = await ctx_waterfall(env.ctx, { messages: [prompt4], turn: 4, step: 1 });
check("malformed URI keeps turn intact", decision4.kind === "enter" && decision4.messages.length === 1);
check("malformed URI left as text", decision4.messages[0].content[0].text === "dsh-session:garbage-not-json 消息");

// Case 5: prepare failure (self-reference) leaves the message untouched.
env.setFailWith(new Error("SESSION_REFERENCE_SELF_REFERENCE"));
const prompt5 = { id: "m5", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "参考 http://127.0.0.1:3080/s/session-self 会话" }] };
const decision5 = await ctx_waterfall(env.ctx, { messages: [prompt5], turn: 5, step: 1 });
check("prepare failure keeps turn intact", decision5.kind === "enter" && decision5.messages.length === 1);

// Case 6: canonical bare URI works.
env.setFailWith(null);
const uri = "dsh-session:InNlc3Npb24tMDY5Y2I2MmEtNTY4My00MDczLTlhYTMtNmZmZDZiMDc5NTNhIg";
const prompt6 = { id: "m6", role: "user", source: { kind: "user" }, content: [{ type: "text", text: `canonical ${uri} end` }] };
const decision6 = await ctx_waterfall(env.ctx, { messages: [prompt6], turn: 6, step: 1 });
check("canonical URI injected", decision6.messages.length === 2 && decision6.messages[1].content[0].text === "canonical @session-069cb62a-5683-4073-9aa3-6ffd6b07953a end");

// Case 7: dsh:// deep link (the copied format) works.
const prompt7 = { id: "m7", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "参考 dsh://session/session-069cb62a-5683-4073-9aa3-6ffd6b07953a 会话" }] };
const decision7 = await ctx_waterfall(env.ctx, { messages: [prompt7], turn: 7, step: 1 });
check("dsh:// link injected", decision7.messages.length === 2 && decision7.messages[1].content[0].text === "参考 @session-069cb62a-5683-4073-9aa3-6ffd6b07953a 会话");

// Case 8: unrelated dsh:// URI without a session id is left as plain text.
const prompt8 = { id: "m8", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "app dsh://settings/theme 说明" }] };
const decision8 = await ctx_waterfall(env.ctx, { messages: [prompt8], turn: 8, step: 1 });
check("unrelated dsh:// untouched", decision8.messages.length === 1 && decision8.messages[0].content[0].text === "app dsh://settings/theme 说明");

// Case 9: dsh:// inside a markdown link destination is still resolved.
const prompt9 = { id: "m9", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "[看这个](dsh://session/session-abc123) 继续" }] };
const decision9 = await ctx_waterfall(env.ctx, { messages: [prompt9], turn: 9, step: 1 });
const text9 = decision9.messages[1].content[0].text;
check("dsh:// in markdown destination injected", decision9.messages.length === 2 && text9.includes("@session-abc123"));

// ---------------------------------------------------------------------------
// -pro: registration surface
// ---------------------------------------------------------------------------

check("four tools registered", ["team_link_list_sessions", "team_link_export", "team_link_send", "team_link_watch"].every((name) => env.tool(name) !== undefined));
check("export route registered", env.routes.length === 1 && env.routes[0].kind === "exact" && env.routes[0].path === "/team-link/export");

// ---------------------------------------------------------------------------
// -pro: list tool
// ---------------------------------------------------------------------------

const listTool = env.tool("team_link_list_sessions");
const listOut = await listTool.execute({}, execFor(env.senderAgent));
check("list shows same-project sessions", listOut.includes("session-target") && listOut.includes("session-runner") && listOut.includes("session-cold"));
check("list hides other-project sessions by default", !listOut.includes("session-other"));
check("list hides self", !listOut.includes("- session-self"));
check("list marks running/idle/cold", listOut.includes("▶ 运行中") && listOut.includes("○ 空闲") && listOut.includes("✕ 未运行"));
check("list includes folded titles", listOut.includes("「目标会话」") && listOut.includes("「跑着呢」"));
check("list shows session topic digest", listOut.includes("主题：") && listOut.includes("帮我优化会话导出功能"));
check("list shows last activity digest", listOut.includes("最近：") && listOut.includes("导出已完成优化。"));
const listAll = await listTool.execute({ includeOtherProjects: true }, execFor(env.senderAgent));
check("list includes other projects on request", listAll.includes("session-other") && listAll.includes("D:/elsewhere"));

// ---------------------------------------------------------------------------
// M1a (§3.1): liveness verdict table — the five states and both boundaries
// ---------------------------------------------------------------------------

const { verdictOf } = __testing;

/** Baseline signal; each case overrides only the field it is about. */
const signalFor = (over = {}) => ({
	agent: "idle",
	lastAssistantAt: null,
	lastInboundAt: null,
	turnStartedAt: null,
	goal: null,
	silenceMs: 0,
	verdict: "ok",
	...over,
});
const goalOf = (phase, activation, extra = {}) => ({ phase, activation, rounds: "3/70", blockedReason: null, ...extra });
const NOW = 1_700_000_000_000;
const verdict = (over, cfg = {}) => verdictOf(signalFor(over), { now: NOW, ...cfg });

check("verdict: no live agent → dead", verdict({ agent: "not-live" }) === "dead");
check("verdict: running with a fresh turn → ok", verdict({ agent: "running", turnStartedAt: NOW - 1000 }) === "ok");
check("verdict: running past 30min → long-running", verdict({ agent: "running", turnStartedAt: NOW - 31 * 60000 }) === "long-running");
check("verdict: running exactly at 30min → ok (strict >)", verdict({ agent: "running", turnStartedAt: NOW - 30 * 60000 }) === "ok");
check("verdict: running without a turn mark → ok", verdict({ agent: "running", turnStartedAt: null }) === "ok");
check("verdict: idle armed-active goal → ok (own cadence, §3.7)", verdict({ goal: goalOf("active", "armed"), silenceMs: 60 * 60000 }) === "ok");
check("verdict: idle active-but-disarmed → goal-disarmed without waiting for silence", verdict({ goal: goalOf("active", "disarmed"), silenceMs: 0 }) === "goal-disarmed");
check("verdict: idle paused goal → ok (silence already explained)", verdict({ goal: goalOf("paused", "disarmed"), silenceMs: 60 * 60000 }) === "ok");
check("verdict: idle blocked goal → ok (waiting on a human)", verdict({ goal: goalOf("blocked", "disarmed"), silenceMs: 60 * 60000 }) === "ok");
check("verdict: idle complete goal → ok", verdict({ goal: goalOf("complete", "disarmed"), silenceMs: 60 * 60000 }) === "ok");
check("verdict: idle silent past 10min with no goal → silent-idle (P1)", verdict({ silenceMs: 11 * 60000 }) === "silent-idle");
check("verdict: idle silent exactly at 10min → ok (strict >)", verdict({ silenceMs: 10 * 60000 }) === "ok");
check("verdict: goals service absent (goal=null) degrades to the no-goal branch", verdict({ goal: null, silenceMs: 11 * 60000 }) === "silent-idle");
check("verdict: goals service absent with recent activity → ok", verdict({ goal: null, silenceMs: 60000 }) === "ok");
check("verdict: phase none (service present, no goal) follows the no-goal branch", verdict({ goal: goalOf("none", "?"), silenceMs: 11 * 60000 }) === "silent-idle");
check("verdict: the silence threshold is configurable", verdictOf(signalFor({ silenceMs: 20 * 60000 }), { now: NOW, silentMin: 30 }) === "ok");

// ---------------------------------------------------------------------------
// M1a (§3.1): list_sessions liveness rows, goal states and the reading stamp
// ---------------------------------------------------------------------------

const NOW_REAL = Date.now();
const ancientEvents = (topic) => [
	{ type: "user/message", seq: 1, time: 1, data: { id: "u1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: topic }] } },
	{ type: "assistant/message", seq: 2, time: 2, data: { turn: 1, step: 1, message: { id: "a1", role: "assistant", source: { kind: "model", provider: "p", model: "m" }, content: [{ type: "text", text: "好的" }] } } },
];
const lvIds = ["session-lv-silent", "session-lv-armed", "session-lv-disarmed", "session-lv-paused", "session-lv-blocked", "session-lv-longrun", "session-lv-cold"];
const lvEnv = setup({
	sessions: lvIds.map((id, index) => ({ header: { id, createdAt: 1000 + index, cwd: CWD }, live: id !== "session-lv-cold", persisted: true })),
	eventsBySession: {
		"session-lv-silent": ancientEvents("silent"),
		"session-lv-armed": ancientEvents("armed"),
		"session-lv-disarmed": ancientEvents("disarmed"),
		"session-lv-paused": ancientEvents("paused"),
		"session-lv-blocked": ancientEvents("blocked"),
		"session-lv-longrun": [{ type: "turn/start", seq: 1, time: NOW_REAL - 31 * 60000, data: { turn: 1 } }],
	},
	extraAgents: lvIds.filter((id) => id !== "session-lv-cold").map((id) => ({ id, status: id === "session-lv-longrun" ? "running" : "idle" })),
	goals: {
		"session-lv-armed": { phase: "active", activation: "armed", roundsStarted: 12, maxGoalRounds: 70 },
		"session-lv-disarmed": { phase: "active", activation: "disarmed", roundsStarted: 3, maxGoalRounds: 70 },
		"session-lv-paused": { phase: "paused", activation: "disarmed", roundsStarted: 5, maxGoalRounds: 70 },
		"session-lv-blocked": { phase: "blocked", activation: "disarmed", roundsStarted: 70, maxGoalRounds: 70, blockedReason: { code: "round-limit", message: "round limit reached" } },
	},
});
const lvOut = await lvEnv.tool("team_link_list_sessions").execute({}, execFor(lvEnv.senderAgent));
check("liveness: every listed session carries one 活性 row", (lvOut.match(/^    活性：/gmu) ?? []).length === lvIds.length);
check("liveness: all five verdicts are rendered", ["verdict=silent-idle", "verdict=ok", "verdict=goal-disarmed", "verdict=long-running", "verdict=dead"].every((needle) => lvOut.includes(needle)));
check("liveness: goal phase/activation/rounds are rendered", lvOut.includes("goal=active/armed(12/70)") && lvOut.includes("goal=active/disarmed(3/70)"));
check("liveness: a blocked goal carries its durable blockedReason", lvOut.includes("goal=blocked/disarmed(70/70) blocked=round-limit: round limit reached"));
check("liveness: paused/blocked are shown as ok, never alarmed on", /session-lv-paused[\s\S]*?verdict=ok/u.test(lvOut) && /session-lv-blocked[\s\S]*?verdict=ok/u.test(lvOut));
check("liveness: dead session row is not-live and verdict=dead", /- session-lv-cold \u2014 ✕ 未运行/u.test(lvOut) && /session-lv-cold[\s\S]*?verdict=dead/u.test(lvOut));
check("liveness: the running turn start is shown", lvOut.includes("回合始于"));
check("liveness: the silence duration is shown in minutes", /静默 \d+\.\dmin/u.test(lvOut));
check("liveness: every session row ends with the reading stamp and the staleness window", (lvOut.match(/（读数 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}，>2min 作废）/gu) ?? []).length === lvIds.length);

const noGoalsEnv = setup({
	sessions: [{ header: { id: "session-lv-silent", createdAt: 1000, cwd: CWD }, live: true, persisted: true }],
	eventsBySession: { "session-lv-silent": ancientEvents("silent") },
	extraAgents: [{ id: "session-lv-silent", status: "idle" }],
});
const noGoalsOut = await noGoalsEnv.tool("team_link_list_sessions").execute({}, execFor(noGoalsEnv.senderAgent));
check("liveness: without the goals service the goal face degrades to ? and the list still works", noGoalsOut.includes("goal=?") && !noGoalsOut.includes("列出会话失败"));
check("liveness: without the goals service the no-goal verdict path still fires", noGoalsOut.includes("verdict=silent-idle"));

// ---------------------------------------------------------------------------
// §3.1 read window: the surface reads of the list tool are BOUNDED to
// PREVIEW_SESSIONS rows and run in PARALLEL (production bug: one SERIAL surface
// read per listed session — up to LIST_LIMIT = 50 cold zstd logs — overran the
// 60s tool timeout on a real 26-session workspace).
// ---------------------------------------------------------------------------

const WIN_IDS = Array.from({ length: 14 }, (_, index) => `session-win-${String(index).padStart(2, "0")}`);
// session-win-05 is deliberately unreadable INSIDE the window: one rejecting log
// must degrade that row alone, never the window around it.
const WIN_BROKEN = WIN_IDS[5];
const winEvents = Object.fromEntries(WIN_IDS.slice(0, 12).filter((id) => id !== WIN_BROKEN).map((id) => [id, ancientEvents(`窗口主题 ${id}`)]));
// The probe is the parallelism evidence: all 12 reads are started from one batch,
// so by the time the first of them resolves the counter already reads 12. A
// serial loop resolves its first read with the counter still at 1.
let winStarted = 0;
let winInFlightAtFirstResolve = 0;
const winEnv = setup({
	sessions: WIN_IDS.map((id, index) => ({ header: { id, createdAt: 1000 + index, cwd: CWD }, live: true, persisted: true })),
	eventsBySession: winEvents,
	extraAgents: WIN_IDS.map((id) => ({ id, status: "idle" })),
	surfaceReadHook: async () => {
		winStarted += 1;
		await new Promise((resolve) => setTimeout(resolve, 0));
		if (winInFlightAtFirstResolve === 0) winInFlightAtFirstResolve = winStarted;
	},
});
const winOut = await winEnv.tool("team_link_list_sessions").execute({}, execFor(winEnv.senderAgent));
const winRows = winOut.split(/\n(?=- session-win-)/u).filter((block) => block.startsWith("- session-win-"));
const winRowOf = (id) => winRows.find((block) => block.startsWith(`- ${id} `));

check("§3.1 window: readSurface is called for the first PREVIEW_SESSIONS rows and for no others", winEnv.query.surfaceReads.length === 12 && winEnv.query.surfaceReads.every((id, index) => id === WIN_IDS[index]) && !winEnv.query.surfaceReads.includes(WIN_IDS[12]));
check("§3.1 window: the 12 window reads run in PARALLEL — all of them were in flight before the first resolved", winStarted === 12 && winInFlightAtFirstResolve === 12);
check("§3.1 window: all 14 rows still list, each with exactly one 活性 line (rows past the window degrade, they are not dropped)", winRows.length === WIN_IDS.length && (winOut.match(/^    活性：/gmu) ?? []).length === WIN_IDS.length);
check("§3.1 window: row 13 (index 12) says it was not read instead of showing a verdict", (() => {
	const block = winRowOf(WIN_IDS[12]);
	return block !== undefined && block.includes(`活性：未读（超出快照窗口 12）`) && !block.includes("verdict=") && !block.includes("主题：");
})());
check("§3.1 window: a row past the window keeps its surface-free faces (id, agent state, creation time, reading stamp)", (() => {
	const block = winRowOf(WIN_IDS[13]);
	return block !== undefined && block.includes("○ 空闲") && block.includes("创建于") && /（读数 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}，>2min 作废）/u.test(block);
})());
check("§3.1 window: rows inside the window keep their computed verdict and digest", (() => {
	const tailRow = winRowOf(WIN_IDS[11]);
	return tailRow !== undefined && tailRow.includes("verdict=silent-idle") && tailRow.includes(`主题：窗口主题 ${WIN_IDS[11]}`);
})());
check("§3.1 window: one unreadable log inside the window degrades that row alone (unknown silence on it, the rows around it still read)", (() => {
	const broken = winRowOf(WIN_BROKEN);
	const neighbour = winRowOf(WIN_IDS[6]);
	return broken !== undefined && broken.includes("静默 ?") && neighbour !== undefined && neighbour.includes("verdict=silent-idle") && neighbour.includes(`主题：窗口主题 ${WIN_IDS[6]}`);
})());

// ---------------------------------------------------------------------------
// -pro: export tool
// ---------------------------------------------------------------------------

const exportEvents = [
	{ type: "turn/start", seq: 1, time: 1, data: { turn: 1 } },
	{ type: "user/message", seq: 2, time: 2, data: { id: "m1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "你好，请帮我导出" }] } },
	{ type: "assistant/message", seq: 3, time: 3, data: { turn: 1, step: 1, message: { id: "a1", role: "assistant", source: { kind: "model", provider: "p", model: "m" }, content: [{ type: "text", text: "好的，开始导出。" }] } } },
	{ type: "tool/result", seq: 4, time: 4, data: { turn: 1, step: 1, message: { id: "r1", role: "user", source: { kind: "tool", callId: "c1" }, content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "结果文本" }] }] } } },
];
const exportEnv = setup({ sessions, eventsBySession: { "session-target": exportEvents } });
const tmpDir = path.resolve(".test-tmp");
rmSync(tmpDir, { recursive: true, force: true });
const exportTool = exportEnv.tool("team_link_export");
const exportOut = await exportTool.execute({ sessionId: "session-target", outputDir: tmpDir }, execFor(exportEnv.senderAgent));
check("export reports two files", exportOut.includes("已导出会话") && exportOut.includes(".md") && exportOut.includes(".json"));
const mdPath = exportOut.split("\n").map((line) => line.replace("- ", "").trim()).find((line) => line.endsWith(".md"));
const jsonPath = exportOut.split("\n").map((line) => line.replace("- ", "").trim()).find((line) => line.endsWith(".json"));
check("markdown artifact exists", mdPath !== undefined);
const md = mdPath !== undefined ? await readFile(mdPath, "utf8") : "";
check("markdown renders user text", md.includes("你好，请帮我导出"));
check("markdown renders assistant text", md.includes("好的，开始导出。"));
check("markdown renders tool result", md.includes("结果文本") && md.includes("c1"));
check("markdown has header block", md.includes("# 会话导出") && md.includes("session-target"));
const json = jsonPath !== undefined ? JSON.parse(await readFile(jsonPath, "utf8")) : {};
check("json keeps full event log", json.eventCount === 4 && Array.isArray(json.events) && json.events.length === 4);
check("json marks exporter", json.exporter === "dsh-team-link");
const exportMissing = await exportTool.execute({ sessionId: "session-nope", outputDir: tmpDir }, execFor(exportEnv.senderAgent));
check("export of unknown session reports failure", exportMissing.includes("导出失败"));

// 评审 #2: the artifact name is a path, so the session id has to pass the SAME
// filename-safety invariant the download route already applied. A traversal-shaped
// id is the sharp case: before the shared helper it decided both the directory the
// write went to and its extension. The events lookup stays on the raw id — only the
// name is sanitised, so the artifacts keep their `<id>-<timestamp>` readability.
const escEvents = [{ type: "user/message", seq: 1, time: 1, data: { id: "e1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "越界会话" }] } }];
const escEnv = setup({ sessions: [{ header: { id: "../../escaped", createdAt: 1000, cwd: CWD }, live: true, persisted: true }], eventsBySession: { "../../escaped": escEvents } });
const escDir = path.resolve(".test-tmp-escape");
rmSync(escDir, { recursive: true, force: true });
const escOut = await escEnv.tool("team_link_export").execute({ sessionId: "../../escaped", outputDir: escDir }, execFor(escEnv.senderAgent));
const escFiles = escOut.split("\n").map((line) => line.replace("- ", "").trim()).filter((line) => line.endsWith(".md") || line.endsWith(".json"));
check("评审 #2: the export tool and the download route share one filename invariant — a traversal-shaped id is written inside the export dir under the sanitised name", escFiles.length === 2 && escFiles.every((file) => path.dirname(path.resolve(file)) === escDir && /^\.\._\.\._escaped-\d{8}-\d{6}\.(md|json)$/u.test(path.basename(file))) && !existsSync(path.resolve(escDir, "..", "escaped-")));

const routeEnv = setup({ sessions: [{ header: { id: "../../escaped", createdAt: 1000, cwd: CWD }, live: true, persisted: true }], eventsBySession: { "../../escaped": escEvents } });
const exportRoute = routeEnv.routes.find((route) => route.path === "/team-link/export");
let routeResult;
await exportRoute.handler({ url: "/team-link/export?session=../../escaped&format=md" }, { writeHead(code, headers) { routeResult = { code, headers }; }, end() {} });
check("评审 #2: the download header uses the same invariant (no separator can reach content-disposition)", routeResult.code === 200 && routeResult.headers["content-disposition"] === 'attachment; filename=".._.._escaped.md"');

// ---------------------------------------------------------------------------
// -pro: send tool — approve → accept → wake (idle target)
// ---------------------------------------------------------------------------

const sendEnv = setup({ sessions, askScript: ["发送", "接收"] });
const sendTool = sendEnv.tool("team_link_send");
const sendOut = await sendTool.execute({ targetSessionId: "session-target", message: "联调提醒：接口地址已切换" }, execFor(sendEnv.senderAgent));
check("send reports wake delivery", sendOut.includes("已投递") && sendOut.includes("唤醒"));
check("idle target received followup() once", sendEnv.targetCalls.followedup.length === 1 && sendEnv.targetCalls.injected.length === 0 && sendEnv.targetCalls.steered.length === 0);
const delivered = sendEnv.targetCalls.followedup[0];
// The audited admission set of the DSH 0.1.5 session-log migration
// (@deepseek-ai/dsh-session-format-v2-to-v3 `SOURCE_KINDS`). An unknown kind — or
// one extra member on `agent-message` — refuses the WHOLE session log, so the
// delivered shape is pinned here rather than left to a source comment.
const AUDITED_SOURCE_KINDS = new Set(["user", "plugin", "model", "tool", "agent-instructions", "session-reference", "team-message", "goal", "skill-invocation", "skill-catalog", "coordinator", "subagent-report", "subagent-settled", "webhook", "agent-message"]);
check("delivered message is a valid user message", delivered.role === "user" && typeof delivered.id === "string" && delivered.id.startsWith("slp-") && Array.isArray(delivered.content));
check("delivered source is the audited agent-message relay shape", delivered.source.kind === "agent-message" && delivered.source.form === "relay" && delivered.source.senderSessionId === "session-self");
check("delivered source carries exactly the three audited members", Object.keys(delivered.source).length === 3 && AUDITED_SOURCE_KINDS.has(delivered.source.kind));
check("delivered banner names the sender and the relay time", /📨 \[跨会话消息 · 来自会话 .+ · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/.test(delivered.content[0].text));
check("delivered text embeds the payload", delivered.content[0].text.includes("联调提醒：接口地址已切换"));
check("sender approval asked on sender agent", sendEnv.uq.requests[0].questions[0].id === "send-confirm" && sendEnv.uq.requests[0].agent === sendEnv.senderAgent);
check("receiver confirmation asked on target agent", sendEnv.uq.requests[1].questions[0].id === "receive-confirm" && sendEnv.uq.requests[1].agent === sendEnv.targetAgent);

// ---------------------------------------------------------------------------
// -pro: send tool — running target uses steer
// ---------------------------------------------------------------------------

const steerEnv = setup({ sessions, askScript: ["发送", "接收"], targetStatus: "running" });
const steerOut = await steerEnv.tool("team_link_send").execute({ targetSessionId: "session-target", message: "快停，发现冲突" }, execFor(steerEnv.senderAgent));
check("running target reports current-turn injection", steerOut.includes("已投递") && steerOut.includes("当前回合"));
check("running target received steer() once", steerEnv.targetCalls.steered.length === 1 && steerEnv.targetCalls.injected.length === 0 && steerEnv.targetCalls.followedup.length === 0);

// ---------------------------------------------------------------------------
// -pro: send tool — pairing: one approval each way, then silent auto-relay
// ---------------------------------------------------------------------------

const pairEnv = setup({ sessions, askScript: ["发送", "配对：双向免确认"] });
const pairTool = pairEnv.tool("team_link_send");
const pairOut1 = await pairTool.execute({ targetSessionId: "session-target", message: "建对第一条" }, execFor(pairEnv.senderAgent));
check("pairing send delivers", pairOut1.includes("已投递") && pairEnv.targetCalls.followedup.length === 1);
check("pair option offered on receiver confirm", pairEnv.uq.requests[1].questions[0].options.some((option) => option.label.startsWith("配对")));
const pairOut2 = await pairTool.execute({ targetSessionId: "session-target", message: "配对后免确认直达" }, execFor(pairEnv.senderAgent));
check("paired follow-up skips both gates", pairOut2.includes("已配对") && pairOut2.includes("已投递") && pairEnv.uq.requests.length === 2 && pairEnv.targetCalls.followedup.length === 2);
const revOut = await pairTool.execute({ targetSessionId: "session-self", message: "反向直达" }, execFor(pairEnv.targetAgent));
check("pairing auto-relays in reverse direction", revOut.includes("已配对") && revOut.includes("已投递") && pairEnv.senderCalls.followedup.length === 1 && pairEnv.uq.requests.length === 2);

// ---------------------------------------------------------------------------
// -pro: send tool — receiver rejects and blocks; follow-up blocked silently
// ---------------------------------------------------------------------------

const rejectEnv = setup({ sessions, askScript: ["发送", "拒绝并屏蔽该会话", "发送"] });
const rejectOut = await rejectEnv.tool("team_link_send").execute({ targetSessionId: "session-target", message: "第一条" }, execFor(rejectEnv.senderAgent));
check("rejection reports block", rejectOut.includes("拒绝并屏蔽"));
check("rejected message not delivered", rejectEnv.targetCalls.injected.length === 0 && rejectEnv.targetCalls.followedup.length === 0);
const blockedOut = await rejectEnv.tool("team_link_send").execute({ targetSessionId: "session-target", message: "第二条" }, execFor(rejectEnv.senderAgent));
check("follow-up blocked without receiver ask", blockedOut.includes("已屏蔽") && rejectEnv.uq.requests.length === 2);

// ---------------------------------------------------------------------------
// -pro: send tool — sender cancels; nothing delivered, no receiver ask
// ---------------------------------------------------------------------------

const cancelEnv = setup({ sessions, askScript: ["取消"] });
const cancelOut = await cancelEnv.tool("team_link_send").execute({ targetSessionId: "session-target", message: "算了" }, execFor(cancelEnv.senderAgent));
check("cancel reports refusal", cancelOut.includes("已取消"));
check("canceled message not delivered", cancelEnv.targetCalls.injected.length === 0 && cancelEnv.targetCalls.followedup.length === 0 && cancelEnv.uq.requests.length === 1);

// ---------------------------------------------------------------------------
// -pro: send tool — guard rails
// ---------------------------------------------------------------------------

const guardEnv = setup({ sessions, askScript: [] });
const selfOut = await guardEnv.tool("team_link_send").execute({ targetSessionId: "session-self", message: "自发自收" }, execFor(guardEnv.senderAgent));
check("self-send refused", selfOut.includes("不能是当前会话"));
const deadOut = await guardEnv.tool("team_link_send").execute({ targetSessionId: "session-cold", message: "喂" }, execFor(guardEnv.senderAgent));
check("dead target refused", deadOut.includes("没有活动代理"));

// ---------------------------------------------------------------------------
// no-agent refusal, self-healing (生产事故：目标 id 转录错位一位 →
// 「目标会话 … 没有活动代理」只给了一种解释，调用方无从核对 id，于是把失败
// 当成功继续汇报，而目标会话其实活着)
// ---------------------------------------------------------------------------
// Deliverable shape: ❌ lead + the legacy sentence + the live sessions of the
// caller's OWN workspace + the recovery hint. The list is a registry read only
// (no surface read), which is why a refusal path can afford it.

/** The hint fixture: two live root peers in the CALLER's workspace, one root in
 * another workspace, one subagent. `session-target` / `session-runner` are the
 * always-present roots in CWD — outside this caller's workspace, so they must
 * not be advertised either. */
const hintEnv = setup({
	sessions: [],
	selfCwd: `${CWD}/ws`,
	extraAgents: [
		{ id: "session-peer-a", status: "running", cwd: `${CWD}/ws` },
		{ id: "session-peer-b", status: "idle", cwd: `${CWD}/ws` },
		{ id: "session-elsewhere", status: "idle", cwd: "D:/elsewhere" },
		{ id: "session-child", status: "idle", cwd: `${CWD}/ws`, origin: "subagent" },
	],
});
const hintOut = await hintEnv.tool("team_link_send").execute({ targetSessionId: "session-typo", message: "喂" }, execFor(hintEnv.senderAgent));
check("no-agent: the refusal leads with ❌ 未投递 — a failure may never be read as a queued send", hintOut.startsWith("❌ 未投递：目标会话 session-typo 没有活动代理"));
check("no-agent: the legacy sentence stays word for word", hintOut.includes("（未在本壳中打开或已退出）。仅支持投递到存活会话。"));
check("no-agent: it lists the caller's own workspace, one live session per line with its state", hintOut.includes("当前工作区其他存活会话（共 2 个）：") && hintOut.includes("\n  - session-peer-a（运行中）") && hintOut.includes("\n  - session-peer-b（空闲）"));
check("no-agent: ...and only those — another workspace, a subagent, the caller and the other roots stay out", !hintOut.includes("session-elsewhere") && !hintOut.includes("session-child") && !hintOut.includes("session-self") && !hintOut.includes("session-target") && !hintOut.includes("session-runner"));
check("no-agent: the recovery hint names the id check, the sidebar re-open and list_sessions", hintOut.includes("请对照上列 id 核对目标 id（常见错误：转录错位）") && hintOut.includes("在侧边栏打开目标会话一次使其恢复为活动代理") && hintOut.includes("team_link_list_sessions"));

const hintCapEnv = setup({
	sessions: [],
	selfCwd: `${CWD}/ws`,
	extraAgents: Array.from({ length: 12 }, (_, index) => ({ id: `session-peer-${index}`, status: index === 0 ? "running" : "idle", cwd: `${CWD}/ws` })),
});
const hintCapOut = await hintCapEnv.tool("team_link_send").execute({ targetSessionId: "session-typo", message: "喂" }, execFor(hintCapEnv.senderAgent));
check("no-agent: the hint list stops at 10 and declares the bound instead of hiding it", hintCapOut.includes("当前工作区其他存活会话（共 12 个，仅列前 10 个）：") && (hintCapOut.match(/\n  - session-peer-/gu) ?? []).length === 10);

const hintSoloEnv = setup({ sessions: [], selfCwd: `${CWD}/solo` });
const hintSoloOut = await hintSoloEnv.tool("team_link_send").execute({ targetSessionId: "session-typo", message: "喂" }, execFor(hintSoloEnv.senderAgent));
check("no-agent: with no other live session in the workspace the list degrades to one honest sentence", hintSoloOut.startsWith("❌ 未投递") && hintSoloOut.includes("当前工作区无其他存活会话。") && !hintSoloOut.includes("当前工作区其他存活会话"));

// ---------------------------------------------------------------------------
// -pro: lone-surrogate safety (code-point truncation + well-formed output)
// ---------------------------------------------------------------------------
// A lone surrogate (half of an emoji) in tool output is not cosmetic. The
// orchestrator forwards a tool result verbatim into the next model request, and
// an unpaired UTF-16 surrogate makes that request fail with HTTP 400
// INVALID_REQUEST — permanently: the poisoned text stays in the history, so
// every later turn of that session dies the same way. Observed on all four of
// the logged sessions that carried one over deepseek-official (a local scan of
// 882 session logs found five with a real lone surrogate; the fifth, on qax,
// survived). This list tool's topic/activity preview was the source: `slice(0, 89)`
// cut at code-unit index 88 and the emoji sat exactly there.
//
// The contract pinned below: a returned string carries an astral character
// COMPLETE or not at all — never half of it.

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const hasLone = (text) => LONE.test(String(text));

/** One-session environment whose surface topic is rewritten per case. */
const loneTopicEvents = [
	{ type: "user/message", seq: 1, time: 1, data: { id: "e1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "" }] } },
];
const loneEnv = setup({
	sessions: [{ header: { id: "session-emoji", createdAt: 5000, cwd: CWD }, live: false, persisted: true }],
	eventsBySession: { "session-emoji": loneTopicEvents },
});
const loneListTool = loneEnv.tool("team_link_list_sessions");
const setLoneTopic = (text) => { loneTopicEvents[0].data.content[0].text = text; };
/** Run the list tool on one topic and return the whole output plus its 主题段. */
const listForTopic = async (topic) => {
	setLoneTopic(topic);
	const out = await loneListTool.execute({}, execFor(loneEnv.senderAgent));
	const line = out.split("\n").find((candidate) => candidate.includes("主题："));
	return { out, preview: line === undefined ? "" : line.slice(line.indexOf("主题：") + "主题：".length) };
};

// (a) property: one emoji walked across EVERY offset 0..120 of the topic, so the
//     limit-90 cut lands on every code unit in turn — including the two halves.
const loneOffsets = [];
for (let n = 0; n <= 120; n += 1) {
	const { out } = await listForTopic(`${"x".repeat(n)}🔵 尾巴`);
	if (hasLone(out)) loneOffsets.push(n);
}
check(`list output carries no lone surrogate at any of 121 cut offsets (bad offsets: ${loneOffsets.length === 0 ? "none" : loneOffsets.join(",")})`, loneOffsets.length === 0);

// (b) the production accident, pinned exactly: 88 x then the emoji puts its high
//     surrogate at code-unit index 88 — the last unit `slice(0, 89)` kept.
const boundaryCase = await listForTopic(`${"x".repeat(88)}🔵尾巴`);
check("production boundary: list output has no lone surrogate", !hasLone(boundaryCase.out));
check("production boundary: the preview segment is exactly 90 code points", [...boundaryCase.preview].length === 90);
check("production boundary: the preview segment keeps the whole emoji, then the ellipsis", boundaryCase.preview.endsWith("🔵…"));

// (c) a topic that ALREADY carries a lone surrogate (a log written by an older
//     build, or any foreign text) must be repaired on the way out, not forwarded:
//     code-point cutting alone cannot fix a source that is already half an emoji.
const prePoisoned = await listForTopic(`${"x".repeat(10)}\uD83D 断开的 emoji`);
check("pre-poisoned topic: repaired, never forwarded", !hasLone(prePoisoned.out));
check("pre-poisoned topic: surrounding text survives the repair", prePoisoned.out.includes("断开的 emoji"));

// (d) the export path: truncate() cuts at MD_BLOCK_LIMIT (16000) with an explicit
//     marker, and the count in that marker is part of the honest rendering.
const longText = `${"x".repeat(15999)}🔵尾巴`;
const truncEnv = setup({
	sessions: [{ header: { id: "session-long", createdAt: 6000, cwd: CWD }, live: false, persisted: true }],
	eventsBySession: { "session-long": [{ type: "user/message", seq: 1, time: 1, data: { id: "l1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: longText }] } }] },
});
const truncDir = path.resolve(".test-tmp-lone");
rmSync(truncDir, { recursive: true, force: true });
const truncOut = await truncEnv.tool("team_link_export").execute({ sessionId: "session-long", outputDir: truncDir }, execFor(truncEnv.senderAgent));
const truncMdPath = truncOut.split("\n").map((line) => line.replace("- ", "").trim()).find((line) => line.endsWith(".md"));
const truncMd = truncMdPath === undefined ? "" : await readFile(truncMdPath, "utf8");
check("export md artifact written for the oversized text", truncMdPath !== undefined);
check("export md has no lone surrogate", !hasLone(truncMd));
check("export md keeps the whole emoji at the cut", truncMd.includes(`${"x".repeat(15999)}🔵\n…[已截断 2 字符]`));
check("export md counts the cut in code points, not code units", !truncMd.includes("已截断 3 字符"));
rmSync(truncDir, { recursive: true, force: true });

// (e) the approval dialogs and the relayed banner are outward strings too: a lone
//     surrogate in the payload must not reach the sender's dialog, and — worse —
//     must not be written into the TARGET session's log by the relay banner.
const poisonText = `${"y".repeat(5)}\uD83D 断开的负载`;
const poisonEnv = setup({ sessions, askScript: ["发送", "接收"] });
await poisonEnv.tool("team_link_send").execute({ targetSessionId: "session-target", message: poisonText }, execFor(poisonEnv.senderAgent));
check("sender confirm dialog has no lone surrogate", poisonEnv.uq.requests[0] !== undefined && !hasLone(poisonEnv.uq.requests[0].questions[0].question));
check("receiver confirm dialog has no lone surrogate", poisonEnv.uq.requests[1] !== undefined && !hasLone(poisonEnv.uq.requests[1].questions[0].question));
const poisonDelivered = poisonEnv.targetCalls.followedup[0];
check("delivered relay banner has no lone surrogate", poisonDelivered !== undefined && !hasLone(poisonDelivered.content[0].text));
check("delivered relay banner keeps the payload text", poisonDelivered !== undefined && poisonDelivered.content[0].text.includes("断开的负载"));

// (f) the deep-link snapshot is this plugin's MOST direct carrier into the
//     caller's own next request. A lone surrogate inside the referenced session's
//     log must be repaired on the way in — an upstream resolver change is not
//     needed for that, only a well-formed copy of what it hands over.
const linkEnv = setup({ contextText: `${"z".repeat(3)}\uD83D 快照` });
const linkPrompt = { id: "link-1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "参考 dsh://session/session-abc123 继续" }] };
const linkDecision = await ctx_waterfall(linkEnv.ctx, { messages: [linkPrompt], turn: 30, step: 1 });
check("injected snapshot has no lone surrogate", linkDecision.messages.length === 2 && !hasLone(linkDecision.messages[0].content[0].text));
check("injected snapshot keeps its text", linkDecision.messages.length === 2 && linkDecision.messages[0].content[0].text.includes("快照"));

// (g) tool-argument echo: a model that copies a broken id back into
//     targetSessionId must not have that half-emoji echoed into its own history
//     by the refusal text.
const echoEnv = setup({ sessions, askScript: [] });
const echoOut = await echoEnv.tool("team_link_send").execute({ targetSessionId: "session-nope\uD83D", message: "x" }, execFor(echoEnv.senderAgent));
check("a refusal echoing a poisoned target id is repaired", !hasLone(echoOut));
check("a refusal still names the target id it was given", echoOut.includes("session-nope"));

// (h) `additionalContext` is optional in the resolver's contract: a resolver that
//     omits it must not get `undefined` spliced into the outgoing message array.
const noContextEnv = setup({ omitContext: true });
const noContextPrompt = { id: "link-2", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "参考 dsh://session/session-abc123 继续" }] };
const noContextDecision = await ctx_waterfall(noContextEnv.ctx, { messages: [noContextPrompt], turn: 31, step: 1 });
check("a missing snapshot context drops the injection instead of splicing undefined", noContextDecision.messages.length === 1 && noContextDecision.messages[0].id === "link-2");
check("the direct prompt still survives without a snapshot", noContextDecision.messages.length === 1 && noContextDecision.messages[0]?.content?.[0]?.text === "参考 @session-abc123 继续");

// ---------------------------------------------------------------------------
// M1b (§3.2.2 / §3.2.4): team_link_watch registration surface
// ---------------------------------------------------------------------------

const watchEnv = setup({
	sessions: [{ header: { id: "session-target", createdAt: 1000, cwd: CWD }, live: true, persisted: true }],
	useSettings: true,
});
const watchTool = watchEnv.tool("team_link_watch");
const watchExec = () => execFor(watchEnv.senderAgent);
const teamLinkNs = () => watchEnv.settings.namespaces.get("team-link");
check("watch tool registered", watchTool !== undefined);
check("settings stub carries both namespaces (team-link + the pre-rename one)", watchEnv.settings.namespaces.has("team-link") && watchEnv.settings.namespaces.has("session-link-pro"));

const noAgentOut = await watchTool.execute({ action: "register", targets: ["session-target"] }, { signal: new AbortController().signal });
check("register without a live agent is refused", noAgentOut.includes("需要可交互的活动代理"));
/** Argument-schema rejections surface as a thrown ToolArgsError, not a string. */
const rejectsArgs = async (args) => {
	try {
		return await watchTool.execute(args, watchExec());
	} catch (error) {
		return error;
	}
};
const badAction = await rejectsArgs({ action: "nonsense" });
check("the action schema admits only register / list / clear", badAction instanceof Error && badAction.message.includes("action"));
const noTargets = await watchTool.execute({ action: "register" }, watchExec());
check("register requires at least one target", noTargets.includes("需要 targets"));
const selfTarget = await watchTool.execute({ action: "register", targets: ["session-self", "session-target"] }, watchExec());
check("register refuses a self-referencing target list", selfTarget.includes("拒绝自指注册"));
const lowSilent = await watchTool.execute({ action: "register", targets: ["session-target"], silentMinutes: 9 }, watchExec());
check("silentMinutes below 10 is refused", lowSilent.includes("silentMinutes") && lowSilent.includes("注册失败"));
const fracSilent = await rejectsArgs({ action: "register", targets: ["session-target"], silentMinutes: 10.5 });
check("silentMinutes is schema-typed as an integer", fracSilent instanceof Error && fracSilent.message.includes("silentMinutes"));
const lowInterval = await watchTool.execute({ action: "register", targets: ["session-target"], intervalMinutes: 4 }, watchExec());
check("intervalMinutes below 5 is refused", lowInterval.includes("intervalMinutes") && lowInterval.includes("注册失败"));
const highTtl = await watchTool.execute({ action: "register", targets: ["session-target"], ttlHours: 25 }, watchExec());
check("a TTL above 24h is refused", highTtl.includes("ttlHours") && highTtl.includes("注册失败"));
const zeroTtl = await watchTool.execute({ action: "register", targets: ["session-target"], ttlHours: 0 }, watchExec());
check("a non-positive TTL is refused", zeroTtl.includes("ttlHours") && zeroTtl.includes("大于 0"));

const reg1 = await watchTool.execute({ action: "register", targets: ["session-target", "session-target"] }, watchExec());
check("register defaults to silent 10min / interval 5min / TTL 12h and de-duplicates targets", reg1.includes("已注册看门狗 wd-") && reg1.includes("静默 10min") && reg1.includes("巡检 5min") && reg1.includes("TTL 12.00h") && (reg1.match(/session-target/gu) ?? []).length === 1);
const regId = (reg1.match(/(wd-[0-9a-f-]{36})/u) ?? [])[1];
check("registration id uses the wd- prefix", typeof regId === "string" && regId.startsWith("wd-"));
check("the rejected requests wrote nothing to the store", teamLinkNs().data.watchdogs.length === 1);
check("the accepted registration is persisted under the team-link watchdogs key", teamLinkNs().data.watchdogs[0].watcherSession === "session-self" && teamLinkNs().data.watchdogs[0].team === null);

const okBoundary = await watchTool.execute({ action: "register", targets: ["session-target"], silentMinutes: 10, intervalMinutes: 5, ttlHours: 24 }, watchExec());
check("the documented boundaries are accepted (silent 10 / interval 5 / ttl 24)", okBoundary.includes("已注册看门狗") && okBoundary.includes("TTL 24.00h"));
const third = await watchTool.execute({ action: "register", targets: ["session-target"] }, watchExec());
check("a third registration is accepted", third.includes("已注册看门狗"));
const fourth = await watchTool.execute({ action: "register", targets: ["session-target"] }, watchExec());
check("a fourth registration for one session is refused (<=3, §3.2.4)", fourth.includes("最多 3 个") && teamLinkNs().data.watchdogs.length === 3);

const watchList = await watchTool.execute({ action: "list" }, watchExec());
check("list shows every registration with its targets and thresholds", watchList.includes("看门狗注册（共 3 个") && watchList.includes("目标：session-target") && watchList.includes("阈值：静默 10min"));
check("list marks the caller's own registrations and carries the reading stamp", watchList.includes("[自己]") && /（读数 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}，>2min 作废）/u.test(watchList));

const clearIdempotent = await watchTool.execute({ action: "clear", id: "wd-00000000-0000-0000-0000-000000000000" }, watchExec());
check("clear is idempotent for an unknown id", clearIdempotent.includes("已清理 0 个注册") && clearIdempotent.includes("幂等"));
const clearOne = await watchTool.execute({ action: "clear", id: regId }, watchExec());
check("clear removes exactly one own registration", clearOne.includes(`已清理看门狗注册 ${regId}`) && teamLinkNs().data.watchdogs.length === 2);
const clearAll = await watchTool.execute({ action: "clear" }, watchExec());
check("clear without an id removes every own registration", clearAll.includes("（2 个）") && teamLinkNs().data.watchdogs.length === 0);
const clearAgain = await watchTool.execute({ action: "clear" }, watchExec());
check("clear is idempotent when nothing is left", clearAgain.includes("（0 个）"));

// A foreign registration (another session's watchdog) is visible but not clearable.
teamLinkNs().data.watchdogs = [{ id: "wd-foreign", team: "", watcherSession: "session-target", targets: ["session-self"], silentMinutes: 10, intervalMinutes: 5, expiresAt: 2_000_000_000_000, createdAt: 1 }];
const clearForeign = await watchTool.execute({ action: "clear", id: "wd-foreign" }, watchExec());
check("clear refuses another session's registration", clearForeign.includes("只能清除自己的注册") && teamLinkNs().data.watchdogs.length === 1);
const foreignList = await watchTool.execute({ action: "list" }, watchExec());
check("list shows registrations without the own marker and normalizes team null", foreignList.includes("wd-foreign") && !foreignList.includes("wd-foreign [自己]") && foreignList.includes("团队 —"));
teamLinkNs().data.watchdogs = [];

// ---------------------------------------------------------------------------
// M1b (§3.2.3 / §3.7): patrol policy, tick delivery, TTL self-clean
// ---------------------------------------------------------------------------

const WD_NOW = 1_700_000_000_000;
/** The tick body's clock is this plugin's local stamp (§3.2.3), spelled here
 * once so an exact body comparison is possible. */
const stampOf = (ms) => {
	const date = new Date(ms);
	const pad = (n) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};
/** One assistant message at `time` — the whole activity history of a target that
 * has been silent since then. */
const oneShotSurface = (time, text = "在干活") => [{
	type: "assistant/message",
	seq: 1,
	time,
	data: { turn: 1, step: 1, message: { id: "a1", role: "assistant", source: { kind: "model", provider: "p", model: "m" }, content: [{ type: "text", text }] } },
}];

/**
 * Build a watchdog environment: the caller (session-self) plus one live idle
 * agent per target, over the settings-backed policy store.
 * @param goals - goal views by session id.
 * @param targets - `{ sessionId: { events, status } }`.
 */
function watchdogEnv({ goals = {}, targets = {}, selfStatus, selfGoal } = {}) {
	const ids = Object.keys(targets);
	const eventsBySession = {};
	for (const id of ids) eventsBySession[id] = targets[id].events;
	const env = setup({
		sessions: ids.map((id, index) => ({ header: { id, createdAt: 1000 + index, cwd: CWD }, live: true, persisted: true })),
		eventsBySession,
		useSettings: true,
		selfStatus,
		goals: { ...goals, ...(selfGoal !== undefined ? { "session-self": selfGoal } : {}) },
		extraAgents: ids.map((id) => ({ id, status: targets[id].status ?? "idle" })),
	});
	return { ...env, eventsBySession, watch: env.tool("team_link_watch"), watchdog: __testing.watchdogFor(env.ctx) };
}

const armedGoal = (rounds = 12) => ({ phase: "active", activation: "armed", roundsStarted: rounds, maxGoalRounds: 70 });
const disarmedGoal = (rounds = 3) => ({ phase: "active", activation: "disarmed", roundsStarted: rounds, maxGoalRounds: 70 });

// --- four-state policy ----------------------------------------------------
const policyEnv = watchdogEnv({
	targets: {
		"session-silent": { events: oneShotSurface(1) },
		"session-dead": { events: oneShotSurface(1) },
		"session-armed": { events: oneShotSurface(1) },
		"session-paused": { events: oneShotSurface(1) },
		"session-blocked": { events: oneShotSurface(1) },
		"session-disarmed": { events: oneShotSurface(1) },
		"session-busy": { events: oneShotSurface(WD_NOW - 60_000), status: "running" },
	},
	goals: {
		"session-armed": armedGoal(),
		"session-paused": { phase: "paused", activation: "disarmed", roundsStarted: 5, maxGoalRounds: 70 },
		"session-blocked": { phase: "blocked", activation: "disarmed", roundsStarted: 70, maxGoalRounds: 70, blockedReason: { code: "round-limit", message: "round limit reached" } },
		"session-disarmed": disarmedGoal(),
	},
});
// session-dead has no live agent: hide it from the registry after setup.
policyEnv.setHiddenAgent("session-dead", true);
const silentReg = await policyEnv.watch.execute({ action: "register", targets: ["session-silent", "session-dead"] }, execFor(policyEnv.senderAgent));
const quietReg = await policyEnv.watch.execute({ action: "register", targets: ["session-armed", "session-paused", "session-blocked", "session-busy"] }, execFor(policyEnv.senderAgent));
const disarmedReg = await policyEnv.watch.execute({ action: "register", targets: ["session-disarmed"] }, execFor(policyEnv.senderAgent));
check("three registrations cover the whole four-state matrix", [silentReg, quietReg, disarmedReg].every((out) => out.includes("已注册看门狗")));

await policyEnv.watchdog.patrol({ now: WD_NOW });
// Exactly three ticks: the silent target, the gone target, and the
// active-but-disarmed one — and nothing for armed / paused / blocked / running.
check("only silent-idle, goal-disarmed and dead targets are ticked (§3.2.3)", policyEnv.senderCalls.followedup.length === 3);
const disarmedTick = policyEnv.senderCalls.followedup.find((message) => message.content[0].text.includes("session-disarmed"));
check("goal-disarmed tick carries the diagnosis and the legal resume loop (§3.2.3/§3.7)", disarmedTick !== undefined && disarmedTick.content[0].text === `[watchdog] 目标 session-disarmed 的 goal 处于 active-but-disarmed（可能原因：max-tokens 回合结束 / DSH 重启 / agent error，读数 ${stampOf(WD_NOW)}）。该状态不会自愈：请向用户说明并请求授权 resume；用户同意后调用 update_goal(action:"resume") 恢复续跑。复核用 team_link_list_sessions。`);
check("armed-active / paused / blocked / running targets are never ticked (§3.7 four-state table)", policyEnv.senderCalls.followedup.every((message) => !/session-armed|session-paused|session-blocked|session-busy/u.test(message.content[0].text)));
const silentTick = policyEnv.senderCalls.followedup.find((message) => message.content[0].text.includes("session-silent"));
check("silent-idle tick body is exactly the §3.2.3 constant with status fields only", silentTick !== undefined && silentTick.content[0].text === `[watchdog] 目标 session-silent 失联征兆：verdict=silent-idle 静默 ${((WD_NOW - 1) / 60000).toFixed(1)}min（读数 ${stampOf(WD_NOW)}）。请用 team_link_list_sessions 复核后处置；误报或不再需要盯人可用 team_link_watch clear。`);
const deadTick = policyEnv.senderCalls.followedup.find((message) => message.content[0].text.includes("session-dead"));
check("a target whose agent is gone ticks too (verdict=dead is tickable, §3.2.3)", deadTick !== undefined && /verdict=dead 静默 [\d.]+min（读数 /u.test(deadTick.content[0].text));

// --- U3: source shape and parameter independence ---------------------------
check("tick id uses the slp-wd- prefix", policyEnv.senderCalls.followedup.every((message) => typeof message.id === "string" && message.id.startsWith("slp-wd-")));
check("tick is a user message with one text block", policyEnv.senderCalls.followedup.every((message) => message.role === "user" && Array.isArray(message.content) && message.content.length === 1 && message.content[0].type === "text"));
check("tick source is exactly the audited relay shape (V10)", policyEnv.senderCalls.followedup.every((message) => message.source.kind === "agent-message" && message.source.form === "relay" && Object.keys(message.source).length === 3 && AUDITED_SOURCE_KINDS.has(message.source.kind)));
check("tick senderSessionId is the watcher itself (§3.2.3 note (a))", policyEnv.senderCalls.followedup.every((message) => message.source.senderSessionId === "session-self"));

const paramEnv = watchdogEnv({ targets: { "session-silent": { events: oneShotSurface(1) } } });
const paramA = await paramEnv.watch.execute({ action: "register", targets: ["session-silent"], silentMinutes: 10, intervalMinutes: 5, ttlHours: 12 }, execFor(paramEnv.senderAgent));
const paramB = await paramEnv.watch.execute({ action: "register", targets: ["session-silent"], silentMinutes: 60, intervalMinutes: 30, ttlHours: 24 }, execFor(paramEnv.senderAgent));
await paramEnv.watchdog.patrol({ now: WD_NOW });
const bodies = paramEnv.senderCalls.followedup.map((message) => message.content[0].text);
check("two registrations with different thresholds produce one tick each", paramA.includes("已注册看门狗") && paramB.includes("已注册看门狗") && bodies.length === 2);
check("the two registrations really do differ in every threshold", paramA.includes("TTL 12.00h") && paramB.includes("TTL 24.00h"));
check("the tick body never varies with registration parameters (§3.2.3 常量化)", bodies[0] === bodies[1]);

// --- debounce: one tick per silent period ----------------------------------
await policyEnv.watchdog.patrol({ now: WD_NOW });
check("a second patrol in the same silent period does not tick again", policyEnv.senderCalls.followedup.length === 3);
const laterNow = WD_NOW + 30 * 60000;
policyEnv.eventsBySession["session-silent"] = oneShotSurface(laterNow - 11 * 60000, "回来了");
await policyEnv.watchdog.patrol({ now: laterNow });
check("activity followed by a fresh silent period ticks again (debounce is per silent period)", policyEnv.senderCalls.followedup.length === 4);
check("the fresh tick reports the new silence duration", policyEnv.senderCalls.followedup[3].content[0].text.includes("静默 11.0min"));
check("the still-silent dead target is not re-ticked (still the same silent period)", policyEnv.senderCalls.followedup.filter((message) => message.content[0].text.includes("session-dead")).length === 1);

// The interval floor: a NEW silence period is still reported at most once per
// patrol interval (§3.2.4 "去抖间隔"), so a chatty target cannot produce a
// burst of ticks.
const floorNow = laterNow + 60000;
policyEnv.eventsBySession["session-silent"] = oneShotSurface(floorNow - 11 * 60000, "又坐下了");
await policyEnv.watchdog.patrol({ now: floorNow });
check("a new silence period inside the same patrol interval waits", policyEnv.senderCalls.followedup.length === 4);
await policyEnv.watchdog.patrol({ now: laterNow + 6 * 60000 });
check("once the interval has passed, the new silence is reported", policyEnv.senderCalls.followedup.length === 5);

// --- watcher-side gates ----------------------------------------------------
const busyWatcher = watchdogEnv({ targets: { "session-silent": { events: oneShotSurface(1) } }, selfStatus: "running" });
await busyWatcher.watch.execute({ action: "register", targets: ["session-silent"] }, execFor(busyWatcher.senderAgent));
await busyWatcher.watchdog.patrol({ now: WD_NOW });
check("a running watcher is never interrupted (§3.2.3/V7)", busyWatcher.senderCalls.followedup.length === 0);

const armedWatcher = watchdogEnv({ targets: { "session-silent": { events: oneShotSurface(1) } }, selfGoal: armedGoal(4) });
await armedWatcher.watch.execute({ action: "register", targets: ["session-silent"] }, execFor(armedWatcher.senderAgent));
await armedWatcher.watchdog.patrol({ now: WD_NOW });
check("an armed-active watcher is not ticked — it has its own cadence (A1)", armedWatcher.senderCalls.followedup.length === 0);

// --- observer session gone (A4) -------------------------------------------
const goneEnv = watchdogEnv({ targets: { "session-silent": { events: oneShotSurface(1) } } });
await goneEnv.watch.execute({ action: "register", targets: ["session-silent"] }, execFor(goneEnv.senderAgent));
goneEnv.setHiddenAgent("session-self", true);
await goneEnv.watchdog.patrol({ now: WD_NOW });
check("a missing observer agent produces no tick", goneEnv.senderCalls.followedup.length === 0);
check("the missing observer is marked on the signal face", goneEnv.watchdog.deadWatchers.size === 1);
check("the registration survives a dead observer (kept until its TTL)", goneEnv.settings.namespaces.get("team-link").data.watchdogs.length === 1);
goneEnv.setHiddenAgent("session-self", false);
const goneList = await goneEnv.watch.execute({ action: "list" }, execFor(goneEnv.senderAgent));
check("the signal face reports the dead observer while the registration is kept", goneList.includes("观察者=dead") && goneList.includes("共 1 个"));
await goneEnv.watchdog.patrol({ now: WD_NOW + 60000 });
check("a returning observer resumes delivery inside the TTL", goneEnv.senderCalls.followedup.length === 1);

// --- TTL self-clean --------------------------------------------------------
const ttlEnv = watchdogEnv({ targets: { "session-armed": { events: oneShotSurface(1) } }, goals: { "session-armed": armedGoal() } });
// R2 (M2 review): the expiry assertion used to read `expiresAt > Date.now()`, a
// wall-clock race — with ttlHours 0.001 (3.6s) that comparison only flips once
// real time has passed the expiry, so a loaded box could fail a call that was
// perfectly correct. Capture the clock BEFORE registering instead: `createdAt` is
// stamped from that same clock, so `expiresAt > createdAt` plus `expiresAt >
// captured-at` proves the TTL landed in the future relative to the registration,
// with no dependency on how long the rest of the test then takes.
const ttlRegisteredAt = Date.now();
const ttlReg = await ttlEnv.watch.execute({ action: "register", targets: ["session-armed"], ttlHours: 0.001 }, execFor(ttlEnv.senderAgent));
const ttlEntry = ttlEnv.settings.namespaces.get("team-link").data.watchdogs[0];
check("a fractional TTL is accepted and reflected in the expiry", ttlReg.includes("已注册看门狗") && ttlEntry.expiresAt > ttlEntry.createdAt && ttlEntry.expiresAt > ttlRegisteredAt);
await ttlEnv.watchdog.patrol({ now: ttlEntry.expiresAt + 1 });
check("an expired registration cleans itself up (§3.2.3 TTL)", ttlEnv.settings.namespaces.get("team-link").data.watchdogs.length === 0);
const afterTtl = await ttlEnv.watch.execute({ action: "list" }, execFor(ttlEnv.senderAgent));
check("the expired registration is gone from the list", afterTtl.includes("共 0 个") && !afterTtl.includes(ttlEntry.id));

// The TTL sweep must be reachable behind every watcher gate (audit D1): the
// observer-gone / running / armed-active early returns used to run BEFORE the
// expiry check, so such a registration never cleaned itself up and its empty
// patrol timer span forever. §3.2.3 puts the sweep first.
const expiredEnv = (options) => watchdogEnv({ targets: { "session-silent": { events: oneShotSurface(1) } }, ...options });

const ttlDeadEnv = expiredEnv({});
await ttlDeadEnv.watch.execute({ action: "register", targets: ["session-silent"], ttlHours: 0.001 }, execFor(ttlDeadEnv.senderAgent));
const ttlDeadEntry = ttlDeadEnv.settings.namespaces.get("team-link").data.watchdogs[0];
ttlDeadEnv.setHiddenAgent("session-self", true);
await ttlDeadEnv.watchdog.patrol({ now: ttlDeadEntry.expiresAt + 1 });
check("an expired registration drops itself even when the observer is gone (D1)", ttlDeadEnv.settings.namespaces.get("team-link").data.watchdogs.length === 0);
check("the expired registration's patrol timer is gone with it (D1: no empty timer)", ttlDeadEnv.watchdog.timers.size === 0);
check("the expired registration produces no tick", ttlDeadEnv.senderCalls.followedup.length === 0);

const ttlRunningEnv = expiredEnv({ selfStatus: "running" });
await ttlRunningEnv.watch.execute({ action: "register", targets: ["session-silent"], ttlHours: 0.001 }, execFor(ttlRunningEnv.senderAgent));
const ttlRunningEntry = ttlRunningEnv.settings.namespaces.get("team-link").data.watchdogs[0];
await ttlRunningEnv.watchdog.patrol({ now: ttlRunningEntry.expiresAt + 1 });
check("an expired registration drops itself while the observer is running (D1)", ttlRunningEnv.settings.namespaces.get("team-link").data.watchdogs.length === 0);

const ttlArmedEnv = expiredEnv({ selfGoal: armedGoal(4) });
await ttlArmedEnv.watch.execute({ action: "register", targets: ["session-silent"], ttlHours: 0.001 }, execFor(ttlArmedEnv.senderAgent));
const ttlArmedEntry = ttlArmedEnv.settings.namespaces.get("team-link").data.watchdogs[0];
await ttlArmedEnv.watchdog.patrol({ now: ttlArmedEntry.expiresAt + 1 });
check("an expired registration drops itself while the observer is armed-active (D1)", ttlArmedEnv.settings.namespaces.get("team-link").data.watchdogs.length === 0);
check("the expiry pass delivers no tick either (sweep only, §3.2.3)", ttlArmedEnv.senderCalls.followedup.length === 0);

// --- dispose kills the timers, not the store (plugin lifecycle) ------------
const disposeEnv = watchdogEnv({ targets: { "session-silent": { events: oneShotSurface(1) } } });
check("the controller of a context is reachable through the plugin registry", disposeEnv.watchdog !== undefined && typeof disposeEnv.watchdog.patrol === "function");
const disposeReg = await disposeEnv.watch.execute({ action: "register", targets: ["session-silent"] }, execFor(disposeEnv.senderAgent));
check("registering arms exactly one patrol timer for that registration", disposeReg.includes("已注册看门狗") && disposeEnv.watchdog.timers.size === 1);
// The disposer ctx.effect holds is exactly what start() returns.
const stopPatrol = disposeEnv.watchdog.start();
check("start() (re)arms one timer per persisted registration", disposeEnv.watchdog.timers.size === 1);
await stopPatrol();
check("the effect disposer clears every patrol timer (§3.2.4 / task cleanup rule)", disposeEnv.watchdog.timers.size === 0);
await disposeEnv.watchdog.patrol({ now: WD_NOW });
check("after dispose the patrol is inert (no tick)", disposeEnv.senderCalls.followedup.length === 0);

// ---------------------------------------------------------------------------
// M2 (§3.3.1/§3.3.2): roster — writer policy, version history, retirement, mirror
// ---------------------------------------------------------------------------

const TEAM_TMP = path.resolve(".test-tmp-team");
const TEAM_WS = path.join(TEAM_TMP, "ws");
rmSync(TEAM_TMP, { recursive: true, force: true });

/** One roster row as the user would write it in the settings UI — a path that can
 * seat a team's first coordinator by hand, and the one that can leave the role
 * vacant (a vacant coordinator refuses every session-side write, §3.3.2). A team
 * created through the tool no longer starts vacant: the creation path seeds the
 * caller (§9.2.2 创建即认领). */
function teamRow({ name = "night-shift", writer = "coordinator", current = "session-self", workspace = TEAM_WS, roles } = {}) {
	return {
		name,
		createdAt: 1_700_000_000_000,
		workspace,
		policy: { writer },
		roles: roles ?? [{
			role: "coordinator",
			current,
			pending: null,
			history: current === null ? [] : [{ session: current, from: 1_700_000_000_000, until: null }],
		}],
	};
}

/** A plugin environment whose `team-link` namespace is seeded with a roster.
 * `selfCwd` points the caller at the throwaway workspace the blackboard lives in. */
function teamEnv({ teams = [], askScript = [], omitUserQuestions = false, selfCwd = TEAM_WS, extraAgents = [] } = {}) {
	const env = setup({ sessions: [], useSettings: true, askScript, selfCwd, omitUserQuestions, extraAgents });
	const ns = env.settings.namespaces.get("team-link");
	ns.data.teams = structuredClone(teams);
	return { ...env, ns, store: () => ns.data.teams };
}

/** Argument-schema violations surface as a thrown ToolArgsError, not a string. */
const rejects = async (tool, args, exec) => {
	try {
		return await tool.execute(args, exec);
	} catch (error) {
		return error;
	}
};

const teamStore = (env) => env.store();

// --- upsert-team: creation, validation, workspace capture --------------------
const createEnv = teamEnv({ teams: [] });
const createRoster = createEnv.tool("team_link_roster");
check("M2: the roster and blackboard tools are registered", ["team_link_roster", "team_link_team_read", "team_link_team_append"].every((toolName) => createEnv.tool(toolName) !== undefined));

const listEmpty = await createRoster.execute({ action: "get" }, execFor(createEnv.senderAgent));
check("roster get on an empty registry says so instead of failing", listEmpty.includes("团队注册表（共 0 个团队）") && listEmpty.includes("（无团队"));

const createOut = await createRoster.execute({ action: "upsert-team", team: "night-shift" }, execFor(createEnv.senderAgent));
check("upsert-team creates the team with the default writer policy and the caller's workspace (§3.3.1)", createOut.includes("已创建团队 night-shift") && createOut.includes("policy.writer=coordinator") && teamStore(createEnv).length === 1 && teamStore(createEnv)[0].workspace === TEAM_WS && teamStore(createEnv)[0].createdAt > 0);
check("§9.2.2 创建即认领: the creating session is seeded as the coordinator incumbent in the SAME write (canonical role shape, open tenure noted 创建者自举)", (() => {
	const created = teamStore(createEnv)[0];
	const entry = created.roles.find((candidate) => candidate.role === "coordinator");
	return created.roles.length === 1 && entry !== undefined && entry.current === "session-self" && entry.pending === null
		&& entry.history.length === 1 && entry.history[0].session === "session-self" && entry.history[0].until === null
		&& entry.history[0].note === "创建者自举" && entry.history[0].from === created.createdAt;
})());
check("§9.2.2 创建即认领: the return text says who claimed the role and no longer points the first coordinator at the settings UI", createOut.includes("coordinator 已由创建会话 session-self 认领") && !createOut.includes("首任协调者需由用户经设置 UI 指定"));
const mirrorFile = path.join(TEAM_WS, "team", "night-shift", "roster.md");
check("the roster mirror is written in the same call (§3.3.1 人可读镜像)", existsSync(mirrorFile));
const mirrorText = await readFile(mirrorFile, "utf8");
check("the mirror is readable and names the settings namespace as the source of truth", mirrorText.includes("# 团队 roster：night-shift") && mirrorText.includes("policy.writer：coordinator") && mirrorText.includes("事实源"));

const traversalName = await createRoster.execute({ action: "upsert-team", team: "night/shift" }, execFor(createEnv.senderAgent));
check("upsert-team refuses a name outside [a-z0-9-]+ (path traversal, §3.3.1)", traversalName.includes("非法") && traversalName.includes("路径穿越") && teamStore(createEnv).length === 1 && !existsSync(path.join(TEAM_WS, "team", "night")));
const dotName = await createRoster.execute({ action: "upsert-team", team: ".." }, execFor(createEnv.senderAgent));
check("upsert-team refuses a dotted name too", dotName.includes("非法") && teamStore(createEnv).length === 1);
const upperName = await createRoster.execute({ action: "upsert-team", team: "NightShift" }, execFor(createEnv.senderAgent));
check("the name charset is lowercase-only as specified", upperName.includes("非法") && teamStore(createEnv).length === 1);
const noAgentCreate = await createRoster.execute({ action: "upsert-team", team: "day-shift" }, { signal: new AbortController().signal });
check("upsert-team without a live agent is refused — the workspace must come from a real agentCwd", noAgentCreate.includes("需要可交互的活动代理") && teamStore(createEnv).length === 1);

// §9.2.2 同步项: the U4 「空缺 → 全拒」 semantics is expressed by a HAND-WRITTEN
// vacant row (what the settings UI produces). A tool-created team can no longer
// reach that state, so the old fixture (create a team, then write to it) would
// now assert the opposite of what it was written for.
const vacantEnv = teamEnv({ teams: [teamRow({ current: null })] });
const vacantRoster = vacantEnv.tool("team_link_roster");
const vacantSetRole = await vacantRoster.execute({ action: "set-role", team: "night-shift", role: "coordinator", session: "session-self" }, execFor(vacantEnv.senderAgent));
check("U4: set-role is refused for every session while coordinator.current is null — the settings UI is the writable path", vacantSetRole.includes("当前空缺") && vacantSetRole.includes("设置 UI") && teamStore(vacantEnv)[0].roles[0].current === null);
const vacantUpsert = await vacantRoster.execute({ action: "upsert-team", team: "night-shift" }, execFor(vacantEnv.senderAgent));
check("U4: an existing team answers upsert-team with the same writer gate", vacantUpsert.includes("当前空缺") && teamStore(vacantEnv).length === 1);
check("§9.2.2: an existing team is never re-seeded — upsert-team left the hand-written vacant row vacant", teamStore(vacantEnv)[0].roles[0].current === null && teamStore(vacantEnv)[0].roles[0].history.length === 0);

// --- U4: writer policy on a seated team -------------------------------------
const permEnv = teamEnv({ teams: [teamRow({ current: "session-self" })] });
const permRoster = permEnv.tool("team_link_roster");
const foreignExec = () => execFor(permEnv.targetAgent);
const foreignSetRole = await permRoster.execute({ action: "set-role", team: "night-shift", role: "coordinator", session: "session-target" }, foreignExec());
check("U4: a non-coordinator session cannot set-role under writer=coordinator", foreignSetRole.includes("只有现任协调者会话 session-self 可写") && teamStore(permEnv)[0].roles[0].current === "session-self");

const ownSetRole = await permRoster.execute({ action: "set-role", team: "night-shift", role: "coordinator", session: "session-target", note: "交接给夜班" }, execFor(permEnv.senderAgent));
check("U4: the incumbent coordinator session can set-role", ownSetRole.includes("已设置") && teamStore(permEnv)[0].roles[0].current === "session-target");
const history1 = teamStore(permEnv)[0].roles[0].history;
check("U4: set-role closes the previous tenure (until=now, note) and appends the new one open (§3.3.2)", history1.length === 2 && history1[0].session === "session-self" && typeof history1[0].until === "number" && history1[0].note === "交接给夜班" && history1[1].session === "session-target" && history1[1].until === null && history1[1].from >= history1[0].until && history1[1].note === undefined);
check("set-role does not migrate pairs — that is rotation's exclusive action (§3.3.2)", !ownSetRole.includes("已迁移") && permEnv.ns.data.pairs === undefined);
const staleWriter = await permRoster.execute({ action: "set-role", team: "night-shift", role: "coordinator", session: "session-self" }, execFor(permEnv.senderAgent));
check("after the hand-over the OLD incumbent can no longer write (the gate follows current)", staleWriter.includes("只有现任协调者会话 session-target 可写"));
const newWriter = await permRoster.execute({ action: "set-role", team: "night-shift", role: "coordinator", session: "session-self" }, foreignExec());
check("the new incumbent writes from its own session id", newWriter.includes("已设置") && teamStore(permEnv)[0].roles[0].current === "session-self");

const anyEnv = teamEnv({ teams: [teamRow({ writer: "any", current: "session-self" })] });
const anySetRole = await anyEnv.tool("team_link_roster").execute({ action: "set-role", team: "night-shift", role: "reviewer", session: "session-target" }, execFor(anyEnv.targetAgent));
check("U4: writer=any admits any session — and set-role creates a role that did not exist", anySetRole.includes("已设置") && teamStore(anyEnv).length === 1 && teamStore(anyEnv)[0].roles.length === 2 && teamStore(anyEnv)[0].roles[1].role === "reviewer" && teamStore(anyEnv)[0].roles[1].current === "session-target");

const idemEnv = teamEnv({ teams: [teamRow({ writer: "any", current: "session-self" })] });
await idemEnv.tool("team_link_roster").execute({ action: "set-role", team: "night-shift", role: "reviewer", session: "session-target", note: "评审岗" }, execFor(idemEnv.senderAgent));
const beforeIdempotent = structuredClone(teamStore(idemEnv)[0]);
const idemOut = await idemEnv.tool("team_link_roster").execute({ action: "upsert-team", team: "night-shift" }, execFor(idemEnv.senderAgent));
check("U4: upsert-team is idempotent — roles, history and createdAt are not reset", idemOut.includes("已存在") && idemOut.includes("幂等") && JSON.stringify(teamStore(idemEnv)[0].roles) === JSON.stringify(beforeIdempotent.roles) && teamStore(idemEnv)[0].createdAt === beforeIdempotent.createdAt && teamStore(idemEnv)[0].workspace === beforeIdempotent.workspace);
check("U4: upsert-team leaves the stored policy alone (the tool has no policy parameter)", JSON.stringify(teamStore(idemEnv)[0].policy) === JSON.stringify({ writer: "any" }));

const captureEnv = teamEnv({ teams: [teamRow({ writer: "any", workspace: "" })] });
const captureOut = await captureEnv.tool("team_link_roster").execute({ action: "upsert-team", team: "night-shift" }, execFor(captureEnv.senderAgent));
check("upsert-team captures the workspace of a settings-created team that has none yet", captureOut.includes("补记") && teamStore(captureEnv)[0].workspace === TEAM_WS);

// --- U4: retirement and its optional trust cleanup --------------------------
const retireEnv = teamEnv({ teams: [teamRow({ current: "session-self" })], askScript: ["清理"] });
retireEnv.ns.data.pairs = [{ a: "session-self", b: "session-target", createdAt: 1 }, { a: "session-child", b: "session-other", createdAt: 2 }];
retireEnv.ns.data.trustedSenders = ["session-self"];
retireEnv.ns.data.rememberTargets = ["session-self", "session-target"];
const retireRoster = retireEnv.tool("team_link_roster");
const retireForeign = await retireRoster.execute({ action: "retire", team: "night-shift", role: "coordinator" }, foreignExec());
check("U4: retire is refused for a non-coordinator session (§3.3.2 v1.3 仅现任协调者会话或用户发起)", retireForeign.includes("只有现任协调者会话 session-self 可以发起退役") && teamStore(retireEnv)[0].roles[0].current === "session-self");
const anyRetireEnv = teamEnv({ teams: [teamRow({ writer: "any", current: "session-self" })] });
const anyRetireForeign = await anyRetireEnv.tool("team_link_roster").execute({ action: "retire", team: "night-shift", role: "coordinator" }, execFor(anyRetireEnv.targetAgent));
check("retire stays with the incumbent coordinator even under writer=any (the clause names the coordinator, not the policy)", anyRetireForeign.includes("只有现任协调者会话 session-self 可以发起退役") && teamStore(anyRetireEnv)[0].roles[0].current === "session-self");
const retireOut = await retireRoster.execute({ action: "retire", team: "night-shift", role: "coordinator", note: "下班交班" }, execFor(retireEnv.senderAgent));
check("U4: retire empties current and records the retirement in the version history", retireOut.includes("已退役") && teamStore(retireEnv)[0].roles[0].current === null && teamStore(retireEnv)[0].roles[0].history.length === 1 && typeof teamStore(retireEnv)[0].roles[0].history[0].until === "number" && teamStore(retireEnv)[0].roles[0].history[0].note === "下班交班");
check("retire does not touch trust data on its own — the cleanup is the user's call", retireEnv.uq.requests.length === 1 && retireEnv.uq.requests[0].questions[0].id === "retire-cleanup" && retireEnv.uq.requests[0].agent === retireEnv.senderAgent);
const retireQuestion = retireEnv.uq.requests[0].questions[0].question;
check("the retirement dialog lists every reference to the retired session, both directions", retireQuestion.includes("session-self ↔ session-target") && !retireQuestion.includes("session-child ↔ session-other") && retireQuestion.includes("trustedSenders") && retireQuestion.includes("rememberTargets") && retireQuestion.includes("pairs"));
check("U4: confirming the dialog cleans exactly the references pointing at the retired session", retireOut.includes("已清理") && retireEnv.ns.data.pairs.length === 1 && retireEnv.ns.data.pairs[0].a === "session-child" && retireEnv.ns.data.trustedSenders.length === 0 && retireEnv.ns.data.rememberTargets.join(",") === "session-target");
check("retire leaves the role vacant and the mirror agrees", teamStore(retireEnv)[0].roles[0].current === null && (await readFile(mirrorFile, "utf8")).length > 0);

const keepEnv = teamEnv({ teams: [teamRow({ current: "session-self" })], askScript: ["保留"] });
keepEnv.ns.data.pairs = [{ a: "session-self", b: "session-target", createdAt: 1 }];
const keepOut = await keepEnv.tool("team_link_roster").execute({ action: "retire", team: "night-shift", role: "coordinator" }, execFor(keepEnv.senderAgent));
check("U4: choosing 保留 keeps every trust reference untouched", keepOut.includes("已保留") && keepEnv.ns.data.pairs.length === 1 && teamStore(keepEnv)[0].roles[0].current === null);

const noRefEnv = teamEnv({ teams: [teamRow({ current: "session-self" })] });
const noRefOut = await noRefEnv.tool("team_link_roster").execute({ action: "retire", team: "night-shift", role: "coordinator" }, execFor(noRefEnv.senderAgent));
check("with nothing pointing at the retired session there is no dialog at all", noRefEnv.uq.requests.length === 0 && noRefOut.includes("无需清理") && teamStore(noRefEnv)[0].roles[0].current === null);

const noUqEnv = teamEnv({ teams: [teamRow({ current: "session-self" })], omitUserQuestions: true });
noUqEnv.ns.data.pairs = [{ a: "session-self", b: "session-target", createdAt: 1 }];
const noUqOut = await noUqEnv.tool("team_link_roster").execute({ action: "retire", team: "night-shift", role: "coordinator" }, execFor(noUqEnv.senderAgent));
check("without the confirmation service retire still completes and reports the skipped cleanup", noUqOut.includes("确认服务（userQuestions）不可用") && noUqOut.includes("已退役") && noUqEnv.ns.data.pairs.length === 1 && teamStore(noUqEnv)[0].roles[0].current === null);

// --- R3 (M2 review): applyRetire's two error branches, purely ---------------
// Both paths were only reachable through a live retire call, so the helpers that
// decide them had no direct coverage. They are pure, so they are pinned here —
// plus one end-to-end call per branch, to prove the tool surfaces the same text.
const retireFixture = (roles) => ({ name: "night-shift", createdAt: 1, workspace: "", policy: { writer: "coordinator" }, roles });
const unknownRole = __testing.applyRetire(retireFixture([{ role: "coordinator", current: "session-self", pending: null, history: [] }]), { role: "reviewer", now: 5 });
check("R3: applyRetire refuses a role the team does not have (and returns no team)", unknownRole.error !== undefined && unknownRole.error.includes("没有角色 reviewer") && unknownRole.team === undefined);
const vacantRole = __testing.applyRetire(retireFixture([{ role: "coordinator", current: null, pending: null, history: [{ session: "session-old", from: 1, until: 4 }] }]), { role: "coordinator", now: 5 });
check("R3: applyRetire refuses an already vacant role (and returns no team)", vacantRole.error !== undefined && vacantRole.error.includes("已经空缺") && vacantRole.team === undefined);
const branchEnv = teamEnv({ teams: [teamRow({ current: "session-self" })] });
const branchRoster = branchEnv.tool("team_link_roster");
const unknownRoleOut = await branchRoster.execute({ action: "retire", team: "night-shift", role: "reviewer" }, execFor(branchEnv.senderAgent));
check("R3: the tool reports the unknown-role branch and changes nothing", unknownRoleOut.includes("退役失败：团队 night-shift 没有角色 reviewer") && teamStore(branchEnv)[0].roles[0].current === "session-self");
await branchRoster.execute({ action: "set-role", team: "night-shift", role: "reviewer", session: "session-target" }, execFor(branchEnv.senderAgent));
await branchRoster.execute({ action: "retire", team: "night-shift", role: "reviewer" }, execFor(branchEnv.senderAgent));
const vacantRetireOut = await branchRoster.execute({ action: "retire", team: "night-shift", role: "reviewer" }, execFor(branchEnv.senderAgent));
check("R3: retiring an already vacant (non-coordinator) role is refused with the vacancy text", vacantRetireOut.includes("退役失败：团队 night-shift 的角色 reviewer 已经空缺（vacant），无需退役") && teamStore(branchEnv)[0].roles.find((entry) => entry.role === "reviewer").current === null);

// --- R1 (M2 review): the retire cleanup must not roll back concurrent writes --
// The cleanup dialog is an unbounded human wait, so everything collected before
// it is a display artifact. The scripted answer below mutates the store WHILE the
// dialog is open — exactly what a second session (or the user in the settings UI)
// does — and the write-back must keep that new pair.
const raceEnv = teamEnv({
	teams: [teamRow({ current: "session-self" })],
	askScript: [async () => {
		const latest = raceEnv.ns.data.pairs;
		raceEnv.ns.data.pairs = [...latest, { a: "session-worker-a", b: "session-worker-b", createdAt: 99 }];
		return "清理";
	}],
});
raceEnv.ns.data.pairs = [{ a: "session-self", b: "session-target", createdAt: 1 }];
raceEnv.ns.data.trustedSenders = ["session-self"];
const raceOut = await raceEnv.tool("team_link_roster").execute({ action: "retire", team: "night-shift", role: "coordinator" }, execFor(raceEnv.senderAgent));
check("R1: a pair created while the dialog was open survives the cleanup (no read-modify-write rollback)", raceEnv.ns.data.pairs.length === 1 && raceEnv.ns.data.pairs[0].a === "session-worker-a" && raceEnv.ns.data.pairs[0].createdAt === 99);
check("R1: the references the dialog actually listed are gone", raceOut.includes("已清理：1 个 pairs") && raceEnv.ns.data.trustedSenders.length === 0);
check("R1: the result states the write-back basis honestly", raceOut.includes("按最新设置视图过滤"));

// --- reads are open, detail carries the version history ---------------------
const detailEnv = teamEnv({ teams: [teamRow({ current: "session-self" })] });
await detailEnv.tool("team_link_roster").execute({ action: "set-role", team: "night-shift", role: "reviewer", session: "session-target", note: "评审岗" }, execFor(detailEnv.senderAgent));
const detailOut = await detailEnv.tool("team_link_roster").execute({ action: "get", team: "night-shift" }, foreignExec());
check("roster get is readable by any session (the write gate does not gate reads)", detailOut.includes("角色 coordinator：现任 session-self") && detailOut.includes("角色 reviewer：现任 session-target") && detailOut.includes("评审岗") && detailOut.includes("→ 现任"));
check("the detail view reports the blackboard root", detailOut.includes(path.join(TEAM_WS, "team", "night-shift")));
const summaryOut = await detailEnv.tool("team_link_roster").execute({ action: "get" }, foreignExec());
check("roster get without a team returns the registry summary only", summaryOut.includes("团队注册表（共 1 个团队）") && !summaryOut.includes("版本史（共"));

// --- the mirror is best-effort: a failure never blocks the settings write ----
const mirrorEnv = teamEnv({ teams: [teamRow({ writer: "any", current: "session-self" })] });
const mirrorLineNote = `${"n".repeat(3)} 备注带 emoji 🔵`;
await mirrorEnv.tool("team_link_roster").execute({ action: "set-role", team: "night-shift", role: "reviewer", session: "session-target", note: mirrorLineNote }, execFor(mirrorEnv.senderAgent));
const writtenMirror = await readFile(mirrorFile, "utf8");
check("the mirror agrees with the settings source of truth (role, incumbent, note)", writtenMirror.includes("### reviewer") && writtenMirror.includes("现任：session-target") && writtenMirror.includes("🔵"));
check("the mirror is well-formed (no lone surrogate leaves the plugin)", !hasLone(writtenMirror));

const blockedRoot = path.join(TEAM_TMP, "blocked-root");
await writeFile(blockedRoot, "not a directory", "utf8");
const blockedEnv = teamEnv({ teams: [teamRow({ name: "blocked-team", writer: "any", workspace: blockedRoot })] });
const blockedMirrorOut = await blockedEnv.tool("team_link_roster").execute({ action: "set-role", team: "blocked-team", role: "reviewer", session: "session-target" }, execFor(blockedEnv.senderAgent));
check("a mirror-write failure is a warning only — the settings change still lands (§3.3.1 best-effort)", blockedMirrorOut.includes("已设置") && blockedMirrorOut.includes("镜像写入失败") && blockedMirrorOut.includes("settings 是本插件的事实源") && teamStore(blockedEnv)[0].roles.some((entry) => entry.role === "reviewer" && entry.current === "session-target"));
check("the failed mirror leaves no half-written file", !existsSync(path.join(blockedRoot, "team", "blocked-team", "roster.md")));
// ---------------------------------------------------------------------------
// M2 (§3.3.3): the team blackboard — decisions ledger + discipline lock
// ---------------------------------------------------------------------------

const boardDir = path.join(TEAM_WS, "team", "night-shift");
const decisionsPath = path.join(boardDir, "decisions.md");
const disciplinePath = path.join(boardDir, "discipline.md");
/** Independent re-implementation of the plugin hash, so the tests check the
 * discipline lock against the file content rather than against itself. */
const hashOf = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
const decisionsHashOf = (out) => {
	const start = out.indexOf("--- decisions.md");
	const end = out.indexOf("--- discipline.md");
	if (start === -1 || end === -1) return "";
	const matched = /baseHash=([0-9a-f]{16})/u.exec(out.slice(start, end));
	return matched === null ? "" : matched[1];
};
const disciplineHashOf = (out) => {
	const start = out.indexOf("--- discipline.md");
	if (start === -1) return "";
	const matched = /baseHash=([0-9a-f]{16})/u.exec(out.slice(start));
	return matched === null ? "" : matched[1];
};

const boardEnv = teamEnv({ teams: [teamRow({ current: "session-self" })] });
const boardRead = boardEnv.tool("team_link_team_read");
const boardAppend = boardEnv.tool("team_link_team_append");
rmSync(decisionsPath, { force: true });
rmSync(disciplinePath, { force: true });

const freshRead = await boardRead.execute({ team: "night-shift" }, execFor(boardEnv.targetAgent));
check("team_read is open to any session and reports absent files honestly instead of failing", freshRead.includes("团队 night-shift 黑板") && freshRead.includes("（文件不存在，按空处理：0 条）") && freshRead.includes("（文件不存在，按空处理）baseHash=") && freshRead.includes("（空）"));
check("team_read hands back a baseHash for both files even when they are absent", (freshRead.match(/baseHash=[0-9a-f]{16}/gu) ?? []).length === 2 && freshRead.includes(`baseHash=${hashOf("")}`));
check("team_read carries the roster summary (writer policy + roles)", freshRead.includes("policy.writer=coordinator") && freshRead.includes("角色 coordinator：现任 session-self"));
// R4 (M2 review): decisions' baseHash is NOT a lock — the ledger is append-only
// and accepts no baseHash at all. Only discipline's hash serializes writers, so
// the tool description and the returned text both have to say which is which.
check("R4: the read tool description marks decisions' baseHash as reference/audit only", boardRead.description.includes("仅供参考/审计") && boardRead.description.includes("decisions 只追加、不接受 baseHash 参数") && boardRead.description.includes("乐观锁"));
check("R4: the returned text labels the absent decisions hash as reference/audit", freshRead.includes("（空内容哈希；仅供参考/审计）"));
check("R4: the returned text labels the absent discipline hash as the optimistic lock", freshRead.includes("（空内容哈希；乐观锁：整文件替换必须携带此值）"));

// --- decisions: append-only ledger with a plugin-assigned seq ----------------
const dec1 = await boardAppend.execute({ team: "night-shift", file: "decisions", line: "统一用 team_link_send 汇报" }, execFor(boardEnv.senderAgent));
const ledger1 = (await readFile(decisionsPath, "utf8")).trim().split("\n");
check("decisions append writes exactly the documented row (§3.3.3)", ledger1.length === 1 && /^1 \| \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \| session-self \| 统一用 team_link_send 汇报$/u.test(ledger1[0]) && dec1.includes("已追加 decisions #1"));
const dec2 = await boardAppend.execute({ team: "night-shift", file: "decisions", line: "冲突升级给协调者" }, execFor(boardEnv.targetAgent));
const ledger2 = (await readFile(decisionsPath, "utf8")).trim().split("\n");
check("decisions seq is monotonic and plugin-assigned, and any session may write it", ledger2.length === 2 && ledger2[1].startsWith("2 | ") && ledger2[1].includes("| session-target | 冲突升级给协调者") && dec2.includes("已追加 decisions #2"));
check("the ledger is append-only — the earlier row is byte-identical", ledger2[0] === ledger1[0]);

const tooLongDecision = await boardAppend.execute({ team: "night-shift", file: "decisions", line: "长".repeat(501) }, execFor(boardEnv.senderAgent));
check("a decisions line past the 500-character cap is refused and nothing is written (§4.1)", tooLongDecision.includes("超过单行上限 500") && tooLongDecision.includes("§4.1") && (await readFile(decisionsPath, "utf8")).trim().split("\n").length === 2);
const atCap = await boardAppend.execute({ team: "night-shift", file: "decisions", line: "长".repeat(500) }, execFor(boardEnv.senderAgent));
check("exactly 500 characters is accepted — the cap is inclusive", atCap.includes("已追加 decisions #3"));
const multiLine = await boardAppend.execute({ team: "night-shift", file: "decisions", line: "第一行\n第二行" }, execFor(boardEnv.senderAgent));
check("a multi-line decision is refused — the ledger is one row per line", multiLine.includes("必须单行") && (await readFile(decisionsPath, "utf8")).trim().split("\n").length === 3);
const emojiDecision = await boardAppend.execute({ team: "night-shift", file: "decisions", line: "🔵".repeat(400) }, execFor(boardEnv.senderAgent));
check("the cap counts code points, not UTF-16 units (400 astral characters = 800 units)", emojiDecision.includes("已追加 decisions #4"));

// A file whose last append was interrupted before its terminator must not merge
// the new row into the old one, and the seq still follows the file's maximum.
await writeFile(decisionsPath, "7 | 2026-01-01T00:00:00.000Z | session-other | 手工补写的行", "utf8");
const repaired = await boardAppend.execute({ team: "night-shift", file: "decisions", line: "补一行" }, execFor(boardEnv.senderAgent));
const repairedRows = (await readFile(decisionsPath, "utf8")).split("\n").filter((row) => row.trim() !== "");
check("an unterminated last row is repaired, not merged, and the seq follows the file's maximum", repaired.includes("已追加 decisions #8") && repairedRows.length === 2 && repairedRows[0].startsWith("7 | ") && repairedRows[1].startsWith("8 | "));

// --- discipline: whole-file replace behind the baseHash optimistic lock ------
const hashA = disciplineHashOf(freshRead);
const disc1 = await boardAppend.execute({ team: "night-shift", file: "discipline", line: "第一版：汇报走 team_link_send", baseHash: hashA }, execFor(boardEnv.senderAgent));
check("discipline replace with team_read's baseHash succeeds (optimistic lock)", disc1.includes("已替换 discipline.md") && (await readFile(disciplinePath, "utf8")) === "第一版：汇报走 team_link_send");
check("the result announces the new baseHash the next writer must carry", disc1.includes(`baseHash ${hashOf("第一版：汇报走 team_link_send")} →`) || disc1.includes(hashOf("第一版：汇报走 team_link_send")));
const staleDisc = await boardAppend.execute({ team: "night-shift", file: "discipline", line: "第二版（并发覆盖）", baseHash: hashA }, execFor(boardEnv.targetAgent));
check("a stale baseHash is refused, the file is untouched, and a re-read is demanded (§3.3.3 乐观锁)", staleDisc.includes("baseHash 不匹配") && staleDisc.includes("重新 team_link_team_read") && (await readFile(disciplinePath, "utf8")) === "第一版：汇报走 team_link_send");
const missingHash = await boardAppend.execute({ team: "night-shift", file: "discipline", line: "第二版" }, execFor(boardEnv.senderAgent));
check("discipline without a baseHash is refused", missingHash.includes("必须携带") && (await readFile(disciplinePath, "utf8")) === "第一版：汇报走 team_link_send");
const reread = await boardRead.execute({ team: "night-shift" }, execFor(boardEnv.senderAgent));
const hashB = disciplineHashOf(reread);
check("team_read hands back the hash of the current content after a change", hashB === hashOf("第一版：汇报走 team_link_send") && hashB !== hashA && decisionsHashOf(reread) === hashOf(await readFile(decisionsPath, "utf8")));
check("R4: with content present the decisions hash still says reference/audit, the discipline hash still says lock", reread.includes("（仅供参考/审计：decisions 只追加、不接受 baseHash 参数）") && reread.includes("baseHash=") && /baseHash=\w+（乐观锁：整文件替换必须携带此值）/u.test(reread));
const disc2 = await boardAppend.execute({ team: "night-shift", file: "discipline", line: "第二版：改由 reviewer 汇总", baseHash: hashB }, execFor(boardEnv.targetAgent));
check("a re-read followed by the fresh baseHash succeeds (the two-worker flow §3.3.3 exists for)", disc2.includes("已替换 discipline.md") && (await readFile(disciplinePath, "utf8")) === "第二版：改由 reviewer 汇总");
const longDiscipline = await boardAppend.execute({ team: "night-shift", file: "discipline", line: `短行\n${"长".repeat(501)}`, baseHash: hashOf("第二版：改由 reviewer 汇总") }, execFor(boardEnv.senderAgent));
check("discipline content carries the same per-line 500-character cap", longDiscipline.includes("第 2 行超过单行上限 500") && (await readFile(disciplinePath, "utf8")) === "第二版：改由 reviewer 汇总");
const clearDiscipline = await boardAppend.execute({ team: "night-shift", file: "discipline", line: "", baseHash: hashOf("第二版：改由 reviewer 汇总") }, execFor(boardEnv.senderAgent));
check("an empty replacement is accepted — discipline is a whole-file replace", clearDiscipline.includes("已替换 discipline.md") && (await readFile(disciplinePath, "utf8")) === "");

// --- the read window, the author field, and the guards ----------------------
const windowEnv = teamEnv({ teams: [teamRow({ writer: "any" })] });
const windowAppend = windowEnv.tool("team_link_team_append");
rmSync(decisionsPath, { force: true });
for (let n = 1; n <= 25; n += 1) {
	await windowAppend.execute({ team: "night-shift", file: "decisions", line: `第 ${n} 条裁决` }, execFor(windowEnv.targetAgent));
}
const windowOut = await windowEnv.tool("team_link_team_read").execute({ team: "night-shift" }, execFor(windowEnv.senderAgent));
check("team_read shows only the trailing 20 decisions of 25 (§3.3.3 K=20)", windowOut.includes("共 25 条，显示 20 条") && windowOut.includes("| 第 6 条裁决") && windowOut.includes("| 第 25 条裁决") && !windowOut.includes("| 第 5 条裁决"));
check("the window keeps the plugin-assigned seq visible", windowOut.includes("6 | ") && windowOut.includes("25 | "));
const anonAppend = await windowAppend.execute({ team: "night-shift", file: "decisions", line: "无会话身份的写入" }, { signal: new AbortController().signal });
check("the blackboard has no write gate: a caller without a session identity still writes, recorded honestly as author=unknown", anonAppend.includes("已追加 decisions #26") && anonAppend.includes("author=unknown") && (await readFile(decisionsPath, "utf8")).includes("| unknown | 无会话身份的写入"));

const unknownRead = await boardRead.execute({ team: "no-such-team" }, execFor(boardEnv.senderAgent));
check("team_read on an unregistered team refuses with the bootstrap hint", unknownRead.includes("不在注册表中") && unknownRead.includes("upsert-team"));
const unknownAppend = await boardAppend.execute({ team: "no-such-team", file: "decisions", line: "x" }, execFor(boardEnv.senderAgent));
check("team_append on an unregistered team refuses", unknownAppend.includes("不在注册表中"));
const badFile = await rejects(boardAppend, { team: "night-shift", file: "roster", line: "x" }, execFor(boardEnv.senderAgent));
check("the file argument is an enum — no other blackboard file can be addressed", badFile instanceof Error && badFile.message.includes("file"));
const pathFile = await rejects(boardAppend, { team: "night-shift", file: "../discipline", line: "x" }, execFor(boardEnv.senderAgent));
check("a path-shaped file argument dies on the same enum (no traversal through file)", pathFile instanceof Error && pathFile.message.includes("file") && !existsSync(path.join(TEAM_WS, "team", "discipline.md")));
const traversalTeam = await boardRead.execute({ team: "../etc" }, execFor(boardEnv.senderAgent));
check("the team name is validated before it ever reaches a path", traversalTeam.includes("非法"));

const noWsEnv = teamEnv({ teams: [teamRow({ workspace: "" })] });
const noWsRead = await noWsEnv.tool("team_link_team_read").execute({ team: "night-shift" }, execFor(noWsEnv.senderAgent));
check("a team with no captured workspace reports the blackboard unusable instead of guessing a root", noWsRead.includes("没有 workspace 记录"));
const noWsAppend = await noWsEnv.tool("team_link_team_append").execute({ team: "night-shift", file: "decisions", line: "x" }, execFor(noWsEnv.senderAgent));
check("team_append refuses the same way without a workspace root", noWsAppend.includes("没有 workspace 记录"));

// ---------------------------------------------------------------------------
// M3 (§3.4): broadcast fan-out — one full gate pass per target
// ---------------------------------------------------------------------------

/** Roster of the M3 fixture: a seated coordinator, two live workers, and one
 * vacant role (the §3.4 no-holder path). */
const FAN_ROLES = [
	{ role: "coordinator", current: "session-self", pending: null, history: [{ session: "session-self", from: 1, until: null }] },
	{ role: "worker-a", current: "session-worker-a", pending: null, history: [{ session: "session-worker-a", from: 1, until: null }] },
	{ role: "worker-b", current: "session-worker-b", pending: null, history: [{ session: "session-worker-b", from: 1, until: null }] },
	{ role: "reviewer", current: null, pending: null, history: [] },
];
const pairSelf = (id) => ({ a: "session-self", b: id, createdAt: 1 });
/** M3 fixture: the team above plus two live worker agents that record what they
 * receive, over the settings-backed policy store. */
function fanEnv({ pairs = [], omitUserQuestions = false, askScript = [] } = {}) {
	const env = teamEnv({
		teams: [{ name: "night-shift", createdAt: 1_700_000_000_000, workspace: TEAM_WS, policy: { writer: "coordinator" }, roles: structuredClone(FAN_ROLES) }],
		askScript,
		omitUserQuestions,
		extraAgents: [{ id: "session-worker-a", status: "idle" }, { id: "session-worker-b", status: "idle" }],
	});
	env.ns.data.pairs = structuredClone(pairs);
	env.send = env.tool("team_link_send");
	env.calls = (id) => env.extraCalls.get(id);
	env.workerExec = (id) => execFor(env.agentFor(id));
	return env;
}

// --- U5 (unit): resolveTargets, the §3.4 pseudo-code ------------------------
const { resolveTargets } = __testing;
const unitTeams = [{ name: "night-shift", createdAt: 1, workspace: "", policy: { writer: "coordinator" }, roles: structuredClone(FAN_ROLES) }];
const unitWildcard = resolveTargets("team:night-shift/*", unitTeams, "session-self");
check("U5: resolveTargets passes a session id straight through (first priority)", resolveTargets("session-target", unitTeams, "session-self").rows[0].sessionId === "session-target");
check("U5: resolveTargets resolves team:<name>/<role> to the incumbent", resolveTargets("team:night-shift/worker-a", unitTeams, "session-worker-b").rows[0].sessionId === "session-worker-a");
check("U5: a vacant role returns the typed no-holder row, never [null] (评审 #7)", resolveTargets("team:night-shift/reviewer", unitTeams, undefined).rows[0].outcome === "no-holder" && resolveTargets("team:night-shift/reviewer", unitTeams, undefined).rows[0].detail === "该角色当前空缺");
check("U5: the wildcard is refused for anyone but the incumbent coordinator", resolveTargets("team:night-shift/*", unitTeams, "session-worker-a").error !== undefined && unitWildcard.error === undefined);
check("U5: the wildcard expands to the filled roles only, minus the caller", unitWildcard.rows.length === 2 && unitWildcard.rows.every((row) => row.sessionId === "session-worker-a" || row.sessionId === "session-worker-b"));
check("U5: the wildcard honours the live-member filter of allLiveMembers", resolveTargets("team:night-shift/*", unitTeams, "session-self", { isLive: (id) => id !== "session-worker-b" }).rows.length === 1);
check("U5: resolveTargets refuses an unknown team", resolveTargets("team:ghost/worker-a", unitTeams, "session-self").error !== undefined);
const vacantCoordinatorTeams = [{ name: "night-shift", createdAt: 1, workspace: "", policy: { writer: "coordinator" }, roles: [{ role: "coordinator", current: null, pending: null, history: [] }] }];
check("U5: a vacant coordinator refuses the wildcard even for a caller claiming the role", (resolveTargets("team:night-shift/*", vacantCoordinatorTeams, "session-self").error ?? "").includes("空缺"));

// --- U5 (tool): the wildcard gate, per-target gates, bounds, dedupe --------
const wildEnv = fanEnv();
const workerWildcard = await wildEnv.send.execute({ targets: ["team:night-shift/*"], message: "全队通知" }, wildEnv.workerExec("session-worker-a"));
check("U5: a worker's team-wide broadcast is refused", workerWildcard.includes("全队广播被拒绝") && workerWildcard.includes("现任协调者会话"));
check("U5: the refusal carries the §5.3 curation argument", workerWildcard.includes("策展每个 worker 看到什么") && workerWildcard.includes("flash worker 最稀缺的资源是上下文") && workerWildcard.includes("§5.3"));
check("U5: a refused wildcard delivers nothing at all — fail-closed, no partial fan-out", wildEnv.calls("session-worker-a").followedup.length === 0 && wildEnv.calls("session-worker-b").followedup.length === 0);
const bareTeamExpr = await wildEnv.send.execute({ targets: ["team:night-shift"], message: "x" }, execFor(wildEnv.senderAgent));
check("U5: a bare team: expression is a malformed address, not a session id", bareTeamExpr.includes("寻址表达式 team:night-shift 非法"));
const ghostTeam = await wildEnv.send.execute({ targets: ["team:no-such-team/worker-a"], message: "x" }, execFor(wildEnv.senderAgent));
check("U5: an unregistered team refuses the whole call with a readable error", ghostTeam.includes("发送失败") && ghostTeam.includes("不在注册表中") && ghostTeam.includes("upsert-team"));

const fanA = fanEnv({ pairs: [pairSelf("session-worker-a"), pairSelf("session-worker-b")] });
const fanOut = await fanA.send.execute({ targets: ["team:night-shift/*"], message: "全队通知：接口地址已切到 v2" }, execFor(fanA.senderAgent));
check("U5: the incumbent coordinator's wildcard reaches every filled live role", fanA.calls("session-worker-a").followedup.length === 1 && fanA.calls("session-worker-b").followedup.length === 1);
check("U5: the wildcard skips the vacant role and the caller, so the fan-out is exactly two targets", fanOut.includes("广播 fan-out：2 个目标") && !fanOut.includes("reviewer"));
check("U5: every target gets its own row, labelled with the resolved id and its expression", fanOut.includes("- session-worker-a（via team:night-shift/*） → delivered：") && fanOut.includes("- session-worker-b（via team:night-shift/*） → delivered："));
check("U5: the report ends with the N-delivered / M-refused summary line", fanOut.includes("汇总：2 投递 / 0 拒绝。"));
check("U5: the broadcast really is the relay path — a full banner per target", fanA.calls("session-worker-a").followedup[0].content[0].text.startsWith("📨 [跨会话消息 · 来自会话 session-self") && fanA.calls("session-worker-b").followedup[0].content[0].text.includes("接口地址已切到 v2"));

const p2pEnv = fanEnv({ pairs: [{ a: "session-worker-a", b: "session-worker-b", createdAt: 1 }] });
const p2pOut = await p2pEnv.send.execute({ targets: ["team:night-shift/worker-b"], message: "点对点：请复核 A 方案" }, p2pEnv.workerExec("session-worker-a"));
check("U5: any session may address a role point-to-point", p2pOut.includes("session-worker-b（via team:night-shift/worker-b） → delivered：") && p2pEnv.calls("session-worker-b").followedup.length === 1);
check("U5: the point-to-point row is summarised too", p2pOut.includes("汇总：1 投递 / 0 拒绝。"));

const holderEnv = fanEnv();
const holderOut = await holderEnv.send.execute({ targets: ["team:night-shift/reviewer", "team:night-shift/ghost"], message: "x" }, execFor(holderEnv.senderAgent));
check("U5: a vacant role returns the typed no-holder result", holderOut.includes("- team:night-shift/reviewer → no-holder：该角色当前空缺"));
check("U5: a role that is not in the team resolves the same way, honestly labelled", holderOut.includes("- team:night-shift/ghost → no-holder：团队 night-shift 没有角色 ghost（未注册，等同空缺）"));
check("U5: no-holder counts as neither a delivery nor a failure", holderOut.includes("汇总：0 投递 / 0 拒绝 / 2 空缺目标（no-holder，不计入投递与失败）。"));
check("U5: no-holder delivers nothing", holderEnv.calls("session-worker-a").followedup.length === 0 && holderEnv.calls("session-worker-b").followedup.length === 0);

const closedEnv = fanEnv({ omitUserQuestions: true });
const closedOut = await closedEnv.send.execute({ targets: ["session-worker-a", "session-worker-b"], message: "批量" }, execFor(closedEnv.senderAgent));
check("U5: without the confirmation service EVERY unpaired target fails closed — one row each, no batch shortcut", (closedOut.match(/→ refused：发送失败：跨会话发送需要用户批准，但确认服务（userQuestions）不可用。/gu) ?? []).length === 2);
check("U5: the fail-closed batch reports zero deliveries and delivers nothing", closedOut.includes("汇总：0 投递 / 2 拒绝。") && closedEnv.calls("session-worker-a").followedup.length === 0 && closedEnv.calls("session-worker-b").followedup.length === 0);

const mixEnv = fanEnv({ omitUserQuestions: true, pairs: [pairSelf("session-worker-a")] });
const mixOut = await mixEnv.send.execute({ targets: ["session-worker-a", "session-worker-b"], message: "半配对" }, execFor(mixEnv.senderAgent));
check("U5: one target's gates never decide another's — the paired target still gets its message", mixEnv.calls("session-worker-a").followedup.length === 1 && mixEnv.calls("session-worker-b").followedup.length === 0);
check("U5: the mixed report counts one delivery and one refusal", mixOut.includes("汇总：1 投递 / 1 拒绝。"));

const blockEnv = fanEnv({ pairs: [pairSelf("session-worker-a"), pairSelf("session-worker-b")] });
blockEnv.ns.data.blockedSenders = ["session-self"];
const blockOut = await blockEnv.send.execute({ targets: ["team:night-shift/*"], message: "全队通知" }, execFor(blockEnv.senderAgent));
check("U5: the explicit block is re-checked per target and pairs do not override it", (blockOut.match(/→ refused：未投递：目标会话已屏蔽来自当前会话的消息。/gu) ?? []).length === 2 && blockEnv.calls("session-worker-a").followedup.length === 0);
check("U5: the blocked broadcast reports zero deliveries", blockOut.includes("汇总：0 投递 / 2 拒绝。"));

const deadFanEnv = fanEnv();
const deadFanOut = await deadFanEnv.send.execute({ targets: ["session-nope"], message: "喂" }, execFor(deadFanEnv.senderAgent));
check("U5: a target with no live agent is its own row and its own summary bucket", deadFanOut.includes("- session-nope → no-agent：❌ 未投递：目标会话 session-nope 没有活动代理") && deadFanOut.includes("汇总：0 投递 / 0 拒绝 / 1 无活动代理。"));
check("U5: the no-agent row is the same self-healing refusal as the single-target one (this caller's workspace holds no other live session)", deadFanOut.includes("当前工作区无其他存活会话。") && deadFanOut.includes("请对照上列 id 核对目标 id（常见错误：转录错位）"));

// --- 生产事故：把「1 投递 / 2 拒绝」读成「已广播」 --------------------------
// A batch that lost a target OPENS with a ❌ lead, so its report can never be
// skimmed as the report of a batch that reached everyone; a batch that reached
// everyone keeps its historic shape exactly (header / rows / summary).
const firstLine = (text) => String(text).split("\n")[0];
check("fan-out 失败领先: the all-delivered report keeps its historic first line and gains no ❌", firstLine(fanOut) === "广播 fan-out：2 个目标" && !fanOut.includes("❌") && !fanOut.includes("个目标未投递"));
check("fan-out 失败领先: one delivery + one refusal leads with 1 未投递 / 1 已投递", firstLine(mixOut) === "❌ 1 个目标未投递（1 个已投递）");
check("fan-out 失败领先: a fully refused batch leads with 2 未投递 / 0 已投递", firstLine(closedOut) === "❌ 2 个目标未投递（0 个已投递）");
check("fan-out 失败领先: a dead target leads with 1 未投递 / 0 已投递", firstLine(deadFanOut) === "❌ 1 个目标未投递（0 个已投递）");
check("fan-out 失败领先: the per-target rows and the original summary still follow the lead", mixOut.includes("\n广播 fan-out：2 个目标\n") && mixOut.trimEnd().endsWith("汇总：1 投递 / 1 拒绝。"));
check("fan-out 失败领先: a no-holder target counts as 未投递 in the lead (the message did not reach it) while the summary keeps its own bucket", firstLine(holderOut) === "❌ 2 个目标未投递（0 个已投递）" && holderOut.includes("汇总：0 投递 / 0 拒绝 / 2 空缺目标（no-holder，不计入投递与失败）。"));

const nineEnv = fanEnv();
const nineOut = await nineEnv.send.execute({ targets: Array.from({ length: 9 }, (_, index) => `session-x${index}`), message: "x" }, execFor(nineEnv.senderAgent));
check("U5: more than 8 targets is refused before a single message is delivered (§4.1)", nineOut.includes("发送失败") && nineOut.includes("最多 8 个目标（本次 9 个") && nineEnv.calls("session-worker-a").followedup.length === 0);
const eightEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const eightOut = await eightEnv.send.execute({ targets: ["session-worker-a", ...Array.from({ length: 7 }, (_, index) => `session-y${index}`)], message: "x" }, execFor(eightEnv.senderAgent));
check("U5: exactly 8 targets is accepted and dead ones are reported per row", eightOut.includes("广播 fan-out：8 个目标") && eightEnv.calls("session-worker-a").followedup.length === 1 && eightOut.includes("7 无活动代理"));

const dedupEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const dedupOut = await dedupEnv.send.execute({ targets: ["session-worker-a", "session-worker-a", "team:night-shift/worker-a"], message: "去重" }, execFor(dedupEnv.senderAgent));
check("U5: duplicate targets are delivered once", dedupEnv.calls("session-worker-a").followedup.length === 1);
check("U5: the duplicates are reported in the header and in the summary", dedupOut.includes("广播 fan-out：1 个目标（重复目标已去重 2 个）") && dedupOut.includes("汇总：1 投递 / 0 拒绝 / 2 个重复目标已去重。"));

const argEnv = fanEnv();
const bothOut = await argEnv.send.execute({ targetSessionId: "session-worker-a", targets: ["session-worker-b"], message: "x" }, execFor(argEnv.senderAgent));
check("U5: targets and targetSessionId are mutually exclusive", bothOut.includes("发送失败") && bothOut.includes("互斥"));
const neitherOut = await argEnv.send.execute({ message: "x" }, execFor(argEnv.senderAgent));
check("U5: a send with no address at all is an explicit parameter error", neitherOut.includes("需要 targetSessionId") && neitherOut.includes("targets"));
check("U5: neither rejected call delivered anything", argEnv.calls("session-worker-a").followedup.length === 0 && argEnv.calls("session-worker-b").followedup.length === 0);

// ---------------------------------------------------------------------------
// M3 (§3.4): the envelope banner (V10: source stays at three members)
// ---------------------------------------------------------------------------

const metaEnv = fanEnv({ pairs: [pairSelf("session-worker-a"), pairSelf("session-worker-b")] });
const bannerLine = (id, index = 0) => metaEnv.calls(id).followedup[index].content[0].text.split("\n")[0];
await metaEnv.send.execute({ targetSessionId: "session-worker-a", message: "裁决：走 A 方案", meta: { type: "ruling", pri: "P0", ref: "slp-a1b2" } }, execFor(metaEnv.senderAgent));
check("U7: the envelope renders as the banner's first-line compact fields (§3.4 示例格式)", /^📨 \[跨会话消息 · 来自会话 session-self · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} · type=ruling pri=P0 ref=slp-a1b2\]$/u.test(bannerLine("session-worker-a")));
check("U7: the envelope leaves the body and the payload alone", metaEnv.calls("session-worker-a").followedup[0].content[0].text.includes("裁决：走 A 方案") && metaEnv.calls("session-worker-a").followedup[0].content[0].text.includes("（如需回复"));
check("U7: source is still exactly the three audited members (V10 红线)", Object.keys(metaEnv.calls("session-worker-a").followedup[0].source).length === 3 && metaEnv.calls("session-worker-a").followedup[0].source.kind === "agent-message" && metaEnv.calls("session-worker-a").followedup[0].source.form === "relay");

await metaEnv.send.execute({ targetSessionId: "session-worker-a", message: "只给 pri", meta: { pri: "P2" } }, execFor(metaEnv.senderAgent));
check("U7: a partial envelope renders only the keys the caller gave", /· pri=P2\]$/u.test(bannerLine("session-worker-a", 1)) && !bannerLine("session-worker-a", 1).includes("type=") && !bannerLine("session-worker-a", 1).includes("ref="));
await metaEnv.send.execute({ targetSessionId: "session-worker-a", message: "无信封" }, execFor(metaEnv.senderAgent));
check("U7: a send without meta keeps the pre-M3 banner shape exactly", /^📨 \[跨会话消息 · 来自会话 session-self · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]$/u.test(bannerLine("session-worker-a", 2)));
const emptyMetaOut = await metaEnv.send.execute({ targetSessionId: "session-worker-a", message: "空 meta 对象", meta: {} }, execFor(metaEnv.senderAgent));
check("U7: an empty envelope object is not an error and renders no field", emptyMetaOut.includes("已投递") && /^📨 \[跨会话消息 · 来自会话 session-self · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]$/u.test(bannerLine("session-worker-a", 3)));

const longRef = "r".repeat(17);
const refOut = await metaEnv.send.execute({ targetSessionId: "session-worker-a", message: "长引用", meta: { ref: longRef } }, execFor(metaEnv.senderAgent));
check("U7: a ref past 16 characters is cut at the code-point boundary", bannerLine("session-worker-a", 4).endsWith(`ref=${"r".repeat(16)}]`) && !bannerLine("session-worker-a", 4).includes(longRef));
check("U7: the truncation is reported in the result instead of being swallowed", refOut.includes("meta.ref 超过 16 字符（原 17 字符）") && refOut.includes(`已按码点截断为「${"r".repeat(16)}」`));
const astralRefOut = await metaEnv.send.execute({ targetSessionId: "session-worker-a", message: "星面引用", meta: { ref: "🔵".repeat(17) } }, execFor(metaEnv.senderAgent));
check("U7: the ref limit counts code points, so an astral reference is never cut in half", bannerLine("session-worker-a", 5).endsWith(`ref=${"🔵".repeat(16)}]`) && !hasLone(bannerLine("session-worker-a", 5)));
check("U7: the astral truncation is reported too", astralRefOut.includes("meta.ref 超过 16 字符（原 17 字符）"));

const metaDeliveredBefore = metaEnv.calls("session-worker-a").followedup.length;
const badTypeOut = await metaEnv.send.execute({ targetSessionId: "session-worker-a", message: "x", meta: { type: "order" } }, execFor(metaEnv.senderAgent));
check("U7: an out-of-enum meta.type is an explicit parameter error", badTypeOut.includes("meta.type 非法") && badTypeOut.includes("ruling / receipt / report / ask"));
const badPriOut = await metaEnv.send.execute({ targetSessionId: "session-worker-a", message: "x", meta: { pri: "P9" } }, execFor(metaEnv.senderAgent));
check("U7: an out-of-enum meta.pri is an explicit parameter error", badPriOut.includes("meta.pri 非法") && badPriOut.includes("P0 / P1 / P2"));
const unknownKeyOut = await metaEnv.send.execute({ targetSessionId: "session-worker-a", message: "x", meta: { kind: "ruling" } }, execFor(metaEnv.senderAgent));
check("U7: an undefined meta field is refused instead of silently dropped", unknownKeyOut.includes("未定义的字段 kind"));
const badRefOut = await metaEnv.send.execute({ targetSessionId: "session-worker-a", message: "x", meta: { ref: 7 } }, execFor(metaEnv.senderAgent));
check("U7: a non-string ref is refused", badRefOut.includes("meta.ref 必须是字符串"));
const emptyRefOut = await metaEnv.send.execute({ targetSessionId: "session-worker-a", message: "x", meta: { ref: "" } }, execFor(metaEnv.senderAgent));
check("U7: an empty ref is refused rather than rendered as an empty field", emptyRefOut.includes("不能是空字符串"));
const scalarMetaOut = await metaEnv.send.execute({ targetSessionId: "session-worker-a", message: "x", meta: "ruling" }, execFor(metaEnv.senderAgent));
check("U7: a non-object meta is refused", scalarMetaOut.includes("meta 必须是对象"));
const newlineRefOut = await metaEnv.send.execute({ targetSessionId: "session-worker-a", message: "x", meta: { ref: "a\nb" } }, execFor(metaEnv.senderAgent));
check("U7: a ref carrying a newline is refused (the envelope is one line)", newlineRefOut.includes("控制字符或换行"));
check("U7: not one rejected envelope delivered anything", metaEnv.calls("session-worker-a").followedup.length === metaDeliveredBefore);

const sharedEnv = fanEnv({ pairs: [pairSelf("session-worker-a"), pairSelf("session-worker-b")] });
const sharedOut = await sharedEnv.send.execute({ targets: ["team:night-shift/*"], message: "全队裁决", meta: { type: "ruling", pri: "P1", ref: "slp-c3d4" } }, execFor(sharedEnv.senderAgent));
const sharedLines = ["session-worker-a", "session-worker-b"].map((id) => sharedEnv.calls(id).followedup[0].content[0].text.split("\n")[0]);
check("U7: one fan-out shares the same envelope across every target", sharedOut.includes("汇总：2 投递 / 0 拒绝。") && sharedLines.every((line) => line.endsWith("· type=ruling pri=P1 ref=slp-c3d4]")));
check("U7: both fan-out banners are well-formed and carry three-member sources", ["session-worker-a", "session-worker-b"].every((id) => !hasLone(sharedEnv.calls(id).followedup[0].content[0].text) && Object.keys(sharedEnv.calls(id).followedup[0].source).length === 3));

// ---------------------------------------------------------------------------
// M3 (§3.5): busy prediction on delivery
// ---------------------------------------------------------------------------

const busyMarkAt = Date.now() - 5 * 60000 - 30000; // 5.5 minutes ago → "已运行 5 分钟"
const busyEnv = setup({
	sessions: [],
	askScript: ["发送", "接收"],
	targetStatus: "running",
	eventsBySession: { "session-target": [{ type: "turn/start", seq: 1, time: busyMarkAt, data: { turn: 1 } }] },
});
const busyOut = await busyEnv.tool("team_link_send").execute({ targetSessionId: "session-target", message: "停一下，发现冲突" }, execFor(busyEnv.senderAgent));
check("§3.5: a running target's reply states how long its current turn has been running", busyOut.includes("目标回合已运行 5 分钟（steer 注入当前回合）"));
check("§3.5: ... and tells the sender how to get new-turn semantics", busyOut.includes("需新回合语义请等其空闲"));
check("§3.5: the prediction changes nothing about delivery — a running target is still steered", busyEnv.targetCalls.steered.length === 1 && busyEnv.targetCalls.followedup.length === 0);

const noMarkEnv = setup({ sessions: [], askScript: ["发送", "接收"], targetStatus: "running" });
const noMarkOut = await noMarkEnv.tool("team_link_send").execute({ targetSessionId: "session-target", message: "x" }, execFor(noMarkEnv.senderAgent));
check("§3.5: without a readable turn start the steer semantics are still stated, without a number", noMarkOut.includes("起始时间不可读（steer 注入当前回合）") && noMarkOut.includes("需新回合语义请等其空闲") && !/已运行 \d+ 分钟/u.test(noMarkOut));

const idleBusyEnv = setup({ sessions: [], askScript: ["发送", "接收"] });
const idleBusyOut = await idleBusyEnv.tool("team_link_send").execute({ targetSessionId: "session-target", message: "x" }, execFor(idleBusyEnv.senderAgent));
check("§3.5: an idle target keeps the legacy wake sentence unchanged", idleBusyOut.includes("目标空闲，已唤醒目标会话并作为新回合处理（消息与回复稍后出现在目标会话中）") && !idleBusyOut.includes("steer"));

const busyFanEnv = fanEnv({ pairs: [pairSelf("session-worker-a"), pairSelf("session-worker-b")] });
busyFanEnv.agentFor("session-worker-a").status = "running";
const busyFanOut = await busyFanEnv.send.execute({ targets: ["session-worker-a", "session-worker-b"], message: "x" }, execFor(busyFanEnv.senderAgent));
check("§3.5: inside a fan-out the running target's row carries the prediction and the idle one keeps the wake sentence", busyFanOut.includes("目标回合运行中，起始时间不可读（steer 注入当前回合）") && busyFanOut.includes("目标空闲，已唤醒目标会话"));
check("§3.5: and the fan-out still steers the running target and follows up the idle one", busyFanEnv.calls("session-worker-a").steered.length === 1 && busyFanEnv.calls("session-worker-b").followedup.length === 1);

// ---------------------------------------------------------------------------
// U13 (§10.1.2): the sender-side receipt — `output.presentationMeta`
// ---------------------------------------------------------------------------

/** One dispatch and its card, projected the way the Tool registry does it: the
 * body stashes the card against the frozen `exec.arguments` object and the
 * registry later calls `presentationMeta` with that SAME object (dsh-tools:
 * `tool.execute(exec.arguments, exec)` then
 * `tool.output.presentationMeta(exec.arguments, value)`). Reusing the object here
 * mirrors that identity instead of re-deriving it. */
async function sendWithCard(env, args, exec) {
	const value = await env.send.execute(args, exec);
	return { value, card: env.send.output.presentationMeta(args, value) };
}
/** Deep equality of two JSON values (key order included — a replayed log must
 *  reproduce the identical card). */
const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const isCardShape = (card) => card !== null && typeof card === "object" && card.kind === "team-link-send" && card.v === 1;
const outcomesOf = (card) => card.targets.map((target) => `${target.sessionId ?? "-"}:${target.outcome}`).join(",");

const receiptEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
check("U13: team_link_send declares output.presentationMeta — the §10.1.2 carrier (pre-fix: undefined, so the sender row has no structured source at all)", typeof receiptEnv.send.output.presentationMeta === "function");
const receiptArgs = { targetSessionId: "session-worker-a", message: "裁决：走 A 方案", meta: { type: "ruling", pri: "P0", ref: "slp-a1b2" } };
const { value: receiptText, card: receiptCard } = await sendWithCard(receiptEnv, receiptArgs, execFor(receiptEnv.senderAgent));
check("U13: the model-visible text is untouched — the returned value is still one plain sentence", typeof receiptText === "string" && receiptText.startsWith("已投递到 session-worker-a") && receiptText.includes("目标空闲，已唤醒目标会话并作为新回合处理"));
check("U13: ... and output.render still snapshots it as the single text block textOutput produced (same schema, same renderer)", sameJson(receiptEnv.send.output.render(receiptArgs, receiptText), [{ type: "text", text: receiptText }]));
check("U13: the card carries the §10.1.2 discriminators and the sender identity", isCardShape(receiptCard) && receiptCard.senderSessionId === "session-self" && typeof receiptCard.at === "number" && receiptCard.at > 0 && receiptCard.fanout === false);
check("U13: a single-target receipt has exactly one target row, with the id and the delivered outcome", receiptCard.targets.length === 1 && receiptCard.targets[0].sessionId === "session-worker-a" && receiptCard.targets[0].outcome === "delivered");
// B1 (差异审计): the row detail is the per-target result sentence — the same
// source the text report prints — but the report may append a CALL-level note
// ("注意：meta.ref 超过 16 字符…", see the U7 case above) that is not a per-target
// result line and so is deliberately NOT copied into the row. The claim is
// therefore "identical until the envelope note"; the boundary is pinned from
// both sides right below.
check("U13: the row detail is the SAME sentence the text report prints (identical while no envelope note is appended)", receiptCard.targets[0].detail === receiptText && !receiptText.includes("注意："));
check("U13: a literal session id is not an addressing expression, so the row carries no expr", receiptCard.targets[0].expr === undefined);
// B1's other side: with a truncated envelope ref the report grows a call-level
// note, and the row must NOT — the note is not that target's result line, and the
// fan-out path keeps it out of every row the same way (`report.lines.push`).
const notedEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const notedArgs = { targetSessionId: "session-worker-a", message: "带长引用", meta: { ref: "r".repeat(17) } };
const { value: notedText, card: notedCard } = await sendWithCard(notedEnv, notedArgs, execFor(notedEnv.senderAgent));
check("B1: a truncated meta.ref appends its note to the TEXT report (the U7 behavior the card deliberately does not copy)", notedText.includes("注意：meta.ref 超过 16 字符（原 17 字符）"));
check("B1: ... while the row detail stays the per-target sentence — the report's FIRST line, with the note left out", notedCard.targets[0].detail === notedText.split("\n")[0] && !notedCard.targets[0].detail.includes("注意：") && notedCard.targets[0].detail !== notedText);
check("B1: ... and the truncated envelope itself still rides the card", sameJson(notedCard.meta, { ref: "r".repeat(16) }));
check("U13: the summary counts the row kinds (delivered/refused/noAgent/noHolder/deduped)", sameJson(receiptCard.summary, { delivered: 1, refused: 0, noAgent: 0, noHolder: 0, deduped: 0 }));
check("U13: the body is carried in full when it is inside the cap (chars = code points, truncated false)", !receiptCard.message.truncated && receiptCard.message.chars === [..."裁决：走 A 方案"].length && receiptCard.message.text === "裁决：走 A 方案");
check("U13: the envelope appears on the card exactly as normalized for the banner (§3.4 three keys only)", sameJson(receiptCard.meta, { type: "ruling", pri: "P0", ref: "slp-a1b2" }));

const noMetaEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const noMetaArgs = { targetSessionId: "session-worker-a", message: "无信封" };
const noMetaValue = await noMetaEnv.send.execute(noMetaArgs, execFor(noMetaEnv.senderAgent));
const noMetaCard = noMetaEnv.send.output.presentationMeta(noMetaArgs, noMetaValue);
check("U13: a send without an envelope carries no meta member at all (not an empty object)", isCardShape(noMetaCard) && !Object.prototype.hasOwnProperty.call(noMetaCard, "meta"));
const emptyMetaEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const emptyMetaArgs = { targetSessionId: "session-worker-a", message: "空信封", meta: {} };
const emptyMetaValue = await emptyMetaEnv.send.execute(emptyMetaArgs, execFor(emptyMetaEnv.senderAgent));
const emptyMetaCard = emptyMetaEnv.send.output.presentationMeta(emptyMetaArgs, emptyMetaValue);
check("U13: `meta: {}` is a legal no-op and stays one on the card (no empty meta member)", emptyMetaCard.kind === "team-link-send" && !Object.prototype.hasOwnProperty.call(emptyMetaCard, "meta"));

// --- truncation (§10.1.2 体积纪律: head 1500 + 3-code-point mark + tail 400) ---
const longTail = "尾".repeat(400);
const longBody = "头".repeat(1500) + "中".repeat(200) + longTail;
const longEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const longArgs = { targetSessionId: "session-worker-a", message: longBody };
const longValue = await longEnv.send.execute(longArgs, execFor(longEnv.senderAgent));
const longCard = longEnv.send.output.presentationMeta(longArgs, longValue);
check("U13: a body past the 2000-code-point cap is truncated and says so", longCard.message.truncated === true && longCard.message.chars === 2100);
check("U13: ... the kept text is head 1500 + the 3-code-point mark + tail 400", [...longCard.message.text].length === 1903 && longCard.message.text.startsWith("头".repeat(1500)) && longCard.message.text.slice(1500, 1503) === "..." && longCard.message.text.endsWith(longTail));
check("U13: ... and `chars` reports the ORIGINAL code-point count, not the kept one", longCard.message.chars !== [...longCard.message.text].length && longCard.message.chars === [...longBody].length);
const atCapEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const atCapArgs = { targetSessionId: "session-worker-a", message: "x".repeat(2000) };
const atCapValue = await atCapEnv.send.execute(atCapArgs, execFor(atCapEnv.senderAgent));
const atCapCard = atCapEnv.send.output.presentationMeta(atCapArgs, atCapValue);
check("U13: exactly 2000 code points is NOT truncated (the cap is inclusive)", atCapCard.message.truncated === false && atCapCard.message.chars === 2000 && atCapCard.message.text === "x".repeat(2000));
const overEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const overArgs = { targetSessionId: "session-worker-a", message: "y".repeat(2001) };
const overValue = await overEnv.send.execute(overArgs, execFor(overEnv.senderAgent));
const overCard = overEnv.send.output.presentationMeta(overArgs, overValue);
check("U13: 2001 code points IS truncated — the boundary is where §10.1.2 says it is", overCard.message.truncated === true && overCard.message.chars === 2001);
// The cut unit is the code point, and the string is repaired before it is cut, so
// an astral character straddling the boundary cannot leave half a surrogate pair
// in the log — the card IS persisted (tool/result.meta).
const astralBody = "🔵".repeat(2600);
const astralEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const astralArgs = { targetSessionId: "session-worker-a", message: astralBody };
const astralValue = await astralEnv.send.execute(astralArgs, execFor(astralEnv.senderAgent));
const astralCard = astralEnv.send.output.presentationMeta(astralArgs, astralValue);
check("U13: an astral body is cut on code points — 1500 + 3 + 400, no half pair", [...astralCard.message.text].length === 1903 && astralCard.message.chars === 2600 && !hasLone(astralCard.message.text));
const poisonedBody = "断开的\uD83D负载";
const poisonedEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const poisonedArgs = { targetSessionId: "session-worker-a", message: poisonedBody };
const poisonedValue = await poisonedEnv.send.execute(poisonedArgs, execFor(poisonedEnv.senderAgent));
const poisonedCard = poisonedEnv.send.output.presentationMeta(poisonedArgs, poisonedValue);
check("U13: a lone surrogate inherited from the argument is repaired before it can be persisted", !hasLone(poisonedCard.message.text) && poisonedCard.message.chars === [...poisonedBody].length);

// --- F2 (差异审计): every OTHER string member of the card ---------------------
// `message.text` was the only member locked above. The card is persisted at
// `tool/result.meta` and never passes `textOutput.render`, so each of its
// strings needs its own gate AND its own lock: a lone surrogate anywhere in the
// persisted meta fails the SENDER session's next model request with HTTP 400 —
// permanently (the section header above). The model-visible text of the same
// call is clean (it goes through `wellFormed` on return), which is exactly why
// these cases are about the card and nothing else.
/** The whole card as the log will hold it: every string member at once. */
const cardHasLone = (card) => hasLone(JSON.stringify(card));

// (a) a LITERAL session id: echoed straight from the caller's own argument.
const poisonIdEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const poisonId = "session-\uD800target";
const poisonIdArgs = { targetSessionId: poisonId, message: "x" };
const poisonIdValue = await poisonIdEnv.send.execute(poisonIdArgs, execFor(poisonIdEnv.senderAgent));
const poisonIdCard = poisonIdEnv.send.output.presentationMeta(poisonIdArgs, poisonIdValue);
check("F2: a lone surrogate in a literal target id is repaired on the card (pre-fix: the card carried it while the text was clean)", isCardShape(poisonIdCard) && !cardHasLone(poisonIdCard) && poisonIdCard.targets[0].sessionId === "session-\uFFFDtarget");
check("F2: ... and the model-visible text of that same call was already clean — the card was the only leaking path", !hasLone(poisonIdValue) && poisonIdValue.includes("session-\uFFFDtarget"));

// (b) an ADDRESSING EXPRESSION: reaches the card as `expr` on the no-holder path
//     (`fanout` stores the caller's expression verbatim for a row with no id).
const poisonExprEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const poisonExpr = "team:night-shift/\uD800";
const poisonExprArgs = { targets: [poisonExpr], message: "x" };
const poisonExprValue = await poisonExprEnv.send.execute(poisonExprArgs, execFor(poisonExprEnv.senderAgent));
const poisonExprCard = poisonExprEnv.send.output.presentationMeta(poisonExprArgs, poisonExprValue);
check("F2: a lone surrogate in a team:<n>/<role> expression is repaired on the card (no-holder row)", isCardShape(poisonExprCard) && !cardHasLone(poisonExprCard) && poisonExprCard.targets[0].sessionId === null && poisonExprCard.targets[0].expr === "team:night-shift/\uFFFD");
check("F2: ... while the same call's text report is clean too (both faces are gated, by different code)", !hasLone(poisonExprValue) && poisonExprCard.targets[0].outcome === "no-holder");

// (c) the envelope: `ref` is caller text, and it is NOT a control character, so
//     `readMeta`'s single-line check lets a lone surrogate through untouched.
const poisonRefEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const poisonRefArgs = { targetSessionId: "session-worker-a", message: "x", meta: { ref: "slp-\uD800" } };
const poisonRefValue = await poisonRefEnv.send.execute(poisonRefArgs, execFor(poisonRefEnv.senderAgent));
const poisonRefCard = poisonRefEnv.send.output.presentationMeta(poisonRefArgs, poisonRefValue);
check("F2: a lone surrogate in meta.ref is repaired on the card (the control-character check does not catch it)", isCardShape(poisonRefCard) && !cardHasLone(poisonRefCard) && poisonRefCard.meta.ref === "slp-\uFFFD");
check("F2: the repaired envelope keeps its other two keys and the §3.4 shape", isCardShape(poisonRefCard) && Object.keys(poisonRefCard.meta).join(",") === "ref");

// --- busy (§3.5) as a structured value -----------------------------------------
const receiptBusyEnv = setup({
	sessions: [],
	askScript: ["发送", "接收"],
	targetStatus: "running",
	eventsBySession: { "session-target": [{ type: "turn/start", seq: 1, time: busyMarkAt, data: { turn: 1 } }] },
});
const busyCardArgs = { targetSessionId: "session-target", message: "停一下" };
const busyCardValue = await receiptBusyEnv.tool("team_link_send").execute(busyCardArgs, execFor(receiptBusyEnv.senderAgent));
const busyCard = receiptBusyEnv.tool("team_link_send").output.presentationMeta(busyCardArgs, busyCardValue);
check("U13: a readable running turn becomes `{running:true, minutes}` — the same reading the sentence prints", sameJson(busyCard.targets[0].busy, { running: true, minutes: 5 }));
const idleCardEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const idleCardArgs = { targetSessionId: "session-worker-a", message: "空闲" };
const idleCardValue = await idleCardEnv.send.execute(idleCardArgs, execFor(idleCardEnv.senderAgent));
const idleCard = idleCardEnv.send.output.presentationMeta(idleCardArgs, idleCardValue);
check("U13: an idle target is `{running:false}` — a followup woke it into a NEW turn, so no minutes", sameJson(idleCard.targets[0].busy, { running: false }));
const unreadableEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
unreadableEnv.agentFor("session-worker-a").status = "running";
const unreadableArgs = { targetSessionId: "session-worker-a", message: "读不到起始时间" };
const unreadableValue = await unreadableEnv.send.execute(unreadableArgs, execFor(unreadableEnv.senderAgent));
const unreadableCard = unreadableEnv.send.output.presentationMeta(unreadableArgs, unreadableValue);
check("U13: an unreadable turn start degrades to `{running:true}` — running without a number, never a made-up one", sameJson(unreadableCard.targets[0].busy, { running: true }));

// --- refusals: a card only where a delivery stage actually ran -----------------
const noAgentEnv = fanEnv();
const noAgentArgs = { targetSessionId: "session-nope", message: "喂" };
const noAgentValue = await noAgentEnv.send.execute(noAgentArgs, execFor(noAgentEnv.senderAgent));
const noAgentCard = noAgentEnv.send.output.presentationMeta(noAgentArgs, noAgentValue);
check("U13: a no-agent single target still gets a card — the row is the refusal, and it has no busy member", isCardShape(noAgentCard) && noAgentCard.targets[0].outcome === "no-agent" && noAgentCard.targets[0].sessionId === "session-nope" && noAgentCard.targets[0].busy === undefined && noAgentCard.summary.noAgent === 1);
check("U13: the no-agent row detail is the same ❌ sentence the text report shows", noAgentCard.targets[0].detail === noAgentValue && noAgentCard.targets[0].detail.startsWith("❌ 未投递"));

const argRefuseEnv = fanEnv();
const bothArgs = { targetSessionId: "session-worker-a", targets: ["session-worker-b"], message: "x" };
const bothValue = await argRefuseEnv.send.execute(bothArgs, execFor(argRefuseEnv.senderAgent));
check("U13: 降级优先 — an argument-level refusal (mutually exclusive addresses) projects NO card, so the client falls back to the model-visible text", sameJson(argRefuseEnv.send.output.presentationMeta(bothArgs, bothValue), {}));
const noAddressArgs = { message: "x" };
const noAddressValue = await argRefuseEnv.send.execute(noAddressArgs, execFor(argRefuseEnv.senderAgent));
check("U13: ... and so does a send with no address at all", sameJson(argRefuseEnv.send.output.presentationMeta(noAddressArgs, noAddressValue), {}));
const badMetaArgs = { targetSessionId: "session-worker-a", message: "x", meta: { type: "nope" } };
const badMetaValue = await argRefuseEnv.send.execute(badMetaArgs, execFor(argRefuseEnv.senderAgent));
check("U13: ... and an invalid envelope (a parameter error, delivery never started)", sameJson(argRefuseEnv.send.output.presentationMeta(badMetaArgs, badMetaValue), {}));
const nineArgs = { targets: Array.from({ length: 9 }, (_, index) => `session-x${index}`), message: "x" };
const nineValue = await argRefuseEnv.send.execute(nineArgs, execFor(argRefuseEnv.senderAgent));
check("U13: ... and a >8 fan-out refused on the raw argument (no card, so nothing claims a receipt for zero deliveries)", sameJson(argRefuseEnv.send.output.presentationMeta(nineArgs, nineValue), {}));

// --- fan-out: one row per resolved target, ≤8, with the summary ---------------
const fanCardEnv = fanEnv({ pairs: [pairSelf("session-worker-a"), pairSelf("session-worker-b")] });
const fanCardArgs = { targets: ["team:night-shift/*"], message: "全队通知" };
const fanCardValue = await fanCardEnv.send.execute(fanCardArgs, execFor(fanCardEnv.senderAgent));
const fanCard = fanCardEnv.send.output.presentationMeta(fanCardArgs, fanCardValue);
check("U13: a fan-out receipt is flagged as one and holds one row per resolved target", isCardShape(fanCard) && fanCard.fanout === true && fanCard.targets.length === 2 && outcomesOf(fanCard) === "session-worker-a:delivered,session-worker-b:delivered");
check("U13: each fan-out row carries the addressing expression it came from", fanCard.targets.every((target) => target.expr === "team:night-shift/*"));
check("U13: every fan-out row detail is the text report's own row sentence", fanCard.targets.every((target) => fanCardValue.includes(`- ${target.sessionId}（via ${target.expr}） → ${target.outcome}：${target.detail}`)));
check("U13: the fan-out summary counts deliveries and dedupes", sameJson(fanCard.summary, { delivered: 2, refused: 0, noAgent: 0, noHolder: 0, deduped: 0 }));
const holderCardEnv = fanEnv();
const holderCardArgs = { targets: ["team:night-shift/reviewer", "session-nope"], message: "x" };
const holderCardValue = await holderCardEnv.send.execute(holderCardArgs, execFor(holderCardEnv.senderAgent));
const holderCard = holderCardEnv.send.output.presentationMeta(holderCardArgs, holderCardValue);
check("U13: a vacant role is a row with sessionId null and the expression kept (no invented id)", holderCard.targets[0].sessionId === null && holderCard.targets[0].outcome === "no-holder" && holderCard.targets[0].expr === "team:night-shift/reviewer");
check("U13: the buckets match the text report's own summary line", holderCard.summary.noHolder === 1 && holderCard.summary.noAgent === 1 && holderCard.summary.delivered === 0 && holderCardValue.includes("汇总：0 投递 / 0 拒绝 / 1 无活动代理 / 1 空缺目标"));
const dedupCardEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const dedupCardArgs = { targets: ["session-worker-a", "session-worker-a", "team:night-shift/worker-a"], message: "去重" };
const dedupCardValue = await dedupCardEnv.send.execute(dedupCardArgs, execFor(dedupCardEnv.senderAgent));
const dedupCard = dedupCardEnv.send.output.presentationMeta(dedupCardArgs, dedupCardValue);
check("U13: deduplicated targets collapse to one row, and the dropped count is on the card", dedupCard.targets.length === 1 && dedupCard.summary.deduped === 2);
const eightCardEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const eightCardArgs = { targets: ["session-worker-a", ...Array.from({ length: 7 }, (_, index) => `session-y${index}`)], message: "x" };
const eightCardValue = await eightCardEnv.send.execute(eightCardArgs, execFor(eightCardEnv.senderAgent));
const eightCard = eightCardEnv.send.output.presentationMeta(eightCardArgs, eightCardValue);
check("U13: 8 expressions resolve to 8 rows here — the ≤8 fan-out bound counts EXPRESSIONS; the card's own ROW bound is 24 (locked in the block below)", eightCard.targets.length === 8 && !Object.prototype.hasOwnProperty.call(eightCard, "targetsTruncated"));
check("U13: the card is lossless JSON, which is what the registry requires before it persists it as tool/result.meta", sameJson(JSON.parse(JSON.stringify(holderCard)), holderCard) && sameJson(JSON.parse(JSON.stringify(fanCard)), fanCard));

// --- U13 (§10.1.2 2026-09-19 修正): the card's ROW bound is 24, not the ≤8 -----
// The bound locked just above counts the INPUT expressions. ONE `team:<name>/*`
// is one expression and expands to every filled live member, so a legal broadcast
// can carry more rows than 8 — and the array that is persisted as
// `tool/result.meta` is the card's, which is why the ROW bound has to live here.
// Same discipline as the body's 2000/1500+3+400: 有界呈现 + 如实标注 — the cut is
// stated on the card, the summary still counts the whole set, and the
// model-visible report keeps one row per target (the card is a bounded VIEW, the
// report is the full archive).
/** The card's members BEFORE the row bound, in their original order: a ≤24-row
 * receipt must keep that shape key for key (the bound adds a member only to a
 * card it actually cut). */
const PRE_CAP_CARD_KEYS = "kind,v,at,senderSessionId,message,targets,summary,fanout";

/** §3.4 fixture whose wildcard expansion is `memberCount` rows: the caller is the
 * incumbent coordinator (the wildcard's own gate), and each worker is a filled
 * live role AND paired with the caller, so every row is a real delivery rather
 * than a refusal the test would have to explain. */
function wideFanEnv(memberCount) {
	const roles = [{ role: "coordinator", current: "session-self", pending: null, history: [{ session: "session-self", from: 1, until: null }] }];
	const extraAgents = [];
	const pairs = [];
	for (let index = 0; index < memberCount; index += 1) {
		const id = `session-w${String(index).padStart(2, "0")}`;
		roles.push({ role: `w${index}`, current: id, pending: null, history: [{ session: id, from: 1, until: null }] });
		extraAgents.push({ id, status: "idle" });
		pairs.push(pairSelf(id));
	}
	const env = teamEnv({
		teams: [{ name: "night-shift", createdAt: 1_700_000_000_000, workspace: TEAM_WS, policy: { writer: "coordinator" }, roles }],
		extraAgents,
	});
	env.ns.data.pairs = structuredClone(pairs);
	env.send = env.tool("team_link_send");
	return env;
}

/** The report's own per-target rows, in order (the full archive). */
const reportRows = (text) => text.split("\n").filter((line) => line.startsWith("- "));

const wideEnv = wideFanEnv(30);
const wideArgs = { targets: ["team:night-shift/*"], message: "全队通知：接口地址已切到 v2" };
const wideValue = await wideEnv.send.execute(wideArgs, execFor(wideEnv.senderAgent));
const wideCard = wideEnv.send.output.presentationMeta(wideArgs, wideValue);
check("U13 行数界: one wildcard expression legally expands past the ≤8 expression bound — 30 targets, one report row each", wideEnv.extraCalls.size === 30 && reportRows(wideValue).length === 30);
check("U13 行数界: a >24-row receipt is CUT to exactly 24 rows on the card (pre-fix: all 30 rows were welded into tool/result.meta)", wideCard.targets.length === 24);
check("U13 行数界: ... and the card says so itself — the shown/total facts the client's `sendRowsTruncated`「已截断——仅显示前 {shown} 行」 wording needs", sameJson(wideCard.targetsTruncated, { shown: 24, total: 30 }));
check("U13 行数界: the kept rows are the report's own FIRST 24 in order — a prefix of the archive, never a re-sorted sample", wideCard.targets.every((target, index) => reportRows(wideValue)[index] === `- ${target.sessionId}（via ${target.expr}） → ${target.outcome}：${target.detail}`));
check("U13 行数界: the summary still counts the FULL set — the cut costs rows, never a count", sameJson(wideCard.summary, { delivered: 30, refused: 0, noAgent: 0, noHolder: 0, deduped: 0 }));
check("U13 行数界: the model-visible report keeps one row per target plus the full summary line (card = bounded view, report = full archive)", reportRows(wideValue).length === 30 && wideValue.startsWith("广播 fan-out：30 个目标\n") && wideValue.trimEnd().endsWith("汇总：30 投递 / 0 拒绝。"));
check("U13 行数界: all 30 targets really received the message — the cut is presentation only", [...wideEnv.extraCalls.values()].every((calls) => calls.followedup.length === 1));
check("U13 行数界: the cut rides immediately after the array it describes", Object.keys(wideCard).join(",") === "kind,v,at,senderSessionId,message,targets,targetsTruncated,summary,fanout");
check("U13 行数界: the truncated card is still lossless JSON (what the registry requires before persisting it)", sameJson(JSON.parse(JSON.stringify(wideCard)), wideCard));

// 对照 1: exactly 24 rows is INSIDE the bound — inclusive, like the
// 2000-code-point body cap: no cut, no member, no report change.
const at24Env = wideFanEnv(24);
const at24Args = { targets: ["team:night-shift/*"], message: "全队通知" };
const at24Value = await at24Env.send.execute(at24Args, execFor(at24Env.senderAgent));
const at24Card = at24Env.send.output.presentationMeta(at24Args, at24Value);
check("U13 行数界 对照: exactly 24 rows is NOT truncated — the cap is inclusive", at24Card.targets.length === 24 && !Object.prototype.hasOwnProperty.call(at24Card, "targetsTruncated"));
check("U13 行数界 对照: a ≤24-row card gains NO member at all — the pre-bound shape, key for key (the 2-row fixture asserts the same)", Object.keys(at24Card).join(",") === PRE_CAP_CARD_KEYS && Object.keys(fanCard).join(",") === PRE_CAP_CARD_KEYS);
check("U13 行数界 对照: ... and its counts and report rows are the same 24, with nothing else touched", sameJson(at24Card.summary, { delivered: 24, refused: 0, noAgent: 0, noHolder: 0, deduped: 0 }) && reportRows(at24Value).length === 24);

// ---------------------------------------------------------------------------
// M4 (§3.6): rotation — two-phase hand-over, domain-limited migration, TTL rollback
// ---------------------------------------------------------------------------

const SUCCESSOR = "session-new";
const ROT_SELF = "session-self";
const ROT_OUTSIDE = "session-outside";

/** The M4 roster: a seated coordinator (session-self) and two live workers. */
const rotRoles = () => [
	{ role: "coordinator", current: ROT_SELF, pending: null, history: [{ session: ROT_SELF, from: 1_700_000_000_000, until: null }] },
	{ role: "worker-a", current: "session-worker-a", pending: null, history: [{ session: "session-worker-a", from: 1_700_000_000_000, until: null }] },
	{ role: "worker-b", current: "session-worker-b", pending: null, history: [{ session: "session-worker-b", from: 1_700_000_000_000, until: null }] },
];

/**
 * M4 fixture: the roster above, three live agents (two workers + the successor)
 * and the trust state a rotation operates on. `receiveMode: accept` keeps notice
 * delivery out of the receiver dialog; the notice cases set their mode explicitly.
 */
function rotateEnv({ askScript = [], omitUserQuestions = false, pairs = [], trustedSenders = [], rememberTargets = [], blockedSenders = [], receiveMode = "accept", goals, teams } = {}) {
	const env = setup({
		sessions: [],
		useSettings: true,
		askScript,
		omitUserQuestions,
		selfCwd: TEAM_WS,
		goals,
		extraAgents: [
			{ id: "session-worker-a", status: "idle" },
			{ id: "session-worker-b", status: "idle" },
			{ id: SUCCESSOR, status: "idle" },
		],
	});
	const ns = env.settings.namespaces.get("team-link");
	ns.data.teams = structuredClone(teams ?? [{ name: "night-shift", createdAt: 1_700_000_000_000, workspace: TEAM_WS, policy: { writer: "coordinator" }, roles: rotRoles() }]);
	ns.data.pairs = structuredClone(pairs);
	ns.data.trustedSenders = structuredClone(trustedSenders);
	ns.data.rememberTargets = structuredClone(rememberTargets);
	ns.data.blockedSenders = structuredClone(blockedSenders);
	ns.data.receiveMode = receiveMode;
	return {
		...env,
		ns,
		rotate: env.tool("team_link_rotate"),
		roster: env.tool("team_link_roster"),
		send: env.tool("team_link_send"),
		list: env.tool("team_link_list_sessions"),
		rotation: __testing.rotationFor(env.ctx),
		calls: (id) => env.extraCalls.get(id),
		exec: (id) => execFor(env.agentFor(id)),
		team: () => ns.data.teams[0],
		role: (name = "coordinator") => ns.data.teams[0].roles.find((entry) => entry.role === name),
	};
}

const rotPair = (id) => ({ a: ROT_SELF, b: id, createdAt: 1 });
const pairSummary = (env) => (env.ns.data.pairs ?? []).map((pair) => `${pair.a}↔${pair.b}${pair.provisional === true ? "(provisional)" : ""}`).sort().join(" ");
const tokenOf = (text) => (String(text).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u) ?? [])[0];

// --- prepare (Phase A): token, snapshot, freeze broadcast --------------------

const rotA = rotateEnv({
	askScript: [["session-worker-a"]],
	pairs: [rotPair("session-worker-a"), rotPair("session-worker-b"), rotPair(ROT_OUTSIDE), { a: "session-worker-a", b: "session-worker-b", createdAt: 2 }],
	trustedSenders: [ROT_SELF, "session-worker-a"],
	rememberTargets: [ROT_SELF, "session-worker-b"],
});
check("M4: the rotation tool is registered", rotA.rotate !== undefined && rotA.list !== undefined);

const rotPrep = await rotA.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR, note: "INJECT_ME 载荷" }, execFor(rotA.senderAgent));
const rotToken = tokenOf(rotPrep);
check("M4 prepare: the incumbent gets the hand-over package and a fresh one-time token", rotPrep.includes("换届包已就绪") && typeof rotToken === "string" && rotToken.length === 36);
check("M4 prepare: the token is bound to (team, role, successor) with the 30-minute TTL (§3.6.1 原则 1)", (() => {
	const pending = rotA.role().pending;
	return pending.session === SUCCESSOR && pending.token === rotToken && pending.team === "night-shift" && pending.role === "coordinator" && pending.expiresAt - pending.createdAt === 30 * 60000 && Array.isArray(pending.migratedPairs) && pending.migratedPairs.length === 0;
})());
check("M4 prepare: rotationBackup snapshots the pre-rotation trust state (撤销依据)", (() => {
	const backup = rotA.team().rotationBackup;
	return backup !== null && backup.at > 0 && backup.pairs.length === 4 && backup.trustedSenders.length === 2 && backup.rememberTargets.length === 2 && backup.roster.roles.length === 3;
})());
check("M4 prepare: the guidance names the TTL, the model-drafted hand-over and the goal hint (§3.6.2)", rotPrep.includes("30 分钟内有效") && rotPrep.includes("机制与判断分离") && rotPrep.includes("/goal resume") && rotPrep.includes("armed-active = 内建心跳"));
check("M4 prepare: the result states that only the mask is rendered from now on", rotPrep.includes(`tok-${rotToken.slice(0, 4)}…${rotToken.slice(-4)}`));

const freezeMsg = rotA.calls("session-worker-a").followedup[0];
check("M4 prepare: rotation-freeze is the §4.2 constant check-list", freezeMsg !== undefined && freezeMsg.content[0].text.includes("[rotation-freeze]") && freezeMsg.content[0].text.includes("停掉本会话的哨兵/看门狗与后台 job") && freezeMsg.content[0].text.includes("确认没有在飞的动作") && freezeMsg.content[0].text.includes("状态已冻结") && freezeMsg.content[0].text.includes("等待交接结果通知"));
check("M4 prepare: the freeze reaches every other team member, and no sender-side approval was asked", rotA.calls("session-worker-a").followedup.length === 1 && rotA.calls("session-worker-b").followedup.length === 1 && rotA.uq.requests.length === 0);
check("M4 红线: a notice rides the audited three-member source (V10)", Object.keys(freezeMsg.source).length === 3 && freezeMsg.source.kind === "agent-message" && freezeMsg.source.form === "relay" && freezeMsg.source.senderSessionId === ROT_SELF);
check("M4 红线: no model-supplied text can reach a notice body (机制与判断分离)", !freezeMsg.content[0].text.includes("INJECT_ME") && !rotA.calls("session-worker-b").followedup[0].content[0].text.includes("INJECT_ME"));

const rotMirror = await readFile(mirrorFile, "utf8");
const rotGet = await rotA.roster.execute({ action: "get", team: "night-shift" }, execFor(rotA.senderAgent));
check("M4 令牌掩码: the roster.md mirror renders only the masked token (M2 评审 #3)", rotMirror.includes(`tok-${rotToken.slice(0, 4)}…${rotToken.slice(-4)}`) && !rotMirror.includes(rotToken));
check("M4 令牌掩码: roster get renders only the masked token too, and names the binding", rotGet.includes("掩码") && rotGet.includes(`tok-${rotToken.slice(0, 4)}…${rotToken.slice(-4)}`) && rotGet.includes("绑定 team=night-shift role=coordinator") && !rotGet.includes(rotToken));
check("M4 令牌掩码: the plaintext token exists exactly once — in the prepare result", rotPrep.includes(rotToken) && !rotMirror.includes(rotToken) && !rotGet.includes(rotToken));

// --- the third no-agent path: a plugin notice (§3.6.2 internal broadcast) -----
// The notice path builds its sender from an id alone, so there is no session
// identity and therefore no workspace to filter by: the refusal lists the live
// sessions it can see and excludes the caller — that is all it can honestly do.
// (Placed after the mirror assertions above: this prepare writes the same
// `roster.md` mirror and would otherwise re-render it under another token.)
const rotHintEnv = rotateEnv({
	teams: [{
		name: "night-shift",
		createdAt: 1_700_000_000_000,
		workspace: TEAM_WS,
		policy: { writer: "coordinator" },
		roles: [...rotRoles(), { role: "worker-c", current: "session-gone", pending: null, history: [{ session: "session-gone", from: 1_700_000_000_000, until: null }] }],
	}],
});
const rotHintPrep = await rotHintEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(rotHintEnv.senderAgent));
check("no-agent: a notice to a member with no live agent carries the same ❌ 未投递 refusal", rotHintPrep.includes("  - session-gone → no-agent：❌ 未投递：目标会话 session-gone 没有活动代理"));
check("no-agent: with no session identity in the notice path the hint list skips the workspace filter (only the caller is excluded)", rotHintPrep.includes("当前工作区其他存活会话") && rotHintPrep.includes("session-target（空闲）") && !rotHintPrep.includes("session-gone（"));

// --- claim (Phase B): the single dialog, domain-limited migration -----------

const rotClaim = await rotA.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: rotToken, note: "夜班接班" }, rotA.exec(SUCCESSOR));
check("M4 claim: ONE dialog lists every in-domain candidate as a multi-select option (逐项勾选 + 整批确认)", (() => {
	const ask = rotA.uq.requests[0];
	return ask !== undefined && ask.questions.length === 1 && ask.questions[0].multiSelect === true && ask.questions[0].options.map((option) => option.label).join(",") === "session-worker-a,session-worker-b";
})());
check("M4 claim: the dialog states the blast radius — bypassed gates, dropped out-of-domain pairs", (() => {
	const detail = rotA.uq.requests[0].questions[0].detail;
	return detail.includes("绕过两道批准门") && detail.includes(ROT_OUTSIDE) && detail.includes("对端不在本团队域内");
})());
check("M4 claim: the checked pair is migrated as a ratified channel, the unchecked one is not", rotClaim.includes("已获在场确认") && rotClaim.includes("勾选 1 / 候选 2 条") && rotClaim.includes("session-worker-a ↔ session-self → 已迁移为 session-worker-a ↔ session-new（正式通道）") && rotClaim.includes("session-worker-b ↔ session-self → 未迁移（未勾选）"));
check("M4 claim: a pair whose counterpart is outside the roster is never migrated (§3.6.1 原则 2)", rotClaim.includes(`${ROT_OUTSIDE} ↔ session-self → 未迁移（对端不在本团队域内（§3.6.1 原则 2））`));
check("M4 claim: the resulting trust state is exactly kept + migrated", pairSummary(rotA) === "session-new↔session-worker-a session-worker-a↔session-worker-b");
check("M4 claim: revocation is symmetric — pairs/trustedSenders/rememberTargets of the retiree all go (§3.6.1 原则 3)", !rotA.ns.data.pairs.some((pair) => pair.a === ROT_SELF || pair.b === ROT_SELF) && !rotA.ns.data.trustedSenders.includes(ROT_SELF) && !rotA.ns.data.rememberTargets.includes(ROT_SELF) && rotClaim.includes("pairs 3 条已全部清除（其中迁移 1 条）") && rotClaim.includes("trustedSenders 移除 1 项") && rotClaim.includes("rememberTargets 移除 1 项"));
check("M4 claim: the roster settles — current, closed/open tenure with the note, rotationAt, pending cleared", (() => {
	const entry = rotA.role();
	return entry.current === SUCCESSOR && entry.pending === null && entry.provisional === null && entry.rotationAt > 0 && entry.history.length === 2 && entry.history[0].session === ROT_SELF && typeof entry.history[0].until === "number" && entry.history[0].note === "夜班接班" && entry.history[1].session === SUCCESSOR && entry.history[1].until === null;
})());
check("M4 claim: rotation-done is broadcast with the ratified status, from the new incumbent", (() => {
	const done = rotA.calls("session-worker-a").followedup[1];
	return done !== undefined && done.content[0].text.includes("[rotation-done]") && done.content[0].text.includes("信任迁移状态：已批准") && done.content[0].text.includes(`旧任 ${ROT_SELF} → 新任 ${SUCCESSOR}`) && done.source.senderSessionId === SUCCESSOR;
})());
check("M4 claim: a ratified migration opens no rollback window", rotClaim.includes("迁移的 pairs 已是正式通道（无回退窗口）") && rotA.role().provisional === null);

// --- M4 代码评审 #4: the mirror must not keep advertising a cleared pending ---

const rotClaimMirror = await readFile(mirrorFile, "utf8");

check("评审 #4: after a claim the roster mirror renders the post-clear roster — no pending line, no masked token left behind", /### coordinator[\s\S]*?- pending：（无）/u.test(rotClaimMirror) && !rotClaimMirror.includes("tok-"));

// --- M4 代码评审 #6: the outgoing holder hears the hand-over completed --------

check("评审 #6: the retiree (no longer a member after the claim) still receives rotation-done", (() => {
	const done = rotA.senderCalls.followedup.filter((message) => message.content[0].text.includes("[rotation-done]"));
	return done.length === 1 && done[0].content[0].text.includes(`旧任 ${ROT_SELF} → 新任 ${SUCCESSOR}`) && done[0].source.senderSessionId === SUCCESSOR && Object.keys(done[0].source).length === 3;
})());

const rotSend = await rotA.send.execute({ targetSessionId: "session-worker-a", message: "交接后的正式通道" }, rotA.exec(SUCCESSOR));
check("M4: a delivery over the migrated channel is a plain paired delivery (no provisional suffix)", rotSend.includes("已投递到") && rotSend.includes("已配对通道") && !rotSend.includes("provisional"));

const rotAgain = await rotA.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: rotToken }, rotA.exec(SUCCESSOR));
check("U6: a token is single-use — a replay after a completed claim is refused (成功即作废)", rotAgain.includes("没有 pending") && rotAgain.includes("成功即作废"));

// --- prepare preconditions and the anti-storm rate limit --------------------

const gateEnv = rotateEnv();
const notIncumbent = await gateEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, gateEnv.exec("session-worker-a"));
check("U6: prepare is refused for every session but the incumbent (§3.6.2 前置)", notIncumbent.includes("只有该角色的现任会话 session-self 可以发起换届") && gateEnv.role().pending === null);
const selfRot = await gateEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: ROT_SELF }, execFor(gateEnv.senderAgent));
check("U6: a self-succession is refused (it would revoke and re-grant the same session's trust)", selfRot.includes("继任者不能是现任自己") && selfRot.includes("retire") && gateEnv.role().pending === null);
const noSuccessor = await gateEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator" }, execFor(gateEnv.senderAgent));
check("U6: prepare without a successor is refused with the §3.6.4 pointer", noSuccessor.includes("需要 successor") && noSuccessor.includes("§3.6.4") && noSuccessor.includes("team_link_roster action=retire"));
const rotGhostTeam = await gateEnv.rotate.execute({ action: "prepare", team: "no-such-team", role: "coordinator", successor: SUCCESSOR }, execFor(gateEnv.senderAgent));
check("U6: an unknown team refuses prepare", rotGhostTeam.includes("不在注册表中"));
const ghostRole = await gateEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "ghost", successor: SUCCESSOR }, execFor(gateEnv.senderAgent));
check("U6: an unknown role refuses prepare", ghostRole.includes("没有角色 ghost"));
const starRole = await gateEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "*", successor: SUCCESSOR }, execFor(gateEnv.senderAgent));
check("R6: the addressing grammar's reserved word is refused as a role name here too", starRole.includes("寻址文法保留字"));
const rotBadAction = await rejects(gateEnv.rotate, { action: "rotate" }, execFor(gateEnv.senderAgent));
check("U6: the action set is closed to the two phases", rotBadAction instanceof Error);

const rateEnv = rotateEnv();
const firstPrep = await rateEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(rateEnv.senderAgent));
const secondPrep = await rateEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(rateEnv.senderAgent));
check("U6: a second prepare inside the 10-minute window is refused (防换届风暴)", firstPrep.includes("换届包已就绪") && secondPrep.includes("换届速率限制") && secondPrep.includes("rateLimit(team, role, 10min)") && secondPrep.includes("窗口剩余约"));
const { rotationRateLimited } = __testing;
const RL_NOW = 1_700_000_000_000;
check("U6: the rate limit is a pure function of the pending and rotation timestamps", rotationRateLimited({ pending: { createdAt: RL_NOW - 60000, expiresAt: RL_NOW + 29 * 60000 }, rotationAt: 0 }, RL_NOW).limited === true
	&& rotationRateLimited({ pending: { createdAt: RL_NOW - 11 * 60000, expiresAt: RL_NOW + 19 * 60000 }, rotationAt: 0 }, RL_NOW).limited === false
	&& rotationRateLimited({ pending: null, rotationAt: RL_NOW - 60000 }, RL_NOW).limited === true
	&& rotationRateLimited({ pending: null, rotationAt: RL_NOW - 11 * 60000 }, RL_NOW).limited === false
	&& rotationRateLimited(null, RL_NOW).limited === false);

// --- claim preconditions: token, successor identity, binding, expiry --------

const rotClaimEnv = rotateEnv({ pairs: [rotPair("session-worker-a"), rotPair("session-worker-b")] });
const rotTokenC = tokenOf(await rotClaimEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(rotClaimEnv.senderAgent)));
const rotWrongToken = await rotClaimEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: "00000000-0000-0000-0000-000000000000" }, rotClaimEnv.exec(SUCCESSOR));
check("U6: a wrong token is refused and nothing moves", rotWrongToken.includes("令牌不匹配") && rotClaimEnv.role().current === ROT_SELF && pairSummary(rotClaimEnv) === "session-self↔session-worker-a session-self↔session-worker-b");
const rotMaskedToken = await rotClaimEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: __testing.maskToken(rotTokenC) }, rotClaimEnv.exec(SUCCESSOR));
check("U6: the masked rendering is not a token (the mask is a rendering, not a credential)", rotMaskedToken.includes("令牌不匹配") && rotMaskedToken.includes("掩码形式"));
const rotWrongSession = await rotClaimEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: rotTokenC }, execFor(rotClaimEnv.senderAgent));
check("U6: only the pending's successor session may claim (§3.6.1 原则 1)", rotWrongSession.includes("只有 pending 指定的继任者会话 session-new 可以认领") && rotClaimEnv.role().current === ROT_SELF);

const rotBindRoleEnv = rotateEnv();
rotBindRoleEnv.role().pending = { session: SUCCESSOR, token: "bind-token", team: "night-shift", role: "worker-a", expiresAt: Date.now() + 600000, createdAt: Date.now() };
const rotMismatchRole = await rotBindRoleEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: "bind-token" }, rotBindRoleEnv.exec(SUCCESSOR));
check("U6: a token bound to another role is refused (绑定三元组)", rotMismatchRole.includes("令牌绑定不匹配") && rotMismatchRole.includes("role=worker-a"));
const rotBindTeamEnv = rotateEnv();
rotBindTeamEnv.role().pending = { session: SUCCESSOR, token: "bind-token-2", team: "day-shift", role: "coordinator", expiresAt: Date.now() + 600000, createdAt: Date.now() };
const rotMismatchTeam = await rotBindTeamEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: "bind-token-2" }, rotBindTeamEnv.exec(SUCCESSOR));
check("U6: ... and a token bound to another team is refused too", rotMismatchTeam.includes("令牌绑定不匹配") && rotMismatchTeam.includes("team=day-shift"));

const rotExpiredEnv = rotateEnv({ pairs: [rotPair("session-worker-a"), rotPair("session-worker-b")] });
rotExpiredEnv.role().pending = { session: SUCCESSOR, token: "expired-token", team: "night-shift", role: "coordinator", expiresAt: Date.now() - 1000, createdAt: Date.now() - 31 * 60000, migratedPairs: [] };
const rotExpiredClaim = await rotExpiredEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: "expired-token" }, rotExpiredEnv.exec(SUCCESSOR));
check("U6: an expired token is refused, the pending is cancelled and the old incumbent stays current (评审 #4)", rotExpiredClaim.includes("令牌已过期") && rotExpiredClaim.includes("冻结解除") && rotExpiredEnv.role().pending === null && rotExpiredEnv.role().current === ROT_SELF && rotExpiredEnv.ns.data.pairs.length === 2);
const rotCancelMsg = rotExpiredEnv.calls("session-worker-a").followedup.at(-1);
check("U6 常量文案: rotation-cancelled says 旧任仍为 current / 令牌过期未认领 / 解除冻结", rotCancelMsg !== undefined && rotCancelMsg.content[0].text.includes("[rotation-cancelled]") && rotCancelMsg.content[0].text.includes(`旧任 ${ROT_SELF} 仍为 current`) && rotCancelMsg.content[0].text.includes("令牌过期未认领") && rotCancelMsg.content[0].text.includes("解除冻结"));

// --- the unattended path: provisional trust and the 24h rollback ------------

const rotProvEnv = rotateEnv({ omitUserQuestions: true, pairs: [rotPair("session-worker-a"), rotPair("session-worker-b")] });
const rotProvToken = tokenOf(await rotProvEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(rotProvEnv.senderAgent)));
const rotProvClaimAt = Date.now();
const rotProvClaim = await rotProvEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: rotProvToken }, rotProvEnv.exec(SUCCESSOR));
check("U6: with no confirm service every in-domain pair migrates, and it is provisional", rotProvClaim.includes("确认服务（userQuestions）不可用") && pairSummary(rotProvEnv) === "session-new↔session-worker-a(provisional) session-new↔session-worker-b(provisional)");
check("U6: the provisional pairs carry the 24h rollback deadline", (() => {
	const pair = rotProvEnv.ns.data.pairs.find((entry) => entry.b === "session-worker-a");
	// R8 (M4 round 2, test-hygiene rider): the deadline is asserted against the pair's
	// OWN createdAt (the claim's clock, which is what expiresAt was derived from)
	// instead of against the wall clock captured just before the call. The old form
	// required the tool's `now` to equal that capture to the millisecond, so a single
	// clock tick between the two reads turned it red — measured 1/12 runs on pristine
	// HEAD (flake, not a behavior change).
	return pair.provisional === true && pair.expiresAt - pair.createdAt === 24 * 3600000 && pair.createdAt >= rotProvClaimAt;
})());
check("U6: the roster keeps the open ratification window, and the claim says 待批准(24h)", (() => {
	const entry = rotProvEnv.role();
	return entry.current === SUCCESSOR && entry.pending === null && entry.provisional !== null && entry.provisional.session === SUCCESSOR && entry.provisional.expiresAt > rotProvClaimAt && rotProvClaim.includes("信任迁移状态：待批准(24h)") === false;
})());
check("U6 常量文案: the done notice of an unattended rotation says 待批准(24h)", rotProvEnv.calls("session-worker-a").followedup[1].content[0].text.includes("信任迁移状态：待批准(24h)"));

const rotProvSend = await rotProvEnv.send.execute({ targetSessionId: "session-worker-a", message: "临时通道" }, rotProvEnv.exec(SUCCESSOR));
check("U6 provisional 可见面: a delivery over a provisional channel carries the §3.6.2 suffix", rotProvSend.includes("（provisional 通道，24h 内未批准自动回退）"));
check("U6 provisional 可见面: the banner keeps the §3.4 envelope shape (no provisional field)", (() => {
	const msg = rotProvEnv.calls("session-worker-a").followedup.at(-1);
	return !msg.content[0].text.split("\n")[0].includes("provisional") && Object.keys(msg.source).length === 3;
})());

const rotListEnv = (() => {
	const env = setup({ sessions: [{ header: { id: "session-worker-a", createdAt: 1000, cwd: CWD }, live: true, persisted: true }], useSettings: true, selfCwd: CWD, extraAgents: [{ id: "session-worker-a", status: "idle" }] });
	const ns = env.settings.namespaces.get("team-link");
	ns.data.pairs = [{ a: SUCCESSOR, b: "session-worker-a", createdAt: 1, provisional: true, expiresAt: Date.now() + 3600000 }];
	return { ...env, ns };
})();
const rotListOut = await rotListEnv.tool("team_link_list_sessions").execute({}, execFor(rotListEnv.senderAgent));
check("U6 provisional 可见面: list_sessions marks the unratified channel on the session row (§3.6.2 评审 #3)", rotListOut.includes("provisional 配对 1 条") && rotListOut.includes("24h 内未批准自动回退"));
check("U6 provisional 可见面: the marker sits before the reading stamp, so the row still ends with the stamp", /- session-worker-a[^\n]*provisional 配对 1 条（换届临时信任：24h 内未批准自动回退，见 team_link_roster）（读数 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}，>2min 作废）/u.test(rotListOut));

// 🔵 §9.6 ⑧ (计数口径): the count must agree with the delivery side. 评审 #8 made
// an expired provisional record "no pair" for gate purposes; counting it here
// would advertise a bypass channel that has already closed.
const rotListExpiredEnv = (() => {
	const env = setup({ sessions: [{ header: { id: "session-worker-a", createdAt: 1000, cwd: CWD }, live: true, persisted: true }], useSettings: true, selfCwd: CWD, extraAgents: [{ id: "session-worker-a", status: "idle" }] });
	const ns = env.settings.namespaces.get("team-link");
	ns.data.pairs = [{ a: SUCCESSOR, b: "session-worker-a", createdAt: 1, provisional: true, expiresAt: Date.now() - 1000 }];
	return { ...env, ns };
})();
const rotListExpiredOut = await rotListExpiredEnv.tool("team_link_list_sessions").execute({}, execFor(rotListExpiredEnv.senderAgent));
check("🔵 §9.6 ⑧: a provisional pair past its deadline is not counted as a live provisional channel (same liveness predicate as the delivery side)", rotListExpiredOut.includes("session-worker-a") && !rotListExpiredOut.includes("provisional 配对"));

const rotRollbackNow = rotProvClaimAt + 24 * 3600000 + 60000;
const rotRollbackSweep = await rotProvEnv.rotation.sweep({ now: rotRollbackNow });
check("U6: at the 24h mark the sweep deletes the provisional pairs (评审 #5)", rotRollbackSweep.expired.length === 1 && rotProvEnv.ns.data.pairs.length === 0 && pairSummary(rotProvEnv) === "");
check("U6: history records the unratified rollback and the window closes", (() => {
	const entry = rotProvEnv.role();
	const last = entry.history.at(-1);
	return last.session === SUCCESSOR && last.note === "provisional 未批准过期" && last.until === rotRollbackNow && entry.provisional === null && entry.pending === null;
})());
check("U6: the new incumbent stays current after the rollback — the rotation fact stands (评审 #5 终态)", rotProvEnv.role().current === SUCCESSOR);
const rotExpiredMsg = rotProvEnv.calls("session-worker-a").followedup.at(-1);
check("U6 常量文案: rotation-expired states the rollback, the retained incumbent and the return to the gates", rotExpiredMsg.content[0].text.includes("[rotation-expired]") && rotExpiredMsg.content[0].text.includes("24h 内未获批准，已自动回退") && rotExpiredMsg.content[0].text.includes(`${SUCCESSOR} 仍为 current`) && rotExpiredMsg.content[0].text.includes("正常过门"));
const rotRollbackSend = await rotProvEnv.send.execute({ targetSessionId: "session-worker-a", message: "回退之后" }, rotProvEnv.exec(SUCCESSOR));
check("U6: after the rollback the channel is gone — a send goes through the normal gates again", rotRollbackSend.includes("确认服务（userQuestions）不可用") && !rotRollbackSend.includes("provisional 通道"));

// --- claim idempotency (the crash window between migration and settlement) --

const rotReplayEnv = rotateEnv({ pairs: [{ a: SUCCESSOR, b: "session-worker-a", createdAt: 5 }] });
rotReplayEnv.role().current = SUCCESSOR;
rotReplayEnv.role().pending = {
	session: SUCCESSOR,
	token: "replay-token",
	team: "night-shift",
	role: "coordinator",
	expiresAt: Date.now() + 600000,
	createdAt: Date.now(),
	migratedPairs: [{ a: SUCCESSOR, b: "session-worker-a", createdAt: 5, provisional: false, expiresAt: 0 }],
};
const rotReplayOut = await rotReplayEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: "replay-token" }, rotReplayEnv.exec(SUCCESSOR));
check("U6: a replay returns the recorded migration list instead of migrating again (claim 幂等)", rotReplayOut.includes("claim 重放") && rotReplayOut.includes("不重复迁移") && rotReplayOut.includes("session-worker-a ↔ session-new"));
check("U6: the replay leaves the trust state byte-for-byte alone (no duplicate pair, no second revocation)", pairSummary(rotReplayEnv) === "session-new↔session-worker-a" && rotReplayEnv.ns.data.pairs.length === 1);
check("U6: the replay finishes the bookkeeping — the pending is gone", rotReplayEnv.role().pending === null);
check("U6: the replay re-emits rotation-done so a crash cannot leave the team frozen", rotReplayEnv.calls("session-worker-a").followedup.at(-1).content[0].text.includes("[rotation-done]"));

const rotStaleEnv = rotateEnv();
rotStaleEnv.role().current = "session-worker-a";
rotStaleEnv.role().pending = { session: SUCCESSOR, token: "stale-token", team: "night-shift", role: "coordinator", expiresAt: Date.now() + 600000, createdAt: Date.now(), migratedPairs: [{ a: SUCCESSOR, b: "session-worker-b", createdAt: 5, provisional: false, expiresAt: 0 }] };
const rotStaleOut = await rotStaleEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: "stale-token" }, rotStaleEnv.exec(SUCCESSOR));
check("U6: a replay whose role was re-assigned clears the leftover silently instead of broadcasting a false rotation-done", rotStaleOut.includes("现任已另行变更") && rotStaleEnv.role().pending === null && rotStaleEnv.calls("session-worker-a").followedup.length === 0);

// --- the internal broadcast path: block list, sweep mode, constant bodies ---

const rotBlockedEnv = rotateEnv({ pairs: [rotPair("session-worker-a"), rotPair("session-worker-b")], blockedSenders: [ROT_SELF] });
const rotBlockedPrep = await rotBlockedEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(rotBlockedEnv.senderAgent));
check("M4 广播路径: the explicit block still beats an internal notice (no sender gate, but no override either)", rotBlockedPrep.includes("rotation-freeze") && (rotBlockedPrep.match(/已屏蔽来自当前会话的消息/gu) ?? []).length === 2 && rotBlockedEnv.calls("session-worker-a").followedup.length === 0 && rotBlockedEnv.calls("session-worker-b").followedup.length === 0);

// The confirmation service IS available here: the point of the case is that the
// sweep must not USE it (no dialog is opened, no patrol blocked), which the
// request log proves far better than a refusal text.
const rotAskEnv = rotateEnv({ receiveMode: "ask" });
rotAskEnv.role().pending = { session: SUCCESSOR, token: "ask-token", team: "night-shift", role: "coordinator", expiresAt: Date.now() - 1000, createdAt: Date.now() - 31 * 60000, migratedPairs: [] };
const rotAskSweep = await rotAskEnv.rotation.sweep({ now: Date.now() });
check("M4 广播路径: a sweep-originated notice never opens a dialog — an ask receiver is skipped with a readable row", rotAskSweep.lines.join("\n").includes("不弹确认框") && rotAskEnv.uq.requests.length === 0 && rotAskEnv.calls("session-worker-a").followedup.length === 0 && rotAskEnv.role().pending === null);

const { freezeNotice: rotFreezeNotice, doneNotice: rotDoneNotice, cancelledNotice: rotCancelledNotice, expiredNotice: rotExpiredNotice, maskToken: rotMaskToken, teamMembers: rotTeamMembers, planRotationMigration: rotPlanMigration, applyRotationTrust: rotApplyTrust, rotateGate: rotRotateGate, readRoleName: rotReadRoleName } = __testing;
const rotFreezeText = rotFreezeNotice("night-shift", "coordinator", ROT_SELF, SUCCESSOR, 1700000000000);
check("M4 常量文案: rotation-freeze is the §4.2 check-list (停哨兵/后台 job → 确认无在飞 → 冻结回报 → 等待交接)", rotFreezeText.includes("停掉本会话的哨兵/看门狗与后台 job") && rotFreezeText.includes("确认没有在飞的动作") && rotFreezeText.includes("状态已冻结") && rotFreezeText.includes("等待交接结果通知"));
check("M4 常量文案: rotation-done carries the ratified/provisional status verbatim", rotDoneNotice("t", "coordinator", "a", "b", "已批准", 1).includes("信任迁移状态：已批准") && rotDoneNotice("t", "coordinator", "a", "b", "待批准(24h)", 1).includes("信任迁移状态：待批准(24h)"));
check("M4 常量文案: rotation-expired names the rollback, the retained incumbent and the honesty clause", rotExpiredNotice("t", "coordinator", SUCCESSOR, 1).includes("已自动回退") && rotExpiredNotice("t", "coordinator", SUCCESSOR, 1).includes("仍为 current") && rotDoneNotice("t", "coordinator", "a", "b", "待批准(24h)", 1).includes("不可回收"));
check("M4 常量文案: an interpolated id is scrubbed to a single line before it enters a notice body", !rotFreezeText.includes("\n") && rotFreezeNotice("team", "co\nordinator", ROT_SELF, SUCCESSOR, 1).includes("co_ordinator"));
check("M4 令牌掩码: the mask is tok-head4…tail4 (§3.6.2 example shape)", rotMaskToken("1a2b3c4d-0000-4000-8000-9f0e1d2c") === "tok-1a2b…1d2c" && rotMaskToken("abc") === "tok-…");
check("M4: a prepare gate follows the incumbent, whatever the writer policy says", rotRotateGate({ name: "t" }, { role: "coordinator", current: "s1" }, "s2").error !== undefined && rotRotateGate({ name: "t" }, { role: "coordinator", current: "s1" }, "s1").ok === true && rotRotateGate({ name: "t" }, { role: "coordinator", current: null }, "s1").error.includes("空缺"));

const rotPureTeam = {
	name: "night-shift", createdAt: 1, workspace: "", policy: { writer: "coordinator" }, rotationBackup: null,
	roles: [
		{ role: "coordinator", current: ROT_SELF, pending: null, rotationAt: 0, provisional: null, history: [] },
		{ role: "worker-a", current: "session-worker-a", pending: null, rotationAt: 0, provisional: null, history: [] },
		{ role: "vacant", current: null, pending: null, rotationAt: 0, provisional: null, history: [] },
	],
};
check("M4: teamMembers is the filled roles only, deduplicated", rotTeamMembers(rotPureTeam).join(",") === `${ROT_SELF},session-worker-a`);
const rotPlan = rotPlanMigration({ pairs: [rotPair("session-worker-a"), rotPair(ROT_OUTSIDE), { a: ROT_SELF, b: SUCCESSOR, createdAt: 3 }, { a: "session-worker-a", b: "session-worker-b", createdAt: 4 }] }, { members: new Set(rotTeamMembers(rotPureTeam)), retiree: ROT_SELF, successor: SUCCESSOR });
check("M4: the migration plan keeps in-domain counterparts only and reports the drops", rotPlan.candidates.length === 1 && rotPlan.candidates[0].other === "session-worker-a" && rotPlan.dropped.length === 2 && rotPlan.dropped.some((item) => item.reason.includes("团队域")) && rotPlan.dropped.some((item) => item.reason.includes("继任者")));
const rotTrustOut = rotApplyTrust({ pairs: [rotPair("session-worker-a"), rotPair(ROT_OUTSIDE)], trustedSenders: [ROT_SELF, "x"], rememberTargets: [ROT_SELF, "y"] }, { retiree: ROT_SELF, successor: SUCCESSOR, chosen: rotPlan.candidates, now: 5, provisional: true });
check("M4: applyRotationTrust migrates the chosen pair provisionally and revokes both lists symmetrically", rotTrustOut.pairs.length === 1 && rotTrustOut.pairs[0].a === SUCCESSOR && rotTrustOut.pairs[0].b === "session-worker-a" && rotTrustOut.pairs[0].provisional === true && rotTrustOut.pairs[0].expiresAt === 5 + 24 * 3600000 && rotTrustOut.trustedSenders.join(",") === "x" && rotTrustOut.rememberTargets.join(",") === "y" && rotTrustOut.removed.length === 2);
check("R6: readRoleName is the single gate for role names — it refuses the reserved word, not ordinary ones", rotReadRoleName("*").error !== undefined && rotReadRoleName("reviewer").value === "reviewer");

// --- M3 review riders: R5 (fan-out isolation) and R6 (reserved word) --------

const rotR5Env = fanEnv({ pairs: [pairSelf("session-worker-a"), pairSelf("session-worker-b")] });
rotR5Env.agentFor("session-worker-b").status = "running";
rotR5Env.agentFor("session-worker-b").steer = () => { throw new Error("steer exploded: R5"); };
const rotR5Out = await rotR5Env.send.execute({ targets: ["session-worker-a", "session-worker-b"], message: "R5" }, execFor(rotR5Env.senderAgent));
check("R5: a throwing target becomes its own refused row instead of killing the whole fan-out", rotR5Out.includes("- session-worker-b → refused：发送失败：投递到该目标时异常（steer exploded: R5），其余目标不受影响。"));
check("R5: the other targets keep their deliveries and the summary line is still produced", rotR5Out.includes("- session-worker-a → delivered") && rotR5Env.calls("session-worker-a").followedup.length === 1 && rotR5Out.includes("汇总：1 投递 / 1 拒绝。"));

const rotStarEnv = teamEnv({ teams: [teamRow({ writer: "any", current: "session-self" })] });
const rotStarOut = await rotStarEnv.tool("team_link_roster").execute({ action: "set-role", team: "night-shift", role: "*", session: "session-target" }, execFor(rotStarEnv.senderAgent));
check("R6: set-role refuses the addressing grammar's reserved word and creates no such role", rotStarOut.includes("寻址文法保留字") && rotStarEnv.store()[0].roles.every((entry) => entry.role !== "*"));

// --- M4 代码评审修复 #1/#2/#3/#5/#7 ----------------------------------------

// #1: the settled signal is `current === pending.session`, empty marker included.
// A rotation with no in-domain candidate migrates nothing, so its migratedPairs
// marker stays empty; a crash between the settlement and the pending clear then
// leaves exactly this state, and the replay must not run the migration path again
// (there the retiree reads as the successor itself, which would revoke the
// successor's own pairs and re-grant them provisionally, unattended).

const rotEmptyReplayEnv = rotateEnv({ pairs: [{ a: SUCCESSOR, b: "session-worker-a", createdAt: 5 }] });
rotEmptyReplayEnv.role().current = SUCCESSOR;
rotEmptyReplayEnv.role().pending = { session: SUCCESSOR, token: "empty-marker-token", team: "night-shift", role: "coordinator", expiresAt: Date.now() + 600000, createdAt: Date.now(), migratedPairs: [] };
const rotEmptyReplayOut = await rotEmptyReplayEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: "empty-marker-token" }, rotEmptyReplayEnv.exec(SUCCESSOR));
check("评审 #1: an empty migratedPairs marker next to current=successor replays instead of migrating", rotEmptyReplayOut.includes("claim 重放") && rotEmptyReplayOut.includes("不重复迁移") && !rotEmptyReplayOut.includes("对称撤销"));
check("评审 #1: ... the successor's own pairs survive the replay byte-for-byte", pairSummary(rotEmptyReplayEnv) === "session-new↔session-worker-a" && rotEmptyReplayEnv.ns.data.pairs.length === 1);
check("评审 #1: ... and the replay still finishes the bookkeeping and re-emits rotation-done", rotEmptyReplayEnv.role().pending === null && rotEmptyReplayEnv.calls("session-worker-a").followedup.at(-1).content[0].text.includes("[rotation-done]"));
// #4: the replay is the step that finishes the bookkeeping, so it must rewrite the
// mirror — otherwise roster.md keeps showing a pending the settings no longer have.
const rotReplayMirrorEnv = rotateEnv({ pairs: [{ a: SUCCESSOR, b: "session-worker-a", createdAt: 5 }] });
rotReplayMirrorEnv.role().current = SUCCESSOR;
rotReplayMirrorEnv.role().pending = { session: SUCCESSOR, token: "mirror-replay-token", team: "night-shift", role: "coordinator", expiresAt: Date.now() + 600000, createdAt: Date.now(), migratedPairs: [] };
await rotReplayMirrorEnv.roster.execute({ action: "upsert-team", team: "night-shift" }, rotReplayMirrorEnv.exec(SUCCESSOR));
const rotReplayMirrorBefore = await readFile(mirrorFile, "utf8");
check("评审 #4 前置: the mirror truthfully renders the leftover pending (masked) before the replay", rotReplayMirrorBefore.includes("tok-mirr…oken") && rotReplayMirrorBefore.includes("已迁移 0 条"));
await rotReplayMirrorEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: "mirror-replay-token" }, rotReplayMirrorEnv.exec(SUCCESSOR));
const rotReplayMirrorAfter = await readFile(mirrorFile, "utf8");
check("评审 #4: the replay rewrites the mirror — the leftover pending leaves no line behind", !rotReplayMirrorAfter.includes("tok-") && /### coordinator[\s\S]*?- pending：（无）/u.test(rotReplayMirrorAfter));

// #1 (sweep half): the same state at expiry is bookkeeping, not an unclaimed token.
const rotSettledSweepEnv = rotateEnv();
rotSettledSweepEnv.role().current = SUCCESSOR;
rotSettledSweepEnv.role().pending = { session: SUCCESSOR, token: "settled-sweep-token", team: "night-shift", role: "coordinator", expiresAt: Date.now() - 1000, createdAt: Date.now() - 31 * 60000, migratedPairs: [] };
const rotSettledSweep = await rotSettledSweepEnv.rotation.sweep({ now: Date.now() });
check("评审 #1: the sweep reads a settled roster (empty marker included) as settled — pending goes silently, no rotation-cancelled", rotSettledSweep.cancelled.length === 0 && rotSettledSweep.lines.length === 0 && rotSettledSweepEnv.role().pending === null && rotSettledSweepEnv.calls("session-worker-a").followedup.length === 0);

const rotSettledExpiredEnv = rotateEnv({ pairs: [{ a: SUCCESSOR, b: "session-worker-a", createdAt: 5 }] });
rotSettledExpiredEnv.role().current = SUCCESSOR;
rotSettledExpiredEnv.role().pending = { session: SUCCESSOR, token: "settled-expired-token", team: "night-shift", role: "coordinator", expiresAt: Date.now() - 1000, createdAt: Date.now() - 31 * 60000, migratedPairs: [] };
const rotSettledExpiredOut = await rotSettledExpiredEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: "settled-expired-token" }, rotSettledExpiredEnv.exec(SUCCESSOR));
check("评审 #1: an expired token on a settled roster refuses with the truth — no false '旧任仍为 current', no cancelled broadcast, pending cleared", rotSettledExpiredOut.includes("已经落定") && rotSettledExpiredOut.includes("静默清除 pending") && !rotSettledExpiredOut.includes("仍为 current") && rotSettledExpiredEnv.calls("session-worker-a").followedup.length === 0 && rotSettledExpiredEnv.role().pending === null);

// #2: 补批准 (settings UI flips the pair's provisional flag) keeps the role window
// open, so the window expires with nothing to roll back. Recording "provisional
// 未批准过期" and broadcasting "迁移的 pairs 已删除" would both be false statements.
const rotRatifiedEnv = rotateEnv({ omitUserQuestions: true, pairs: [rotPair("session-worker-a"), rotPair("session-worker-b")] });
const rotRatifiedToken = tokenOf(await rotRatifiedEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(rotRatifiedEnv.senderAgent)));
const rotRatifiedAt = Date.now();
await rotRatifiedEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: rotRatifiedToken }, rotRatifiedEnv.exec(SUCCESSOR));
for (const pair of rotRatifiedEnv.ns.data.pairs) pair.provisional = false;
check("评审 #2 前置: 补批准 flips the pairs only — the role window is still open", rotRatifiedEnv.role().provisional !== null && rotRatifiedEnv.ns.data.pairs.every((pair) => pair.provisional === false));
const rotRatifiedSweep = await rotRatifiedEnv.rotation.sweep({ now: rotRatifiedAt + 24 * 3600000 + 60000 });
check("评审 #2: a ratified window closes silently — no rotation-expired, no '未批准过期' history entry", rotRatifiedSweep.expired.length === 0 && rotRatifiedSweep.closed.length === 1 && rotRatifiedEnv.role().provisional === null && rotRatifiedEnv.role().history.every((record) => record.note !== "provisional 未批准过期") && rotRatifiedEnv.calls("session-worker-a").followedup.every((message) => !message.content[0].text.includes("[rotation-expired]")));
check("评审 #2: ... the ratified channels are kept and the sweep says why it closed the window", rotRatifiedEnv.ns.data.pairs.length === 2 && pairSummary(rotRatifiedEnv) === "session-new↔session-worker-a session-new↔session-worker-b" && rotRatifiedSweep.lines.join("\n").includes("provisional 窗口静默关闭"));

// #3: an internal notice never waits on a receiver dialog — prepare/claim included.
const rotAskNoticeEnv = rotateEnv({ receiveMode: "ask" });
const rotAskNoticePrep = await rotAskNoticeEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(rotAskNoticeEnv.senderAgent));
check("评审 #3: an ask-mode member receives the internal freeze as a skipped row — no dialog, no wait", rotAskNoticeEnv.uq.requests.length === 0 && rotAskNoticeEnv.calls("session-worker-a").followedup.length === 0 && rotAskNoticeEnv.calls("session-worker-b").followedup.length === 0 && rotAskNoticePrep.includes("rotation-freeze"));
check("评审 #3: the skipped row is recorded per target and names the two ways to receive it later", (rotAskNoticePrep.match(/→ refused：未投递：目标会话的接收策略为逐条确认（ask），而插件内部通知/gu) ?? []).length === 2 && rotAskNoticePrep.includes("不弹确认框"));
const rotAskNoticeClaim = await rotAskNoticeEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: tokenOf(rotAskNoticePrep) }, rotAskNoticeEnv.exec(SUCCESSOR));
check("评审 #3: the claim's own rotation-done notice takes the same non-blocking path", rotAskNoticeEnv.uq.requests.length === 0 && rotAskNoticeClaim.includes("通知广播（rotation-done，新任为发送方）：0 投递"));

// #5: nothing to migrate means nobody was asked — the verdict word must not say
// "已批准" (and must not claim a rollback window that was never opened).
const rotNoneEnv = rotateEnv();
const rotNonePrep = await rotNoneEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(rotNoneEnv.senderAgent));
const rotNoneClaim = await rotNoneEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: tokenOf(rotNonePrep) }, rotNoneEnv.exec(SUCCESSOR));
check("评审 #5: a rotation with no in-domain candidate opens no dialog and claims no approval", rotNoneEnv.uq.requests.length === 0 && rotNoneClaim.includes("无域内待迁移对：未弹确认框") && !rotNoneClaim.includes("已获在场确认") && rotNoneClaim.includes("回退窗口：本次换届没有新建任何通道"));
check("评审 #5: ... the done notice carries the same verdict word instead of 已批准", rotNoneEnv.calls("session-worker-a").followedup.at(-1).content[0].text.includes("信任迁移状态：无待迁移对") && !rotNoneEnv.calls("session-worker-a").followedup.at(-1).content[0].text.includes("24h 内未获批准将自动回退"));
check("评审 #5: ... and the roster opened no provisional window", rotNoneEnv.role().provisional === null && rotNoneEnv.role().current === SUCCESSOR && rotNoneEnv.role().pending === null);

// #7: team_read is a third lazy trigger, so a frozen team that only reads the
// board still gets its notice (the patrol timer only exists per registration).
const rotReadSweepEnv = rotateEnv({ pairs: [rotPair("session-worker-a")] });
rotReadSweepEnv.role().pending = { session: SUCCESSOR, token: "read-sweep-token", team: "night-shift", role: "coordinator", expiresAt: Date.now() - 1000, createdAt: Date.now() - 31 * 60000, migratedPairs: [] };
const rotReadSweepOut = await rotReadSweepEnv.tool("team_link_team_read").execute({ team: "night-shift" }, execFor(rotReadSweepEnv.senderAgent));
check("评审 #7: team_read triggers the expiry sweep — the stranded pending is cleared and rotation-cancelled is broadcast", rotReadSweepEnv.role().pending === null && rotReadSweepEnv.calls("session-worker-a").followedup.some((message) => message.content[0].text.includes("[rotation-cancelled]")));
check("评审 #7: ... and the read itself still returns the board (the sweep is not a substitute for it)", rotReadSweepOut.includes("黑板（根：") && rotReadSweepOut.includes("roster（概要"));

// --- M4 代码评审 round 2 修复 #8/#9/#10 (§3.6.2) ---------------------------

// #8 (投递侧守门): a rotation-granted pair stops being a pair at its 24h deadline,
// not only when the next sweep happens to delete the row. Treated as a pair, the
// expired channel would keep bypassing BOTH approval gates — the "24h 自动回退"
// promise silently false for exactly the window between deadline and sweep.

const ROT_PAIR_NOW = 1_700_000_000_000;
check("评审 #8: pairRecordBetween reads a past-deadline provisional record as NO pair (boundary included), and a session re-paired afterwards is not shadowed by the dead row", (() => {
	const dead = { a: "s1", b: "s2", createdAt: 1, provisional: true, expiresAt: ROT_PAIR_NOW - 1 };
	const atDeadline = { ...dead, expiresAt: ROT_PAIR_NOW };
	const live = { a: "s1", b: "s2", createdAt: 2, provisional: false, expiresAt: 0 };
	return __testing.pairRecordBetween({ pairs: [dead] }, "s1", "s2", ROT_PAIR_NOW) === null
		&& __testing.pairRecordBetween({ pairs: [atDeadline] }, "s1", "s2", ROT_PAIR_NOW) === null
		&& __testing.pairRecordBetween({ pairs: [dead] }, "s2", "s1", ROT_PAIR_NOW) === null
		&& __testing.pairRecordBetween({ pairs: [dead, live] }, "s1", "s2", ROT_PAIR_NOW) === live
		&& __testing.pairRecordBetween({ pairs: [{ ...dead, expiresAt: ROT_PAIR_NOW + 1 }] }, "s1", "s2", ROT_PAIR_NOW) !== null;
})());

const rotExpiredPairEnv = rotateEnv({
	pairs: [{ a: SUCCESSOR, b: "session-worker-a", createdAt: 5, provisional: true, expiresAt: Date.now() - 1000 }],
	receiveMode: "reject",
	rememberTargets: ["session-worker-a"],
});
const rotExpiredPairSend = await rotExpiredPairEnv.send.execute({ targetSessionId: "session-worker-a", message: "窗口已过" }, rotExpiredPairEnv.exec(SUCCESSOR));
check("评审 #8: a delivery over an expired provisional pair walks the ordinary gates again — the receiver's reject policy bites", rotExpiredPairSend.includes("接收策略为全部拒绝") && !rotExpiredPairSend.includes("provisional 通道") && rotExpiredPairEnv.calls("session-worker-a").followedup.length === 0);

const rotDemotedPairEnv = rotateEnv({
	pairs: [{ a: SUCCESSOR, b: "session-worker-a", createdAt: 5, provisional: true, expiresAt: Date.now() - 1000 }],
	askScript: ["发送"],
});
const rotDemotedPairSend = await rotDemotedPairEnv.send.execute({ targetSessionId: "session-worker-a", message: "退回过门" }, rotDemotedPairEnv.exec(SUCCESSOR));
check("评审 #8: ... and the sender-side gate is walked too — the confirmation dialog is raised, and the delivery is a plain (non-paired) one", rotDemotedPairEnv.uq.requests.length === 1 && rotDemotedPairSend.includes("已投递到") && !rotDemotedPairSend.includes("已配对通道") && !rotDemotedPairSend.includes("provisional 通道"));

const rotLivePairEnv = rotateEnv({
	pairs: [{ a: SUCCESSOR, b: "session-worker-a", createdAt: 5, provisional: true, expiresAt: Date.now() + 3600000 }],
	receiveMode: "reject",
	rememberTargets: ["session-worker-a"],
});
const rotLivePairSend = await rotLivePairEnv.send.execute({ targetSessionId: "session-worker-a", message: "窗口内" }, rotLivePairEnv.exec(SUCCESSOR));
check("评审 #8 对照: a provisional pair still INSIDE its window keeps the fast path — the guard is the deadline, not the provisional flag", rotLivePairSend.includes("provisional 通道，24h 内未批准自动回退") && rotLivePairEnv.calls("session-worker-a").followedup.length === 1);

// #8 (清扫侧): the user can hand-delete the role's provisional window (or the whole
// role/team row) in the settings UI and keep the pairs it granted. The doomed-pair
// deletion must not sit behind the "did any role need bookkeeping?" guard.
const rotOrphanSweepEnv = rotateEnv({ pairs: [{ a: SUCCESSOR, b: "session-worker-a", createdAt: 5, provisional: true, expiresAt: Date.now() - 1000 }] });
check("评审 #8 前置: the role carries no provisional window and no pending — the window was hand-deleted, the channel was not", (rotOrphanSweepEnv.role().provisional ?? null) === null && rotOrphanSweepEnv.role().pending === null && rotOrphanSweepEnv.ns.data.pairs.length === 1);
const rotOrphanSweep = await rotOrphanSweepEnv.rotation.sweep({ now: Date.now() });
check("评审 #8: the sweep deletes the expired provisional pairs anyway — the rollback needs no role bookkeeping", rotOrphanSweep.cancelled.length === 0 && rotOrphanSweep.expired.length === 0 && rotOrphanSweep.closed.length === 0 && rotOrphanSweep.lines.length === 0 && rotOrphanSweepEnv.ns.data.pairs.length === 0);

const rotOrphanTeamEnv = rotateEnv({ pairs: [{ a: SUCCESSOR, b: "session-worker-b", createdAt: 5, provisional: true, expiresAt: Date.now() - 1000 }] });
rotOrphanTeamEnv.ns.data.teams = [];
const rotOrphanTeamSweep = await rotOrphanTeamEnv.rotation.sweep({ now: Date.now() });
check("评审 #8: ... and the same holds when the whole role/team row is gone from the registry", rotOrphanTeamSweep.lines.length === 0 && rotOrphanTeamEnv.ns.data.pairs.length === 0);

const rotOrphanKeepEnv = rotateEnv({ pairs: [{ a: SUCCESSOR, b: "session-worker-a", createdAt: 5, provisional: true, expiresAt: Date.now() + 3600000 }] });
const rotOrphanKeepSweep = await rotOrphanKeepEnv.rotation.sweep({ now: Date.now() });
check("评审 #8 对照: a provisional pair still inside its window is not deleted early (the sweep is not a blanket purge)", rotOrphanKeepSweep.lines.length === 0 && rotOrphanKeepEnv.ns.data.pairs.length === 1);

// #9: applySetRole must invalidate an in-flight token when it seats the very
// session that token prepared. Left alive, the successor's own claim reads
// `current === pending.session` as "the previous claim already settled" and
// replays: it reports the hand-over as landed while the symmetric revocation never
// ran — the retiree keeps a 免门 channel alive, and the design's "成功即作废" is
// bypassed for exactly the case it was written for.

const rotSetRoleFixture = {
	name: "night-shift", createdAt: 1, workspace: "", policy: { writer: "coordinator" }, rotationBackup: null,
	roles: [{ role: "coordinator", current: "s1", pending: { session: "s2", token: "t", team: "night-shift", role: "coordinator", expiresAt: 9, createdAt: 1 }, rotationAt: 0, provisional: null, rotationStatus: "", history: [] }],
};
check("评审 #9: seating the pending's successor clears the token; seating anyone else keeps it", (() => {
	const cleared = __testing.applySetRole(rotSetRoleFixture, { role: "coordinator", session: "s2", now: 5 });
	const kept = __testing.applySetRole(rotSetRoleFixture, { role: "coordinator", session: "s3", now: 5 });
	return cleared.clearedPending === true && cleared.team.roles[0].pending === null && cleared.team.roles[0].current === "s2"
		&& kept.clearedPending === false && kept.team.roles[0].pending !== null && kept.team.roles[0].pending.token === "t" && kept.team.roles[0].current === "s3";
})());

const rotSuccessionEnv = rotateEnv({ pairs: [rotPair("session-worker-a"), rotPair("session-worker-b")] });
const rotSuccessionToken = tokenOf(await rotSuccessionEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(rotSuccessionEnv.senderAgent)));
check("评审 #9 前置: prepare left a pending bound to the successor", rotSuccessionEnv.role().pending.session === SUCCESSOR && rotSuccessionEnv.role().current === ROT_SELF);
const rotSuccessionSet = await rotSuccessionEnv.roster.execute({ action: "set-role", team: "night-shift", role: "coordinator", session: SUCCESSOR }, execFor(rotSuccessionEnv.senderAgent));
check("评审 #9: the set-role clears the token and says so (the successor is now the incumbent by an explicit writer action, not by a claim)", rotSuccessionEnv.role().pending === null && rotSuccessionEnv.role().current === SUCCESSOR && rotSuccessionSet.includes("已设置") && rotSuccessionSet.includes("已作废在飞令牌"));
const rotSuccessionClaim = await rotSuccessionEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: rotSuccessionToken }, rotSuccessionEnv.exec(SUCCESSOR));
check("评审 #9: the token is then refused as 「没有 pending」 instead of being replayed as an already-settled rotation", rotSuccessionClaim.includes("没有 pending") && !rotSuccessionClaim.includes("claim 重放"));
check("评审 #9: ... so no symmetric revocation was silently skipped — the retiree's pairs are untouched and the only notice is the prepare's freeze", pairSummary(rotSuccessionEnv) === "session-self↔session-worker-a session-self↔session-worker-b" && rotSuccessionEnv.calls("session-worker-a").followedup.length === 1 && rotSuccessionEnv.calls("session-worker-a").followedup.every((message) => !message.content[0].text.includes("[rotation-done]")));

// #10: the replay reads the verdict word the claim recorded instead of re-deriving
// it. A dialog answered with every candidate unchecked is ratified (已批准) yet
// migrates no pair and opens no window — the old derivation replayed that same
// rotation as 无待迁移对.

const rotUncheckedEnv = rotateEnv({ askScript: [[]], pairs: [rotPair("session-worker-a")] });
const rotUncheckedToken = tokenOf(await rotUncheckedEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(rotUncheckedEnv.senderAgent)));
const rotUncheckedClaim = await rotUncheckedEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: rotUncheckedToken }, rotUncheckedEnv.exec(SUCCESSOR));
check("评审 #10 前置: the dialog was answered with nothing checked — ratified, no pair migrated, no window opened", rotUncheckedClaim.includes("已获在场确认") && rotUncheckedClaim.includes("勾选 0 / 候选 1 条") && rotUncheckedEnv.role().provisional === null && rotUncheckedEnv.ns.data.pairs.filter((pair) => pair.a === SUCCESSOR || pair.b === SUCCESSOR).length === 0);
check("评审 #10: the claim records its verdict word on the role, in the same write as the settlement", rotUncheckedEnv.role().rotationStatus === "已批准");
check("评审 #10: the settled rotation's done notice carries 已批准", rotUncheckedEnv.calls("session-worker-a").followedup.at(-1).content[0].text.includes("信任迁移状态：已批准"));

// The crash window of §3.6.2: the settlement (with its marker, its recorded word
// and the settled roster) landed, the pending clear did not. The replay reads the
// recorded word back.
rotUncheckedEnv.role().pending = { session: SUCCESSOR, token: rotUncheckedToken, team: "night-shift", role: "coordinator", expiresAt: Date.now() + 600000, createdAt: Date.now(), migratedPairs: [] };
const rotUncheckedReplay = await rotUncheckedEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: rotUncheckedToken }, rotUncheckedEnv.exec(SUCCESSOR));
check("评审 #10: the replay of that rotation re-emits the SAME word — it does not degrade to 无待迁移对", rotUncheckedReplay.includes("claim 重放") && rotUncheckedEnv.calls("session-worker-a").followedup.at(-1).content[0].text.includes("信任迁移状态：已批准") && !rotUncheckedEnv.calls("session-worker-a").followedup.at(-1).content[0].text.includes("无待迁移对"));

// fallback 对照: a settings row written before the field existed carries no word,
// and the replay still works through the derivation (the same end-to-end path the
// existing #1 replay cases take).
const rotLegacyStatusEnv = rotateEnv({ pairs: [{ a: SUCCESSOR, b: "session-worker-a", createdAt: 5 }] });
rotLegacyStatusEnv.role().current = SUCCESSOR;
rotLegacyStatusEnv.role().pending = { session: SUCCESSOR, token: "legacy-status-token", team: "night-shift", role: "coordinator", expiresAt: Date.now() + 600000, createdAt: Date.now(), migratedPairs: [{ a: SUCCESSOR, b: "session-worker-a", createdAt: 5, provisional: false, expiresAt: 0 }] };
await rotLegacyStatusEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: "legacy-status-token" }, rotLegacyStatusEnv.exec(SUCCESSOR));
check("评审 #10 fallback 对照: a role row without the recorded word (pre-field settings row) still replays through the derivation", rotLegacyStatusEnv.role().rotationStatus === "" && rotLegacyStatusEnv.calls("session-worker-a").followedup.at(-1).content[0].text.includes("信任迁移状态：已批准"));
check("评审 #10: rotationStatus is a declared role field — a settings round-trip keeps the word instead of stripping it", (() => {
	const roundTrip = __testing.normalizeTeams([{ name: "night-shift", roles: [{ role: "coordinator", current: "s1", pending: null, rotationAt: 0, provisional: null, rotationStatus: "无待迁移对", history: [] }] }]);
	const withoutWord = __testing.normalizeTeams([{ name: "night-shift", roles: [{ role: "coordinator", current: "s1", pending: null, rotationAt: 0, provisional: null, history: [] }] }]);
	return roundTrip[0].roles[0].rotationStatus === "无待迁移对" && withoutWord[0].roles[0].rotationStatus === "";
})());

// --- §5.3 红线: the plugin never re-arms a goal itself ----------------------

const rotGoalEnv = rotateEnv({ goals: { [SUCCESSOR]: { phase: "active", activation: "disarmed", roundsStarted: 3, maxGoalRounds: 70 } }, pairs: [rotPair("session-worker-a")], askScript: [["session-worker-a"]] });
let rotResumeCalls = 0;
rotGoalEnv.ctx.get("goals").resume = () => { rotResumeCalls += 1; };
const rotGoalPrep = await rotGoalEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(rotGoalEnv.senderAgent));
const rotGoalClaim = await rotGoalEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: tokenOf(rotGoalPrep) }, rotGoalEnv.exec(SUCCESSOR));
check("M4 红线: a whole rotation never calls goals.resume — the successor is only ADVISED (§3.7 合规回路)", rotResumeCalls === 0 && rotGoalClaim.includes("换届完成") && rotGoalPrep.includes("/goal resume"));

// ---------------------------------------------------------------------------
// §9 收尾修复（0.3.7）: U9 settings 时序锁 / U10 创建即认领 / U11 降级红线
// ---------------------------------------------------------------------------

// --- U9: the settings seam is a TIMING contract, not a snapshot (§9.1.3) -----
// Every environment above provides `settings` BEFORE `apply()`, so all of them
// can only ever exercise the fast path. Production does the opposite — the
// settings provider finishes its `[Service.init]` (load settings.yaml, then
// publish) after this plugin activates — and the pre-fix store read
// `ctx.get("settings")` exactly once, at apply time, then fell back to process
// memory silently and permanently (teams / watchdogs / pairs never reached
// disk). This case reproduces the production ORDER: apply first, provider later.
// The provider side is a real cordis Context, so `provide` after the fact is
// what fires the plugin's `ctx.inject(["settings"], …)` callback — the stub is
// not allowed to shortcut that (§9.1.4).

const lateEnv = setup({
	sessions: [],
	lateSettings: true,
	selfCwd: TEAM_WS,
	// Pre-loaded into the legacy namespace by the stub's own register (the state a
	// provider would have read from settings.yaml), so the one-time rename
	// migration — which now runs from `attach` — has something to migrate. That
	// is the evidence that the call site really moved off apply time.
	settingsSeed: { "session-link-pro": { receiveMode: "accept", trustedSenders: ["session-legacy"] } },
});
check("U9 前置: at activation the provider is not active yet — nothing registered, exactly one warn and no info line", lateEnv.settings.namespaces.size === 0 && lateEnv.log.lines.warn.length === 1 && lateEnv.log.lines.warn[0].includes("settings not active at activation") && lateEnv.log.lines.info.length === 0);
await lateEnv.provideSettings();
check("U9: the store attaches once the provider goes active and says so in exactly one info line", lateEnv.settings.namespaces.has("team-link") && lateEnv.log.lines.info.filter((line) => line.includes('policy store attached to settings namespace "team-link"')).length === 1);
check("U9: the one-time legacy migration runs from the attach, not from apply (session-link-pro → team-link)", lateEnv.settings.namespaces.get("team-link")?.data.receiveMode === "accept" && (lateEnv.settings.namespaces.get("team-link")?.data.trustedSenders ?? []).join(",") === "session-legacy");
const lateRoster = lateEnv.tool("team_link_roster");
const lateCreateOut = await lateRoster.execute({ action: "upsert-team", team: "night-shift" }, execFor(lateEnv.senderAgent));
check("U9: a write after the late attach lands in the settings namespace — persistence, not process memory", (lateEnv.settings.namespaces.get("team-link")?.data.teams ?? []).length === 1 && lateEnv.settings.namespaces.get("team-link")?.data.teams[0].name === "night-shift" && lateCreateOut.includes("已创建团队 night-shift"));
check("U9: the lazy retries stay silent — still exactly one warn for the whole startup window", lateEnv.log.lines.warn.length === 1);

// The same race, second site (§9.1.3 第三处): the export route is taken from the
// runtime channel too, so it must be mounted on a late webServer instead of being
// lost to one apply-time snapshot.
const lateWsEnv = setup({ sessions: [], lateWebServer: true });
check("U9 对照 (webServer): with no active webServer the route is not mounted, and the degradation is announced instead of silent", lateWsEnv.routes.length === 0 && lateWsEnv.log.lines.warn.some((line) => line.includes("webServer service unavailable at activation")));
await lateWsEnv.provideWebServer();
check("U9 对照 (webServer): the same late-attach pattern mounts the export route once the provider appears", lateWsEnv.routes.length === 1 && lateWsEnv.routes[0].kind === "exact" && lateWsEnv.routes[0].path === "/team-link/export");

// Data consistency across the same window (§9.1.3 数据一致性, defensive redundancy):
// the memory engine can only be written before the attach. If that happens, the
// write must be folded into settings rather than silently dropped.
const memWindowEnv = setup({ sessions: [], lateSettings: true, selfCwd: TEAM_WS });
const memWindowOut = await memWindowEnv.tool("team_link_roster").execute({ action: "upsert-team", team: "night-shift" }, execFor(memWindowEnv.senderAgent));
check("U9 对照 (数据一致性): a write inside the startup window is served by the memory engine (no settings namespace exists yet)", memWindowOut.includes("已创建团队 night-shift") && memWindowEnv.settings.namespaces.size === 0);
await memWindowEnv.provideSettings();
check("U9 对照 (数据一致性): the window's write is folded into the settings namespace at attach instead of being dropped, with one line saying so", (memWindowEnv.settings.namespaces.get("team-link")?.data.teams ?? []).length === 1 && memWindowEnv.log.lines.warn.some((line) => line.includes("memory-only startup window")) && memWindowEnv.log.lines.info.filter((line) => line.includes("policy store attached")).length === 1);

// --- U10 (§3.3.2 创建即认领 / §9.2.2): bootstrap, no hijack, gates untouched ---
const u10Env = teamEnv({ teams: [] });
const u10Roster = u10Env.tool("team_link_roster");
const u10Create = await u10Roster.execute({ action: "upsert-team", team: "night-shift" }, execFor(u10Env.senderAgent));
check("U10: the creation path seeds the creating session as coordinator.current, in the same write", u10Create.includes("coordinator 已由创建会话 session-self 认领") && teamStore(u10Env)[0].roles.length === 1 && teamStore(u10Env)[0].roles[0].current === "session-self");
const u10ForeignUpsert = await u10Roster.execute({ action: "upsert-team", team: "night-shift" }, execFor(u10Env.targetAgent));
check("U10: a non-incumbent cannot hijack an existing team through upsert-team — the seed never runs twice and the gate still refuses", u10ForeignUpsert.includes("只有现任协调者会话 session-self 可写") && teamStore(u10Env)[0].roles.length === 1 && teamStore(u10Env)[0].roles[0].current === "session-self");
const u10SetRole = await u10Roster.execute({ action: "set-role", team: "night-shift", role: "coordinator", session: "session-target", note: "夜班接手" }, execFor(u10Env.senderAgent));
check("U10: the creating session can write immediately — set-role goes through (the bootstrap really unlocks M2–M4)", u10SetRole.includes("已设置") && teamStore(u10Env)[0].roles[0].current === "session-target");
const u10RolesAfterHandover = JSON.stringify(teamStore(u10Env)[0].roles);
const u10Idempotent = await u10Roster.execute({ action: "upsert-team", team: "night-shift" }, execFor(u10Env.targetAgent));
check("U10: upsert-team on an existing team is still idempotent — roles/version history byte-identical, no re-seed for the new incumbent", u10Idempotent.includes("已存在") && u10Idempotent.includes("幂等") && JSON.stringify(teamStore(u10Env)[0].roles) === u10RolesAfterHandover);
const u10ExtraArg = await rejects(u10Roster, { action: "upsert-team", team: "day-shift", coordinator: "session-target" }, execFor(u10Env.senderAgent));
check("U10: the tool surface has no `coordinator` parameter (§9.2.2 不新增 API 面), and an undeclared id cannot seed the role — the seed is always the calling session", Object.keys(u10Roster.parameters.properties).sort().join(",") === "action,note,role,session,team" && teamStore(u10Env).find((team) => team.name === "day-shift")?.roles[0].current === "session-self" && !String(u10ExtraArg).includes("session-target"));
check("U10: a HAND-WRITTEN vacant row (settings UI) still answers 「空缺 → 设置 UI」 for set-role and for upsert-team — writerGate is untouched", vacantSetRole.includes("当前空缺") && vacantSetRole.includes("设置 UI") && vacantUpsert.includes("当前空缺"));
const u10VacantRetire = await vacantRoster.execute({ action: "retire", team: "night-shift", role: "coordinator" }, execFor(vacantEnv.senderAgent));
check("U10: ... and retire on that vacant row is refused the same way — retireGate is untouched", u10VacantRetire.includes("当前空缺") && u10VacantRetire.includes("设置 UI"));

// --- U11 (§5.3 红线): no settings at all ⇒ full function, exactly one line ----
const bareEnv = setup({ sessions: [{ header: { id: "session-lv-silent", createdAt: 1000, cwd: TEAM_WS }, live: true, persisted: true }], eventsBySession: { "session-lv-silent": ancientEvents("silent") }, extraAgents: [{ id: "session-lv-silent", status: "idle" }], selfCwd: TEAM_WS });
check("U11: with no settings service the whole tool surface still registers", ["team_link_list_sessions", "team_link_export", "team_link_send", "team_link_watch", "team_link_roster", "team_link_team_read", "team_link_team_append", "team_link_rotate"].every((toolName) => bareEnv.tool(toolName) !== undefined));
check("U11: 有且仅有一行 warn for the activation window — no info line, no silent fallback", bareEnv.log.lines.warn.length === 1 && bareEnv.log.lines.warn[0].includes("settings not active at activation") && bareEnv.log.lines.info.length === 0);
const bareRoster = bareEnv.tool("team_link_roster");
const bareCreate = await bareRoster.execute({ action: "upsert-team", team: "day-shift" }, execFor(bareEnv.senderAgent));
const bareSetRole = await bareRoster.execute({ action: "set-role", team: "day-shift", role: "coordinator", session: "session-target" }, execFor(bareEnv.senderAgent));
const bareAppend = await bareEnv.tool("team_link_team_append").execute({ team: "day-shift", file: "decisions", line: "内存引擎下的裁决" }, execFor(bareEnv.senderAgent));
const bareRead = await bareEnv.tool("team_link_team_read").execute({ team: "day-shift" }, execFor(bareEnv.senderAgent));
check("U11: M2 stays fully usable on the memory engine (create → set-role → 黑板 append → read back)", bareCreate.includes("已创建团队 day-shift") && bareSetRole.includes("已设置") && bareAppend.includes("已追加 decisions #1") && bareRead.includes("内存引擎下的裁决"));
check("U11: the lazy retries never add a line — still exactly one warn after a full M2 round trip", bareEnv.log.lines.warn.length === 1 && bareEnv.log.lines.info.length === 0);
const bareList = await bareEnv.tool("team_link_list_sessions").execute({}, execFor(bareEnv.senderAgent));
check("U11: the goals degradation is unchanged — a missing service renders goal=? and the list still works", bareList.includes("goal=?") && !bareList.includes("列出会话失败"));

// The documented second branch: a context without `ctx.inject` (§9.1.3 ②) says so
// in its own line, and the lazy retry is then the whole recovery path.
const lazyEnv = setup({ sessions: [], lateSettings: true, noInject: true, selfCwd: TEAM_WS });
check("U11: without ctx.inject the memory fallback is announced in a second, explicit line", lazyEnv.log.lines.warn.length === 2 && lazyEnv.log.lines.warn[1].includes("ctx.inject unavailable"));
await lazyEnv.provideSettings();
check("U11 前置: with nothing registered for injection the late provider is not picked up on its own", lazyEnv.settings.namespaces.size === 0);
const lazyOut = await lazyEnv.tool("team_link_roster").execute({ action: "upsert-team", team: "night-shift" }, execFor(lazyEnv.senderAgent));
check("U11: the first tool call retries lazily and attaches (§9.1.3 ③) — the write lands in settings and one info line is left", lazyOut.includes("已创建团队 night-shift") && (lazyEnv.settings.namespaces.get("team-link")?.data.teams ?? []).length === 1 && lazyEnv.log.lines.info.filter((line) => line.includes("policy store attached")).length === 1);
check("U11: ... and the retry did not repeat the activation warn (still exactly two lines: the window and the missing ctx.inject)", lazyEnv.log.lines.warn.length === 2);

// --- F1 (差异审计 · 唯一实质分歧): a provider that is ACTIVE but refuses ----
// `register` is the second arrival path of the same "not attached" warn. When
// the provider is already active, attachFrom() answers `"attached"` — or
// `"refused"` when the provider answered but `register` threw (评审 round-2
// 🔵 #2 turned its boolean into a reason code) — so the activation branch below
// never runs and — pre-fix — nothing latched a one-shot gate: each get()/update()
// re-entered the register catch and the warn had no upper bound (audit probe:
// 3 get + 1 upsert ⇒ 11 warns). §9.1.3 ③ puts both paths behind the same
// `attachWarned` gate, counted over the whole startup window (U11). The
// assertions below count only this plugin's settings lines, so the webServer
// warn of an unrelated branch cannot mask a missing gate.
const settingsWarnsOf = (lines) => lines.filter((line) => line.includes("dsh-team-link: settings "));

// This fixture is the audit's own shape: the provider IS active when the plugin
// activates (so the fast path reaches `attach` and the refusal is the first thing
// the store ever sees), while the assertions after it drive the lazy retries.
const refusingEnv = setup({ sessions: [], useSettings: true, settingsRegisterThrows: true, selfCwd: TEAM_WS });
check("F1 前置: the refusal is announced once when the active provider refuses register", settingsWarnsOf(refusingEnv.log.lines.warn).length === 1 && settingsWarnsOf(refusingEnv.log.lines.warn)[0].includes("settings register failed") && refusingEnv.log.lines.info.length === 0);
const refusingRoster = refusingEnv.tool("team_link_roster");
const refusingOut = await refusingRoster.execute({ action: "upsert-team", team: "night-shift" }, execFor(refusingEnv.senderAgent));
check("F1 前置: with no scope attached the store stays usable on the memory engine", refusingOut.includes("已创建团队 night-shift") && refusingEnv.settings.namespaces.size === 0);
check("F1: after three lazy get() retries and one update(), the whole startup window still carries exactly one settings warn — no warn storm", refusingOut.includes("已创建团队 night-shift") && settingsWarnsOf(refusingEnv.log.lines.warn).length === 1 && refusingEnv.log.lines.info.length === 0);

// The mirror image, so the gate is asserted on BOTH arrival paths: here the
// provider only becomes active after apply, so the activation branch writes the
// line first and the lazy retries must stay quiet behind the same gate.
const lateRefusingEnv = setup({ sessions: [], lateSettings: true, settingsRegisterThrows: true, selfCwd: TEAM_WS });
check("F1 对照: the activation warn is the only line before the provider goes active", settingsWarnsOf(lateRefusingEnv.log.lines.warn).length === 1 && lateRefusingEnv.log.lines.warn[0].includes("settings not active at activation"));
await lateRefusingEnv.provideSettings();
const lateRefusingRoster = lateRefusingEnv.tool("team_link_roster");
const lateRefusingOut = await lateRefusingRoster.execute({ action: "upsert-team", team: "night-shift" }, execFor(lateRefusingEnv.senderAgent));
check("F1 对照: the register failure that arrives second does NOT add a line — same gate, one line for the window", lateRefusingOut.includes("已创建团队 night-shift") && settingsWarnsOf(lateRefusingEnv.log.lines.warn).length === 1 && lateRefusingEnv.log.lines.info.length === 0);

// --- 评审 #4: an unavailable LEGACY namespace must not be swallowed ----------
// The pre-rename namespace is best-effort, but "best-effort" ≠ silent: if it
// cannot be registered, the pre-rename trust data will not be migrated, and that
// has to be visible. Only `session-link-pro` is refused here, so the current
// namespace still attaches normally.
const legacyEnv = setup({ sessions: [], useSettings: true, legacyRegisterThrows: true, selfCwd: TEAM_WS });
check("评审 #4: the current namespace still attaches while the legacy one is refused", legacyEnv.settings.namespaces.has("team-link") && !legacyEnv.settings.namespaces.has("session-link-pro") && legacyEnv.log.lines.info.filter((line) => line.includes("policy store attached")).length === 1);
check("评审 #4: ... and the unavailable legacy namespace leaves one line naming it and the skipped migration", legacyEnv.log.lines.warn.length === 1 && legacyEnv.log.lines.warn[0].includes(`legacy namespace "session-link-pro" unavailable`) && legacyEnv.log.lines.warn[0].includes("不会自动迁移"));

// --- 评审 round-2 🔵 #3: the attach-time chain is observable end to end -------
// `void adoptMemoryWindow().then(() => migrateLegacyPolicy()).catch(…)` used to
// be fire-and-forget with a silent catch, and `migrateLegacyPolicy`'s early read
// failure returned with no line at all — so neither "migrated" nor "skipped" nor
// "failed" could be read off the store. Each attach now names both steps in one
// info line, and the read failure that used to be swallowed leaves a warn.
// The chain deliberately stays fire-and-forget on the fast path, so the fixture
// installed synchronously above needs one yield before its line can be read.
await tick();
check("🔵 #3: the attach-time chain names both steps' outcomes in one info line (migrated path)", lateEnv.log.lines.info.some((line) => line.includes("post-attach policy chain finished") && line.includes("memory window: none (no writes while unattached)") && line.includes("legacy migration: migrated")));
check("🔵 #3: the skipped path is named, not left to inference — and 🔵 #5: a REFUSED legacy register now reads as refused instead of as 「没有旧命名空间」", legacyEnv.log.lines.info.some((line) => line.includes("post-attach policy chain finished") && line.includes("legacy migration: legacy namespace refused (register failed)")));
// The branch that had no line whatsoever: the legacy namespace registers but
// cannot be read. Pre-fix this fixture produced a completely silent skip.
const unreadableLegacyEnv = setup({ sessions: [], useSettings: true, legacyGetThrows: true, selfCwd: TEAM_WS });
await tick();
check("🔵 #3: a legacy namespace that cannot be READ leaves a warn naming the skipped migration (pre-fix: no line at all)", unreadableLegacyEnv.log.lines.warn.some((line) => line.includes(`legacy namespace "session-link-pro" could not be read`) && line.includes("本次未迁移")) && unreadableLegacyEnv.log.lines.info.some((line) => line.includes("legacy migration: legacy read failed")));

// --- 评审 round-2 🟡 #1: a disposed provider must not leave a dead scope ------
// §9.1.3 binds the settings scope to the fiber of the context that produced it —
// the rule the webServer site already follows (`target.effect(() => webServer
// .register(…))`). Without the binding, a late `ctx.inject(["settings"], …)`
// attach outlives its provider: `scope` stays non-null while dead, every
// `update()` throws into the caller's「写入设置失败」path and every `get()`
// silently answers from stale process memory — and no retry can ever re-attach,
// because the retry is gated on `scope === null`. The provider below is a real
// cordis plugin fiber (see `provideSettingsFiber`): it is retired by disposing
// that fiber, never by a hand-flipped flag.
const deadEnv = setup({ sessions: [], lateSettings: true, selfCwd: TEAM_WS });
check("🟡 #1 前置: the provider is late — activation leaves the one warn and nothing registered", deadEnv.log.lines.warn.length === 1 && deadEnv.settings.namespaces.size === 0);
const firstProvider = await deadEnv.provideSettingsFiber();
const deadRoster = deadEnv.tool("team_link_roster");
const beforeDispose = await deadRoster.execute({ action: "upsert-team", team: "night-shift" }, execFor(deadEnv.senderAgent));
check("🟡 #1 前置: with the provider up the store attaches on the late path and the write lands in its namespace", beforeDispose.includes("已创建团队 night-shift") && (deadEnv.settings.namespaces.get("team-link")?.data.teams ?? []).map((team) => team.name).join(",") === "night-shift" && deadEnv.log.lines.info.filter((line) => line.includes("policy store attached")).length === 1);

await firstProvider.dispose();
await tick();
check("🟡 #1: disposing the provider's fiber releases the scope — one line says the store is memory-only again", deadEnv.log.lines.info.some((line) => line.includes("settings scope released with its owner fiber") && line.includes("memory-only")));

const whileDetached = await deadRoster.execute({ action: "upsert-team", team: "detached-team" }, execFor(deadEnv.senderAgent));
check("🟡 #1: after the provider is gone the store is UNATTACHED rather than attached-to-a-dead-scope — the write is served by the memory engine instead of failing against the dead scope", whileDetached.includes("已创建团队 detached-team") && !whileDetached.includes("写入设置失败"));
check("🟡 #1: ... and nothing was written through the dead scope (its namespace still holds exactly the pre-disposal state)", (deadEnv.settings.namespaces.get("team-link")?.data.teams ?? []).map((team) => team.name).join(",") === "night-shift");

// The provider comes back as a restarted provider would: a FRESH service
// instance (a new stub), which is what makes "re-attached to the new provider"
// observable rather than merely "still holding the old one".
const revived = makeSettings({ "team-link": { teams: [teamRow({ name: "carried-team", writer: "any" })] } });
await deadEnv.provideSettingsFiber(revived);
check("🟡 #1: when the provider returns, the lazy path re-attaches — a second attach line, against the new provider", deadEnv.log.lines.info.filter((line) => line.includes('policy store attached to settings namespace "team-link"')).length === 2 && revived.namespaces.has("team-link"));
const revivedRead = await deadRoster.execute({ action: "get" }, execFor(deadEnv.senderAgent));
check("🟡 #1: reads now come from the new provider's namespace — stale process memory no longer masquerades as the store's state", revivedRead.includes("carried-team") && !revivedRead.includes("detached-team"));
const afterRevival = await deadRoster.execute({ action: "upsert-team", team: "after-team" }, execFor(deadEnv.senderAgent));
check("🟡 #1: ... and writes follow the live provider too (persistence is not pinned to the first scope)", afterRevival.includes("已创建团队 after-team") && (revived.namespaces.get("team-link")?.data.teams ?? []).map((team) => team.name).join(",") === "carried-team,after-team");
// Every attach states what happened to the memory-only window, including the
// case where it is deliberately NOT adopted — a window write that settings
// outranks is named, not dropped in silence (🔵 #3).
check("🔵 #3: every attach reports the window outcome — the un-adopted window write is named, not silently dropped", deadEnv.log.lines.info.filter((line) => line.includes("post-attach policy chain finished")).length === 2 && deadEnv.log.lines.info.some((line) => line.includes("memory window: not folded (settings namespace already in use)")));

// --- 评审 round-3 🟡 #1: the one-shot gate counts WINDOWS, not the process ----
// `detach()` ends an unattached window (its scopes died with their owner fiber),
// so the next window has to be able to speak for itself. Pre-fix the gate stayed
// latched for the process lifetime: a provider that came BACK and then REFUSED
// `register` produced no warn at all — the only trace was the release line's
// "memory-only until it attaches again", which cannot distinguish 仍在等 from
// 被拒绝 (silent refusal is the original ③ defect). The provider side is a real
// cordis plugin fiber, as in the 🟡 #1 case above: window 1 attaches against a
// working provider, that fiber is disposed, and window 2 is a provider that
// answers but refuses.
const windowGateEnv = setup({ sessions: [], lateSettings: true, selfCwd: TEAM_WS });
check("🟡 #1 前置: window 1 announces itself once (the activation line) and registers nothing", settingsWarnsOf(windowGateEnv.log.lines.warn).length === 1 && settingsWarnsOf(windowGateEnv.log.lines.warn)[0].includes("settings not active at activation") && windowGateEnv.settings.namespaces.size === 0);
const windowGateProvider1 = await windowGateEnv.provideSettingsFiber();
check("🟡 #1 前置: window 1 attaches against the provider that returns, still at one warn for that window", windowGateEnv.log.lines.info.filter((line) => line.includes('policy store attached to settings namespace "team-link"')).length === 1 && settingsWarnsOf(windowGateEnv.log.lines.warn).length === 1);
await windowGateProvider1.dispose();
await tick();
check("🟡 #1 前置: disposing that fiber ends window 1 — scopes released with one line, store unattached again", windowGateEnv.log.lines.info.some((line) => line.includes("settings scope released with its owner fiber")) && windowGateEnv.log.lines.info.filter((line) => line.includes("policy store attached")).length === 1);
await windowGateEnv.provideSettingsFiber(makeSettings({}, { settingsRegisterThrows: true }));
check("🟡 #1: window 2's refusal is announced — the gate re-opened together with the window (pre-fix: zero lines, a silently refused window)", settingsWarnsOf(windowGateEnv.log.lines.warn).length === 2 && settingsWarnsOf(windowGateEnv.log.lines.warn)[1].includes("settings register failed"));
const windowGateWrite = await windowGateEnv.tool("team_link_roster").execute({ action: "upsert-team", team: "second-window" }, execFor(windowGateEnv.senderAgent));
check("🟡 #1: ... and window 2 is still exactly ONE warn — the lazy retries behind the refusal add nothing (窗口内语义未变)", windowGateWrite.includes("已创建团队 second-window") && settingsWarnsOf(windowGateEnv.log.lines.warn).length === 2 && windowGateEnv.log.lines.info.filter((line) => line.includes("policy store attached")).length === 1);

// --- 评审 round-3 🔵 #3: the memory-window flag dies with its window ---------
// The flag exists to fold writes made before the attach. Pre-fix it was never
// cleared, so a SECOND, brand-new provider was fed the same (already resolved)
// memory state again — a second fold plus a second 「该窗口理论不可达」 warn: the
// flag's lifetime claimed a window that had already been resolved.
const refoldEnv = setup({ sessions: [], lateSettings: true, selfCwd: TEAM_WS });
await refoldEnv.tool("team_link_roster").execute({ action: "upsert-team", team: "window-one" }, execFor(refoldEnv.senderAgent));
const refoldFolds = () => refoldEnv.log.lines.warn.filter((line) => line.includes("memory-only startup window"));
const refoldProvider = await refoldEnv.provideSettingsFiber();
await tick();
check("🔵 #3 前置: window 1's memory write is folded into the namespace exactly once, with one warn and the matching chain token", (refoldEnv.settings.namespaces.get("team-link")?.data.teams ?? []).map((team) => team.name).join(",") === "window-one" && refoldFolds().length === 1 && refoldEnv.log.lines.info.some((line) => line.includes("memory window: folded into settings")));
await refoldProvider.dispose();
await tick();
// A brand-new provider whose namespace is empty — the shape that used to be
// re-fed the previous window's memory state.
const refoldFresh = makeSettings();
await refoldEnv.provideSettingsFiber(refoldFresh);
await tick();
check("🔵 #3: the flag does not outlive its window — the new provider is NOT re-fed the resolved state (no second fold, no second 「理论不可达」 warn)", refoldFresh.namespaces.has("team-link") && (refoldFresh.namespaces.get("team-link")?.data.teams ?? []).length === 0 && refoldFolds().length === 1 && (refoldEnv.log.lines.info.filter((line) => line.includes("post-attach policy chain finished")).at(-1) ?? "").includes("memory window: none (no writes while unattached)"));

// --- 评审 round-3 🔵 #5: 「旧命名空间被拒」≠「根本没有旧命名空间」 ---------
// The refused case is `legacyEnv` above (its chain line now names the refusal).
// This is the other half of the same value set: a legacy namespace that REGISTERS
// fine but holds nothing reads as "no legacy data" — the token the refused case
// used to collapse into.
const emptyLegacyEnv = setup({ sessions: [], useSettings: true, selfCwd: TEAM_WS });
await tick();
check("🔵 #5: a legacy namespace that registers but holds nothing reads as 「no legacy data」 — the skip tokens are distinct values, not one", emptyLegacyEnv.log.lines.info.some((line) => line.includes("post-attach policy chain finished") && line.includes("legacy migration: no legacy data")));

// --- 评审 round-3 🔵 #4: the webServer line's wording comes from the ONE read --
// Same reason-code shape as `attachFrom`: a service that IS there without
// `register()` is named as such, so no second `ctx.get("webServer")` is needed to
// pick the wording (a second read could observe a different moment and describe a
// state that was never true).
const registerlessWsEnv = setup({ sessions: [], webServerWithoutRegister: true });
const registerlessWarns = registerlessWsEnv.log.lines.warn.filter((line) => line.includes("webServer service unavailable at activation"));
check("🔵 #4: a webServer without register() is named by its reason code — 「no register()」, not 「not yet active」", registerlessWarns.length === 1 && registerlessWarns[0].includes("(no register())") && registerlessWsEnv.routes.length === 0);

// cleanup
rmSync(tmpDir, { recursive: true, force: true });
rmSync(escDir, { recursive: true, force: true });
rmSync(TEAM_TMP, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
// §9.6 ⑧: the run states its own assertion total, so the README figure (and any
// future changelog figure) is checkable against the run instead of remembered.
console.log(`assertion total: ${assertions} (failed: ${failures})`);
process.exit(failures === 0 ? 0 : 1);

/** Drive the agent/pre-step waterfall the way the loop does. */
async function ctx_waterfall(ctx, payload) {
	return ctx.waterfall({}, "agent/pre-step", payload, () => Promise.resolve({ kind: "enter", messages: [...payload.messages] }));
}
