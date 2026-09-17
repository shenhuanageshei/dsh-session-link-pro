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
function check(label, cond) {
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
 */
function makeSettings() {
	const namespaces = new Map();
	return {
		namespaces,
		service: {
			register(namespace, _schema, options = {}) {
				const state = { base: structuredClone(options.base ?? {}), data: {} };
				namespaces.set(String(namespace), state);
				return {
					get() { return { ...structuredClone(state.base), ...structuredClone(state.data) }; },
					async update(patch) { Object.assign(state.data, structuredClone(patch)); },
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
				return { answers: [{ id: request.questions[0].id, selected: [choice], custom: undefined }] };
			},
		},
		requests,
	};
}

function makeQuery(sessions, eventsBySession = {}) {
	return {
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
			const events = eventsBySession[id];
			if (events === undefined) throw new Error(`session not found: ${id}`);
			return { session: { id }, capturedThroughSeq: events.length, events };
		},
	};
}

/** Build a full plugin environment on a fresh cordis Context. */
function setup({ sessions = [], eventsBySession = {}, askScript = [], targetStatus = "idle", contextText = "SNIPPET", omitContext = false, goals, extraAgents = [], selfStatus, useSettings = false, selfCwd, omitUserQuestions = false } = {}) {
	const ctx = new Context();
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
	// one received.
	const extraCalls = new Map();
	const extraAgentObjects = extraAgents.map((entry) => {
		const calls = { injected: [], steered: [], followedup: [] };
		extraCalls.set(entry.id, calls);
		return {
			id: entry.id,
			status: entry.status,
			session: { header: { id: entry.id, cwd: CWD } },
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
		roots() { return [senderAgent, targetAgent, runnerAgent, ...extraAgentObjects]; },
	};
	const uq = makeUserQuestions(askScript);
	const settings = useSettings ? makeSettings() : undefined;
	ctx.provide("sessionReferenceResolver", resolver);
	ctx.provide("tools", { register(tool) { registeredTools.push(tool); return () => {}; } });
	ctx.provide("sessionQuery", makeQuery(sessions, eventsBySession));
	ctx.provide("agents", agents);
	// `omitUserQuestions` models a shell without the confirmation service (the
	// M2 retirement cleanup and the M1 send gates must both degrade, not crash).
	if (!omitUserQuestions) ctx.provide("userQuestions", uq.service);
	ctx.provide("webServer", { register(route) { routes.push(route); return () => {}; } });
	if (settings !== undefined) ctx.provide("settings", settings.service);
	// The `goals` service is optional by design (§3.1): absent here means the
	// degraded path, present means a goal view (or `undefined` for "no goal").
	if (goals !== undefined) ctx.provide("goals", { get(agent) { return goals[agent.id]; } });
	apply(ctx);
	const tool = (name) => registeredTools.find((candidate) => candidate.name === name);
	return { ctx, prepared, setFailWith: (error) => { failWith = error; }, setHiddenAgent: (id, value) => { if (value) hidden.add(id); else hidden.delete(id); }, registeredTools, routes, senderAgent, senderCalls, targetAgent, targetCalls, uq, tool, settings, agentFor: (id) => agents.get(id), extraCalls };
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

/** One roster row as the user would write it in the settings UI — the only path
 * that can seat a team's first coordinator, because a vacant coordinator refuses
 * every session-side write (§3.3.2). */
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

const vacantSetRole = await createRoster.execute({ action: "set-role", team: "night-shift", role: "coordinator", session: "session-self" }, execFor(createEnv.senderAgent));
check("U4: set-role is refused for every session while coordinator.current is null — the settings UI is the writable path", vacantSetRole.includes("当前空缺") && vacantSetRole.includes("设置 UI") && teamStore(createEnv)[0].roles.length === 0);
const vacantUpsert = await createRoster.execute({ action: "upsert-team", team: "night-shift" }, execFor(createEnv.senderAgent));
check("U4: an existing team answers upsert-team with the same writer gate", vacantUpsert.includes("当前空缺") && teamStore(createEnv).length === 1);

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
check("U5: a target with no live agent is its own row and its own summary bucket", deadFanOut.includes("- session-nope → no-agent：发送失败：目标会话 session-nope 没有活动代理") && deadFanOut.includes("汇总：0 投递 / 0 拒绝 / 1 无活动代理。"));

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

// cleanup
rmSync(tmpDir, { recursive: true, force: true });
rmSync(TEAM_TMP, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

/** Drive the agent/pre-step waterfall the way the loop does. */
async function ctx_waterfall(ctx, payload) {
	return ctx.waterfall({}, "agent/pre-step", payload, () => Promise.resolve({ kind: "enter", messages: [...payload.messages] }));
}
