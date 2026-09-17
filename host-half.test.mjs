// Unit smoke test for the dsh-team-link host half: drives the
// registered agent/pre-step listener through a real cordis waterfall with a
// stubbed sessionReferenceResolver (upstream deep-link behavior, unchanged),
// then exercises the three -pro tools against stubbed services.
// Run after the node_modules junctions are in place (see README).
import { Context } from "@deepseek-ai/cordis";
import { rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { apply } from "./lib/index.js";

let failures = 0;
function check(label, cond) {
	console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
	if (!cond) failures += 1;
}

// ---------------------------------------------------------------------------
// shared stubs
// ---------------------------------------------------------------------------

const CWD = "C:/dev/demo";

function makeSenderAgent() {
	const calls = { injected: [], steered: [], followedup: [] };
	const agent = {
		id: "session-self",
		session: { header: { id: "session-self", cwd: CWD } },
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

/** Scripted userQuestions service: ask() pops the next scripted answer. */
function makeUserQuestions(script) {
	const requests = [];
	return {
		service: {
			async ask(request) {
				requests.push(request);
				const next = script.shift();
				if (next === undefined) throw Object.assign(new Error("no scripted answer"), { code: "NO_PROVIDER" });
				return { answers: [{ id: request.questions[0].id, selected: [next], custom: undefined }] };
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
function setup({ sessions = [], eventsBySession = {}, askScript = [], targetStatus = "idle", contextText = "SNIPPET", omitContext = false } = {}) {
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
	const { agent: senderAgent, calls: senderCalls } = makeSenderAgent();
	const { agent: targetAgent, calls: targetCalls } = makeTargetAgent(targetStatus);
	const runnerAgent = { id: "session-runner", status: "running", session: { header: { id: "session-runner", cwd: CWD } } };
	const agents = {
		get(id) {
			if (id === senderAgent.id) return senderAgent;
			if (id === targetAgent.id) return targetAgent;
			if (id === runnerAgent.id) return runnerAgent;
			return undefined;
		},
		roots() { return [senderAgent, targetAgent, runnerAgent]; },
	};
	const uq = makeUserQuestions(askScript);
	ctx.provide("sessionReferenceResolver", resolver);
	ctx.provide("tools", { register(tool) { registeredTools.push(tool); return () => {}; } });
	ctx.provide("sessionQuery", makeQuery(sessions, eventsBySession));
	ctx.provide("agents", agents);
	ctx.provide("userQuestions", uq.service);
	ctx.provide("webServer", { register(route) { routes.push(route); return () => {}; } });
	apply(ctx);
	const tool = (name) => registeredTools.find((candidate) => candidate.name === name);
	return { ctx, prepared, setFailWith: (error) => { failWith = error; }, registeredTools, routes, senderAgent, senderCalls, targetAgent, targetCalls, uq, tool };
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

check("three tools registered", ["team_link_list_sessions", "team_link_export", "team_link_send"].every((name) => env.tool(name) !== undefined));
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

// cleanup
rmSync(tmpDir, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

/** Drive the agent/pre-step waterfall the way the loop does. */
async function ctx_waterfall(ctx, payload) {
	return ctx.waterfall({}, "agent/pre-step", payload, () => Promise.resolve({ kind: "enter", messages: [...payload.messages] }));
}
