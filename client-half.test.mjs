// Unit smoke test for the dsh-team-link browser half: loads the client
// bundle against a stubbed module loader/React and drives the relay-card gate.
//
// The gate is the risky part. A DSH 0.1.5 cross-session relay is published as
// `source = { kind: "agent-message", form: "relay", senderSessionId }` — the only
// shape the session-log migration admits — and upstream emits that SAME shape for
// adjacent-agent messages (bare-UUID ids, body `Agent <id> sent a message: …`).
// Kind + form alone therefore dresses foreign messages as this plugin's cards;
// these cases pin the `slp-` id discriminator (and its banner fallback) in place.
// Run after the node_modules junctions are in place (see README).
import { readFile } from "node:fs/promises";

let failures = 0;
/** Assertions executed in this run, printed at the end so the README figure is
 * checkable against the run instead of remembered (same rule as the host half,
 * §9.6 ⑧). */
let assertions = 0;
function check(label, cond) {
	assertions += 1;
	console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
	if (!cond) failures += 1;
}

// ---------------------------------------------------------------------------
// bundle harness: run lib/client.js against a stubbed loader, React and document
// ---------------------------------------------------------------------------

const SOURCE = await readFile(new URL("./lib/client.js", import.meta.url), "utf8");

/** Minimal React stand-in: createElement returns an inspectable plain tree. */
const React = {
	createElement(type, props, ...children) { return { type, props: props === null || props === undefined ? {} : props, children }; },
	useState(initial) { return [initial, () => {}]; },
	useCallback(fn) { return fn; },
	Fragment: Symbol("Fragment"),
};

function createElementStub() {
	return { dataset: {}, style: {}, textContent: "", setAttribute() {}, appendChild() {} };
}

const styleTags = [];
const documentStub = {
	querySelector() { return null; },
	createElement: createElementStub,
	head: { appendChild(tag) { styleTags.push(tag); } },
	body: { appendChild() {}, removeChild() {} },
};

let definition = null;
const windowStub = {
	__ModuleLoader__: { load(value) { definition = value; } },
	location: { pathname: "/" },
	isSecureContext: false,
	setTimeout,
	open() {},
};

// The bundle is a plain script that only talks to the loader at load time.
new Function("window", "document", SOURCE)(windowStub, documentStub);
check("client bundle registers its module definition", definition !== null && definition.id === "dsh-team-link");
check("client bundle exposes a factory", definition !== null && typeof definition.factory === "function");

const required = [];
const moduleExports = definition.factory((specifier) => {
	required.push(specifier);
	if (specifier === "react") return React;
	throw new Error(`unstubbed require: ${specifier}`);
});
check("factory only requires react", required.length === 1 && required[0] === "react");

// ---------------------------------------------------------------------------
// plugin context stub: capture the slot registrations apply() performs
// ---------------------------------------------------------------------------

const registrations = [];
/** Dictionary registered per language: `ctx.locale.register(ns, lang, dict)`.
 * Captured so the assertions can read the REAL copy (a key renamed in lib/ and
 * not here would show up as the key name itself). */
const localeDicts = new Map();
/** The Definition this plugin hands to the uiConversation registry (§10.1.3 D);
 * U15 drives it the way the assembler does. */
let registeredDefinition = null;
const uiConversationStub = {
	events: {
		register(definition) { registeredDefinition = definition; return () => {}; },
	},
};
const ctx = {
	effect(fn) { const disposer = fn(); return typeof disposer === "function" ? disposer : () => {}; },
	locale: {
		register(_namespace, lang, dict) { localeDicts.set(lang, dict); return () => {}; },
		bind() { return (key) => key; },
	},
	slots: {
		inject(_name, register) { return register(); },
		register(options, component) { registrations.push({ options, component }); return () => {}; },
		entries() { return []; },
	},
	sessions: { list: { getSnapshot() { return { byId: {} }; } }, open() {} },
	// cordis: `inject` runs the callback on the context that holds the services.
	// The stub is the "already active" case.
	inject(_specs, callback) { return callback({ uiConversation: uiConversationStub }); },
};

moduleExports.apply(ctx);
const nodeSlot = registrations.find((entry) => entry.options.name === "conversation.chat.node");
const headerSlot = registrations.find((entry) => entry.options.name === "conversation.session.header.actions");
check("relay card shadows the keyed context slot", nodeSlot !== undefined && nodeSlot.options.key === "context" && nodeSlot.options.priority === -100);
check("header action strip still registered", headerSlot !== undefined);
check("styles injected once", styleTags.length === 1 && String(styleTags[0].textContent).includes(".dshsl-relay{"));

// ---------------------------------------------------------------------------
// relay-card gate
// ---------------------------------------------------------------------------

const t = (key) => key;
// The shell hands a chat-node renderer `{...ownerProps, node}` where the node is
// `{key, kind, id, target, data}` — `id` is the durable message id, and the context
// node's `data` is `{kind, seq, time, content, source, provenance, form}`.
const render = (data, id) => nodeSlot.component({ node: id === undefined ? { data } : { id, data }, t });
const isCard = (tree) => tree !== null && typeof tree === "object" && tree.props !== undefined && tree.props.className === "dshsl-relay";
const isDelegated = (tree) => !isCard(tree) && tree.props !== undefined && tree.props.style !== undefined && tree.props.style.fontSize === "11px";
const headOf = (tree) => tree.children[0];
const bodyTextOf = (tree) => tree.children[1].children.join("");
/** Text of a delegated node: the plain fallback renders one text child. */
const delegatedTextOf = (tree) => tree.children.join("");
const headSpan = (tree, className) => headOf(tree).children.filter((child) => child !== null && child !== undefined && child.props !== undefined && child.props.className === className)[0];
const spanText = (span) => span.children.join("");
const textOf = (blocks) => [{ type: "text", text: blocks.join("\n\n") }];

const BANNER = "📨 [跨会话消息 · 来自会话 ";
const FOOTER = "（如需回复，可让本会话调用 team_link_send 工具发回）";
const relayBody = (sessionId, when, payload) => [BANNER + sessionId + (when === undefined ? "" : ` · ${when}`) + "]", "", payload, "", FOOTER].join("\n");

// 1. pre-0.1.5 history: the retired kind, with its `sentAt` provenance.
const legacyWhen = "2026-01-02T03:04:05.000Z";
const legacy = render({
	source: { kind: "team-link", plugin: "dsh-team-link", fromSession: "session-a", senderSessionId: "session-a", form: "relay", sentAt: legacyWhen },
	content: textOf([relayBody("session-a", undefined, "老日志正文")]),
}, "slp-11111111-1111-1111-1111-111111111111");
check("legacy kind still renders as a card", isCard(legacy));
check("legacy card reads senderSessionId", spanText(headSpan(legacy, "dshsl-relay-sender")).includes("session-a"));
check("legacy card still reads sentAt", spanText(headSpan(legacy, "dshsl-relay-when")) === new Date(legacyWhen).toLocaleString());
check("legacy card strips the banner wrapper", bodyTextOf(legacy) === "老日志正文");

// 2. current shape: `slp-` node id + the audited three-member source. The time is
//    the durable event time the context node already carries.
const eventTime = new Date(2026, 1, 14, 9, 30, 0).valueOf();
const stamped = render({
	time: eventTime,
	source: { kind: "agent-message", form: "relay", senderSessionId: "session-b" },
	content: textOf([relayBody("session-b", "2026-02-14 09:30:00", "新格式正文")]),
}, "slp-22222222-2222-2222-2222-222222222222");
check("published relay shape renders as a card", isCard(stamped));
check("published card reads senderSessionId", spanText(headSpan(stamped, "dshsl-relay-sender")).includes("session-b"));
check("published card shows the durable event time", spanText(headSpan(stamped, "dshsl-relay-when")) === new Date(eventTime).toLocaleString());
check("published card strips the banner wrapper", bodyTextOf(stamped) === "新格式正文");

// 3. THE TRAP: an upstream adjacent-agent message uses the same kind/form pair
//    (bare UUID id, `Agent <id> sent a message:` body). It must stay untouched.
const upstream = render({
	source: { kind: "agent-message", form: "relay", senderSessionId: "session-c" },
	content: textOf(["Agent session-c sent a message: 上游相邻代理消息"]),
}, "33333333-3333-4333-8333-333333333333");
check("upstream agent-message is NOT dressed as a relay card", isDelegated(upstream));
check("upstream message text passes through", delegatedTextOf(upstream).includes("上游相邻代理消息"));

// 4. Any other plugin's injected context keeps the default rendering.
const foreign = render({ source: { kind: "plugin", plugin: "other-plugin", form: "notice", summary: "s" }, content: textOf(["其他插件的上下文"]) }, "slp-lookalike");
check("foreign plugin context is delegated", isDelegated(foreign));

// 5. The `slp-` gate reads `node.id` (the context `data` has no id of its own).
const nodeIdOnly = render({
	source: { kind: "agent-message", form: "relay", senderSessionId: "session-h" },
	content: textOf(["正文没有 banner，只有 node.id 是 slp-"]),
}, "slp-44444444-4444-4444-4444-444444444444");
check("node.id drives the gate", isCard(nodeIdOnly) && bodyTextOf(nodeIdOnly).includes("只有 node.id") && spanText(headSpan(nodeIdOnly, "dshsl-relay-sender")).includes("session-h"));

// 6. Either identification signal is enough: a render path whose id is missing,
//    or is not the message id at all, still gets its card from the banner.
const noId = render({ source: { kind: "agent-message", form: "relay", senderSessionId: "session-d" }, content: textOf([relayBody("session-d", "2026-02-14 10:00:00", "无 id 正文")]) });
check("id-less relay with our banner still renders as a card", isCard(noId) && bodyTextOf(noId) === "无 id 正文");
check("banner stamp is the last-resort time", spanText(headSpan(noId, "dshsl-relay-when")) === new Date(2026, 1, 14, 10, 0, 0).toLocaleString());
const oddId = render({ source: { kind: "agent-message", form: "relay", senderSessionId: "session-f" }, content: textOf([relayBody("session-f", "2026-02-14 11:00:00", "非消息 id 正文")]) }, "node-7");
check("non-message-id relay with our banner still renders as a card", isCard(oddId) && bodyTextOf(oddId) === "非消息 id 正文");
const noIdForeign = render({ source: { kind: "agent-message", form: "relay", senderSessionId: "session-e" }, content: textOf(["Agent session-e sent a message: 无 id 上游消息"]) });
check("id-less foreign relay stays delegated", isDelegated(noIdForeign));
const oddIdForeign = render({ source: { kind: "agent-message", form: "relay", senderSessionId: "session-g" }, content: textOf(["Agent session-g sent a message: 非 slp id 上游消息"]) }, "node-8");
check("upstream relay under a non-slp id stays delegated", isDelegated(oddIdForeign));

// 7. Degenerate nodes never throw and never turn into cards.
const bare = render({});
check("empty node delegates", isDelegated(bare));
const noSource = render({ content: textOf(["没有 source"]) }, "slp-x");
check("source-less node delegates", isDelegated(noSource));

// 8. The banner stamp is anchored to the END of the head line, so a session title
//    that itself looks like a date (or a very long title) cannot win the parse.
const dateLikeTitle = render({ source: { kind: "agent-message", form: "relay", senderSessionId: "session-i" }, content: textOf([relayBody("「2026-01-01 12:00:00 的讨论」session-i", "2026-03-03 08:08:08", "标题含日期")]) }, "slp-55555555-5555-5555-5555-555555555555");
check("a date-like title does not win the stamp", spanText(headSpan(dateLikeTitle, "dshsl-relay-when")) === new Date(2026, 2, 3, 8, 8, 8).toLocaleString());
const longTitle = render({ source: { kind: "agent-message", form: "relay", senderSessionId: "session-j" }, content: textOf([relayBody(`「${"很长的标题".repeat(90)}」session-j`, "2026-04-04 09:09:09", "标题很长")]) }, "slp-66666666-6666-6666-6666-666666666666");
check("a long title still yields the stamp", spanText(headSpan(longTitle, "dshsl-relay-when")) === new Date(2026, 3, 4, 9, 9, 9).toLocaleString());
const noStamp = render({ source: { kind: "agent-message", form: "relay", senderSessionId: "session-k" }, content: textOf([relayBody("session-k", undefined, "旧 banner 没有时间")]) }, "slp-77777777-7777-7777-7777-777777777777");
check("a stamp-less banner shows no time", headSpan(noStamp, "dshsl-relay-when") === undefined);

// 8b. R7 (M3 review): the head line may carry the §3.4 envelope AFTER the stamp
//     (`… 23:42:05 · type=ruling pri=P0 ref=slp-a1b2]`). The stamp must still be
//     read, and the envelope fields must not leak into the card body.
const metaCard = render({ source: { kind: "agent-message", form: "relay", senderSessionId: "session-m" }, content: textOf([relayBody("session-m", "2026-05-05 10:10:10 · type=ruling pri=P0 ref=slp-a1b2", "带信封正文")]) }, "slp-dddddddd-dddd-dddd-dddd-dddddddddddd");
check("R7: a banner carrying envelope meta still yields its stamp", spanText(headSpan(metaCard, "dshsl-relay-when")) === new Date(2026, 4, 5, 10, 10, 10).toLocaleString());
check("R7: the envelope fields stay in the banner and out of the card body", bodyTextOf(metaCard) === "带信封正文");
const metaTitle = render({ source: { kind: "agent-message", form: "relay", senderSessionId: "session-n" }, content: textOf([relayBody("「2026-01-01 12:00:00 的讨论」session-n", "2026-05-06 11:11:11 · type=report pri=P2", "标题含日期且带信封")]) }, "slp-eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee");
check("R7: the envelope-aware regex still lets the true stamp win over a date-like title", spanText(headSpan(metaTitle, "dshsl-relay-when")) === new Date(2026, 4, 6, 11, 11, 11).toLocaleString());
check("R7: a relay without meta keeps its exact previous parse", spanText(headSpan(noId, "dshsl-relay-when")) === new Date(2026, 1, 14, 10, 0, 0).toLocaleString());

// ---------------------------------------------------------------------------
// header actions: copy + export side by side
// ---------------------------------------------------------------------------

const header = headerSlot.component({ sessionId: "session-xyz", t });
check("header strip renders copy + export", Array.isArray(header.children) && header.children.length === 2);
const renderChild = (element) => element.type(element.props);
check("copy button carries the session aria-label", String(renderChild(header.children[0]).props["aria-label"]) === "copyLink");
check("export button carries the export label", String(renderChild(header.children[1]).props.title) === "exportSession");

// ---------------------------------------------------------------------------
// 9. lone-surrogate safety: the shortened session id cuts on code points
// ---------------------------------------------------------------------------

// `id.slice(0, 14)` can keep a trailing HIGH surrogate and `id.slice(-8)` can
// start on a LOW one whenever a pair straddles either index — the same
// code-unit cut that poisons a host tool result. This path is display-only: a
// browser text node goes through the DOM's USVString conversion (which maps a
// lone surrogate to U+FFFD) and the string never re-enters a model request, so
// the old form was cosmetically wrong rather than session-killing. Pinned
// anyway, because it IS reachable with a non-ASCII id and the code-point cut is
// a no-op for the ASCII ids the harness mints.
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const headHigh = "session-xxxxx🔵"; // the emoji's high half lands on code-unit index 13
const astralId = headHigh + "y".repeat(4) + "🔵" + "z".repeat(7); // and a low half 8 units from the end
const astralCard = render({ source: { kind: "agent-message", form: "relay", senderSessionId: astralId }, content: textOf([relayBody(astralId, undefined, "emoji id")]) }, "slp-88888888-8888-8888-8888-888888888888");
const astralSender = spanText(headSpan(astralCard, "dshsl-relay-sender"));
check("astral session id renders as a card", isCard(astralCard));
check("astral session id shortens without a lone surrogate", !LONE.test(astralSender));
check("astral session id keeps 14 head + 8 tail code points", [...astralSender.replace("来自 ", "")].length === 14 + 1 + 8);
check("astral session id keeps the whole head emoji", astralSender.startsWith("来自 session-xxxxx🔵"));
const asciiId = "session-" + "a".repeat(32);
const asciiCard = render({ source: { kind: "agent-message", form: "relay", senderSessionId: asciiId }, content: textOf([relayBody(asciiId, undefined, "ascii id")]) }, "slp-99999999-9999-9999-9999-999999999999");
check("ASCII session id shortening is unchanged", spanText(headSpan(asciiCard, "dshsl-relay-sender")) === "来自 session-aaaaaa…aaaaaaaa");
const shortIdCard = render({ source: { kind: "agent-message", form: "relay", senderSessionId: "session-b" }, content: textOf([relayBody("session-b", undefined, "短 id")]) }, "slp-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
check("short id still passes through unchanged", spanText(headSpan(shortIdCard, "dshsl-relay-sender")) === "来自 session-b");
// A row written by an older build (or any foreign row claiming this shape) can
// already carry a lone surrogate. The DOM would repair it via USVString
// conversion; this harness has no DOM, so the repair is asserted where it is
// visible — the rendered body text itself.
const poisonedLegacy = render({ source: { kind: "team-link", fromSession: "session-p", sentAt: legacyWhen }, content: textOf([relayBody("session-p", undefined, "断开的\uD83D 负载")]) }, "slp-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
check("a lone surrogate in a legacy row body is repaired", !LONE.test(bodyTextOf(poisonedLegacy)));
check("the repaired legacy body keeps its text", bodyTextOf(poisonedLegacy).includes("断开的") && bodyTextOf(poisonedLegacy).includes("负载"));
// A SHORT (unshortened, <= 26 code units) id is returned verbatim by the
// shortener, so the repair has to sit on the rendered value, not only on the cut.
const rawHalfId = "session-\uD83Dq";
const poisonedRawId = render({ source: { kind: "team-link", fromSession: rawHalfId, sentAt: legacyWhen }, content: textOf([relayBody(rawHalfId, undefined, "短 id 带半截")]) }, "slp-cccccccc-cccc-cccc-cccc-cccccccccccc");
check("a short poisoned sender id is repaired", rawHalfId.length <= 26 && !LONE.test(spanText(headSpan(poisonedRawId, "dshsl-relay-sender"))));
// The delegation fallback renders OTHER plugins' context text — still this file's
// output, so it goes through the same repair.
const foreignHalf = render({ source: { kind: "plugin", plugin: "other-plugin", form: "notice" }, content: textOf(["外来的\uD83D 半截文本"]) }, "node-9");
check("a lone surrogate in delegated foreign context is repaired", isDelegated(foreignHalf) && !LONE.test(delegatedTextOf(foreignHalf)));
check("the delegated foreign text is otherwise untouched", delegatedTextOf(foreignHalf).includes("半截文本"));

// ---------------------------------------------------------------------------
// U14 (§10.1.1 A): the sender's own tool row — `tool.call.toolview` keyed by
// the WIRE TOOL NAME, rendered from the §10.1.2 receipt, plain text otherwise.
// ---------------------------------------------------------------------------

/** Render a React-stub tree the way React would: the stub's createElement only
 * BUILDS elements, so the one expansion React performs for a function component
 * is done here (`type({...props, children})`). Fragments are flattened too. */
function flatten(tree) {
	if (tree === null || tree === undefined || typeof tree !== "object") return tree;
	if (Array.isArray(tree)) return tree.map(flatten);
	if (typeof tree.type === "function") return flatten(tree.type({ ...tree.props, children: tree.children }));
	if (tree.type === React.Fragment) return flatten(tree.children);
	const children = tree.children === undefined ? [] : Array.isArray(tree.children) ? tree.children.map(flatten) : [flatten(tree.children)];
	return { type: tree.type, props: tree.props, children };
}
/** Flat text of a React-stub tree (strings and numbers, in child order). */
function treeText(tree) {
	if (tree === null || tree === undefined || tree === false) return "";
	if (typeof tree === "string" || typeof tree === "number") return String(tree);
	if (Array.isArray(tree)) return tree.map(treeText).join("");
	if (typeof tree === "object" && tree.children !== undefined) return treeText(tree.children);
	return "";
}
/** First node in the tree whose props carry this className. */
function treeByClass(tree, className) {
	if (tree === null || tree === undefined || typeof tree !== "object") return null;
	if (Array.isArray(tree)) {
		for (const child of tree) {
			const hit = treeByClass(child, className);
			if (hit !== null) return hit;
		}
		return null;
	}
	if (tree.props !== undefined && tree.props.className === className) return tree;
	return treeByClass(tree.children, className);
}
/** All nodes in the tree whose props carry this className (target rows). */
function treeAllByClass(tree, className) {
	if (tree === null || tree === undefined || typeof tree !== "object") return [];
	if (Array.isArray(tree)) return tree.flatMap((child) => treeAllByClass(child, className));
	const here = tree.props !== undefined && tree.props.className === className ? [tree] : [];
	return [...here, ...treeAllByClass(tree.children, className)];
}
const isSendCard = (tree) => {
	const card = treeByClass(tree, "dshsl-relay dshsl-send");
	return card !== null && card.props["data-slp-send"] === "row";
};
const isSendPlain = (tree) => {
	const plain = treeByClass(tree, "dshsl-plain");
	return plain !== null && plain.props["data-slp-send"] === "plain";
};

const toolViewSlot = registrations.find((entry) => entry.options.name === "tool.call.toolview");
check("U14: the plugin claims the keyed tool view slot for its own wire tool name", toolViewSlot !== undefined);
// The dispatch is a plain keyed lookup against the wire tool name, and a typo
// falls back to the generic tool row with NO error anywhere — so the literal is
// the thing worth pinning, together with the near-misses it must not be.
check("U14: the slot key is the wire tool name VERBATIM (a typo would silently fall back to the generic row)", toolViewSlot.options.key === "team_link_send");
check("U14: ... and no near-miss claims that tool row (the tool view slot holds exactly one key)", ["team-link-send", "team_link_send ", "Team_link_send", "team_link_send2"].every((near) => registrations.filter((entry) => entry.options.name === "tool.call.toolview").every((entry) => entry.options.key !== near)) && registrations.filter((entry) => entry.options.name === "tool.call.toolview").length === 1);

const sendBlock = (meta, text = "已投递到 session-worker-a（已配对通道，免确认自动投递）：目标空闲，已唤醒目标会话并作为新回合处理。") => ({
	kind: "tool-result",
	seq: 42,
	time: 1_700_000_000_000,
	callId: "call-1",
	call: { name: "team_link_send", argsRaw: "{\"message\":\"x\"}" },
	callTime: 1_699_999_999_000,
	content: [{ type: "text", text }],
	isError: false,
	meta,
	subCalls: [],
});
const runningBlock = () => ({ callId: "call-1", name: "team_link_send", argsRaw: "{\"message\":\"x\"}", turn: 1, step: 1, time: 1_700_000_000_000, subCalls: [] });
/** The real copy of the zh dictionary (a missing key falls back to the key name,
 * so an assertion naming the copy pins the key too). */
const tZh = (key) => (localeDicts.get("zh") !== undefined && Object.prototype.hasOwnProperty.call(localeDicts.get("zh"), key) ? localeDicts.get("zh")[key] : key);
const renderSendRow = (block, toolName = "team_link_send") => flatten(toolViewSlot.component({ callId: "call-1", toolName, block, t: tZh }));

/** A §10.1.2 receipt as the host half mints it (the client never trusts more). */
const SEND_CARD = {
	kind: "team-link-send",
	v: 1,
	at: new Date(2026, 8, 19, 12, 0, 0).valueOf(),
	senderSessionId: "session-self",
	meta: { type: "ruling", pri: "P0", ref: "slp-a1b2" },
	message: { text: "裁决：走 A 方案", truncated: false, chars: 9 },
	targets: [
		{ sessionId: "session-worker-a", expr: "team:night-shift/*", outcome: "delivered", detail: "已投递到 session-worker-a：目标空闲，已唤醒目标会话。", busy: { running: false } },
		{ sessionId: "session-worker-b", expr: "team:night-shift/*", outcome: "refused", detail: "未投递：目标会话用户未确认接收。" },
		{ sessionId: null, expr: "team:night-shift/reviewer", outcome: "no-holder", detail: "该角色当前空缺" },
	],
	summary: { delivered: 1, refused: 1, noAgent: 0, noHolder: 1, deduped: 2 },
	fanout: true,
};

const cardRow = renderSendRow(sendBlock(SEND_CARD));
check("U14: a settled call carrying a receipt renders as the send card, not a plain row", isSendCard(cardRow) && !isSendPlain(cardRow));
check("U14: the card is the receiver's card with the outbound accent (same card component/classes)", treeByClass(cardRow, "dshsl-relay dshsl-send") !== null && treeByClass(cardRow, "dshsl-relay-head") !== null && treeByClass(cardRow, "dshsl-relay-body") !== null && treeByClass(cardRow, "dshsl-relay-foot") !== null);
check("U14: the head states the title, the sender session and the delivery time", treeText(treeByClass(cardRow, "dshsl-relay-head")).includes("已发出跨会话消息") && treeText(treeByClass(cardRow, "dshsl-relay-head")).includes("session-self") && treeText(treeByClass(cardRow, "dshsl-relay-head")).includes(new Date(SEND_CARD.at).toLocaleString()));
check("U14: the §3.4 envelope rides the head as its compact k=v fields", treeText(treeByClass(cardRow, "dshsl-send-env")) === "type=ruling pri=P0 ref=slp-a1b2");
check("U14: the body shows the message that was sent", treeText(treeByClass(cardRow, "dshsl-relay-body")).includes("裁决：走 A 方案"));
check("U14: a non-truncated body carries no truncation note", !treeText(treeByClass(cardRow, "dshsl-relay-body")).includes("正文已截断"));
const detailRows = treeAllByClass(cardRow, "dshsl-send-target");
check("U14: A carries the per-target DETAIL — one row per target, with its outcome label", detailRows.length === 3 && detailRows.map((row) => treeText(row)).join("|") === [
	"已投递 已投递到 session-worker-a：目标空闲，已唤醒目标会话。",
	"被拒绝 未投递：目标会话用户未确认接收。",
	"空缺目标 该角色当前空缺",
].join("|"));
check("U14: ... and every outcome is carried as a data attribute (a refused row is visually distinct)", detailRows.map((row) => treeByClass(row, "dshsl-send-outcome").props["data-outcome"]).join(",") === "delivered,refused,no-holder");
check("U14: the summary restates the receipt's own counts, plus dedupe when there is one", treeText(treeByClass(cardRow, "dshsl-send-summary")) === "汇总：1 投递 / 1 拒绝 / 0 无活动代理 / 1 空缺目标 · 2 个重复目标已去重");
const busyRow = renderSendRow(sendBlock({ ...SEND_CARD, targets: [{ sessionId: "session-worker-a", outcome: "delivered", detail: "已投递", busy: { running: true, minutes: 7 } }], summary: { delivered: 1, refused: 0, noAgent: 0, noHolder: 0, deduped: 0 } }));
check("U14: a running target's row carries the §3.5 busy prediction with its minutes", treeText(busyRow).includes("（目标回合已运行 7 分钟——steer 注入当前回合）"));
const busyUnknownRow = renderSendRow(sendBlock({ ...SEND_CARD, targets: [{ sessionId: "session-worker-a", outcome: "delivered", detail: "已投递", busy: { running: true } }], summary: { delivered: 1, refused: 0, noAgent: 0, noHolder: 0, deduped: 0 } }));
check("U14: an unreadable turn start states steer without inventing a number", treeText(busyUnknownRow).includes("（目标回合运行中——起始时间不可读）") && !/已运行 \d+ 分钟/u.test(treeText(busyUnknownRow)));
const truncatedRow = renderSendRow(sendBlock({ ...SEND_CARD, message: { text: "头" + "..." + "尾", truncated: true, chars: 2100 } }));
check("U14: a truncated body says so and states the ORIGINAL code-point count", treeText(treeByClass(truncatedRow, "dshsl-relay-body")).includes("（正文已截断，原文 2100 码点）"));
const emptyBodyRow = renderSendRow(sendBlock({ ...SEND_CARD, message: { text: "", truncated: false, chars: 0 } }));
check("U14: an empty body falls back to the same（空）marker the receiver's card uses", treeText(treeByClass(emptyBodyRow, "dshsl-relay-body")).includes("（空）"));
const noEnvelopeRow = renderSendRow(sendBlock({ ...SEND_CARD, meta: undefined }));
check("U14: a receipt without an envelope renders no envelope span at all", treeByClass(noEnvelopeRow, "dshsl-send-env") === null);

// --- the fallback: no receipt → the model-visible text, never a half card ----
const runningRow = renderSendRow(runningBlock());
check("U14: an in-flight call has no receipt yet and renders the plain row", isSendPlain(runningRow) && !isSendCard(runningRow));
check("U14: the plain row names the call and says it is still running", treeText(runningRow).includes("工具调用") && treeText(runningRow).includes("team_link_send") && treeText(runningRow).includes("调用中…"));
const noMetaRow = renderSendRow(sendBlock(undefined, "已投递到 session-worker-a（已配对通道，免确认自动投递）：目标空闲。"));
check("U14: a settled call with NO meta falls back to plain text (every log written before §10.1)", isSendPlain(noMetaRow) && !isSendCard(noMetaRow));
check("U14: ... and the fallback shows the model-visible result verbatim", treeText(treeByClass(noMetaRow, "dshsl-plain-body")) === "已投递到 session-worker-a（已配对通道，免确认自动投递）：目标空闲。" && treeText(noMetaRow).includes("无结构化回执"));
check("U14: a result with no text blocks still renders the plain row (no empty card, no crash)", isSendPlain(renderSendRow({ ...sendBlock(undefined), content: [] })));

// --- anything this build cannot read is NOT a card ---------------------------
const foreignMeta = renderSendRow(sendBlock({ kind: "fs-search", v: 1, results: [] }));
check("U14: another tool's meta is not dressed as our card (the discriminator is ours)", isSendPlain(foreignMeta) && !isSendCard(foreignMeta));
const malformed = [
	["not an object", "nope"],
	["null", null],
	["an array", []],
	["a wrong version", { ...SEND_CARD, v: 2 }],
	["a missing message", { ...SEND_CARD, message: undefined }],
	["a missing sender", { ...SEND_CARD, senderSessionId: "" }],
	["a non-numeric time", { ...SEND_CARD, at: "yesterday" }],
	["targets that are not an array", { ...SEND_CARD, targets: {} }],
	["a target with an unknown outcome type", { ...SEND_CARD, targets: [{ sessionId: "s", outcome: 7, detail: "d" }] }],
	["a target without a detail sentence", { ...SEND_CARD, targets: [{ sessionId: "s", outcome: "delivered" }] }],
	["a target id that is neither a string nor null", { ...SEND_CARD, targets: [{ sessionId: 5, outcome: "delivered", detail: "d" }] }],
	["no summary", { ...SEND_CARD, summary: undefined }],
];
check(`U14: none of the ${malformed.length} unreadable receipt shapes becomes a card`, malformed.every(([, meta]) => isSendPlain(renderSendRow(sendBlock(meta))) ));
check("U14: ... and each of them still shows the model-visible text instead", malformed.every(([, meta]) => treeText(renderSendRow(sendBlock(meta, "回退正文"))).includes("回退正文")));
const hostile = { kind: "team-link-send", get v() { throw new Error("hostile getter"); } };
check("U14: a receipt with a throwing getter degrades to the plain row instead of taking the transcript down", isSendPlain(renderSendRow(sendBlock(hostile))));
check("U14: the reader is total — it never throws for any of these shapes", malformed.every(([, meta]) => {
	try {
		renderSendRow(sendBlock(meta));
		return true;
	} catch {
		return false;
	}
}));

// ---------------------------------------------------------------------------
// U15 (§10.1.3 D): this plugin's own Conversation Definition and the top-level
// node it produces — matched on EXISTING tool/call + tool/result events only.
// ---------------------------------------------------------------------------

const relayNodeSlot = registrations.find((entry) => entry.options.name === "conversation.chat.node" && entry.options.key === "context");
const topSlot = registrations.find((entry) => entry.options.name === "conversation.chat.node" && entry.options.key === "team-link-send");
check("U15: the top-level node renderer is registered under its own kind, beside the receiver's context card", topSlot !== undefined && relayNodeSlot !== undefined && topSlot.options.key !== relayNodeSlot.options.key);
check("U15: ... at the §10.1.3 priority, in this plugin's locale namespace", topSlot.options.priority === -90 && topSlot.options.locale === "dsh-team-link");
check("U15: the two coexist on the same keyed slot (a second entry at the SAME key would throw; these are different keys)", registrations.filter((entry) => entry.options.name === "conversation.chat.node").length === 2);
check("U15: the definition reaches the uiConversation registry, and its kind is the card's discriminator (def / slot / data cannot drift apart)", registeredDefinition !== null && registeredDefinition.kind === "team-link-send" && registeredDefinition.kind === topSlot.options.key);
check("U15: the definition declares the chat view target together with a buildViewNode (the registry requires the pair)", registeredDefinition.target === "chat" && typeof registeredDefinition.buildViewNode === "function");
check("U15: the definition owns no Location-data publication and no new event source — it is a reader of the existing log", registeredDefinition.buildLocationData === undefined);

const callEvent = (name, callId, seq = 10, time = 1_700_000_000_000) => ({ type: "tool/call", seq, time, data: { turn: 1, step: 1, callId, name, arguments: "{\"message\":\"x\"}" } });
const resultEvent = (callId, meta, seq = 11, time = 1_700_000_001_000, name = "team_link_send") => ({
	type: "tool/result",
	seq,
	time,
	data: { turn: 1, step: 1, message: { source: { callId, name, role: "tool" }, content: [{ type: "text", text: "已投递" }] }, meta },
});

check("U15: a tool/call for THIS tool is claimed as a start, keyed by the call id", JSON.stringify(registeredDefinition.match(callEvent("team_link_send", "call-9"))) === JSON.stringify({ id: "call-9", role: "start" }));
check("U15: a tool/call for any other tool is NOT claimed (the kind never fires on foreign calls)", ["send_message", "team_link_list_sessions", "bash"].every((name) => registeredDefinition.match(callEvent(name, "call-9")) === null));
check("U15: no other event type is claimed — the definition reads existing events, it does not invent one", ["user/message", "assistant/message", "turn/start", "turn/end", "command/run", "team-link-send"].every((type) => registeredDefinition.match({ type, seq: 1, time: 1, data: {} }) === null));
check("U15: a tool/result carrying our receipt is claimed as the update for that call", JSON.stringify(registeredDefinition.match(resultEvent("call-9", SEND_CARD))) === JSON.stringify({ id: "call-9", role: "update" }));
check("U15: a tool/result with no receipt is NOT claimed (no engine Context for every tool call in the session)", registeredDefinition.match(resultEvent("call-9", undefined)) === null && registeredDefinition.match(resultEvent("call-9", { kind: "fs-search" })) === null);
check("U15: a malformed event never throws the match (the reader is total)", [null, undefined, 7, {}, { type: "tool/call" }, { type: "tool/result" }].every((event) => {
	try {
		return registeredDefinition.match(event) === null || typeof registeredDefinition.match(event) === "object";
	} catch {
		return false;
	}
}));

/** Drive the definition the way the assembler does: `start` for the call, then
 * `update` for each later match, with the Context grown as it goes (the start
 * event is always `matches[0]`, per the registry's own invariant). */
function driveDefinition(events) {
	let context = { key: "team-link-send\u0000call-1", kind: "team-link-send", id: "call-1", matches: [], start: undefined, state: undefined };
	for (const event of events) {
		const match = registeredDefinition.match(event);
		if (match === null) continue;
		const entry = { event, role: match.role, location: { kind: "step", turn: {}, step: {} } };
		const isStart = match.role === "start";
		context = { ...context, matches: [...context.matches, entry], start: isStart ? entry : context.start };
		if (isStart) context.state = registeredDefinition.start(context, entry);
		else if (context.state !== undefined) context.state = registeredDefinition.update(context, entry);
	}
	return { context, node: registeredDefinition.buildViewNode(context) };
}

const fullRun = driveDefinition([callEvent("team_link_send", "call-1"), resultEvent("call-1", SEND_CARD)]);
check("U15: a settled send produces a top-level node", fullRun.node !== null && fullRun.node.kind === "team-link-send");
check("U15: the node is a full chat view node — key/kind/id/target/anchorSeq/location/visibility/data", fullRun.node.key === fullRun.context.key && fullRun.node.id === "call-1" && fullRun.node.target === "chat" && fullRun.node.anchorSeq === 10 && fullRun.node.visibility === "visible" && fullRun.node.location !== undefined && fullRun.node.data !== undefined);
check("U15: the node renders the SUMMARY face — recipients and counts, not the per-target detail sentences (that stays in the tool row)", treeText(flatten(topSlot.component({ node: fullRun.node, t: tZh }))).includes("发给 3 个目标：") && treeText(flatten(topSlot.component({ node: fullRun.node, t: tZh }))).includes("session-worker-b") && !treeText(flatten(topSlot.component({ node: fullRun.node, t: tZh }))).includes("未投递：目标会话用户未确认接收。"));
check("U15: ... and the summary counts, the body and the time are on it", treeText(flatten(topSlot.component({ node: fullRun.node, t: tZh }))).includes("汇总：1 投递 / 1 拒绝 / 0 无活动代理 / 1 空缺目标") && treeText(flatten(topSlot.component({ node: fullRun.node, t: tZh }))).includes("裁决：走 A 方案") && treeText(flatten(topSlot.component({ node: fullRun.node, t: tZh }))).includes(new Date(SEND_CARD.at).toLocaleString()));
check("U15: the top-level card is flagged as the top face (a different face from the tool row's)", treeByClass(flatten(topSlot.component({ node: fullRun.node, t: tZh })), "dshsl-relay dshsl-send").props["data-slp-send"] === "top");

const runningRun = driveDefinition([callEvent("team_link_send", "call-1")]);
check("U15: an in-flight send produces NO node yet (there is no receipt to draw)", runningRun.node === null);
const noCardRun = driveDefinition([callEvent("team_link_send", "call-1"), resultEvent("call-1", undefined)]);
check("U15: a call whose result carries no receipt produces no node (and no half card)", noCardRun.node === null);

// --- window truncation: only the tool/result is in the loaded history -------
const truncated = driveDefinition([resultEvent("call-1", SEND_CARD, 42)]);
check("U15: with the tool/call outside the window the fallback still produces the node", truncated.node !== null && truncated.node.kind === "team-link-send" && truncated.context.start === undefined);
check("U15: ... anchored on the result event that is actually loaded", truncated.node !== null && truncated.node.anchorSeq === 42 && truncated.node.location !== undefined);
// The wire shape carries no tool name on a result (`ToolMessageSource` is exactly
// `{kind, callId}`), so with the call head out of window the receipt's own
// discriminator is the only claim available — and a meta that is NOT our card
// never becomes a node.
const truncatedForeign = driveDefinition([resultEvent("call-1", { kind: "other-tool" }, 42)]);
check("U15: a lone result WITHOUT our receipt stays unrendered — no node is invented for a foreign call", truncatedForeign.node === null);
check("U15: a node built from a Context the assembler never gave a state does not throw", driveDefinition([{ type: "tool/result", seq: 1, time: 1, data: null }]).node === null);

// --- degrade, never throw (client failure must not take the session down) ---
check("U15: a node with an unreadable payload renders NOTHING instead of throwing", [null, {}, { data: null }, { data: {} }, { data: { card: { kind: "team-link-send" } } }].every((node) => {
	try {
		return topSlot.component({ node, t: tZh }) === null;
	} catch {
		return false;
	}
}));
check("U15: the renderer stays total for a hostile getter too", (() => {
	try {
		return topSlot.component({ node: { get data() { throw new Error("hostile"); } }, t: tZh }) === null;
	} catch {
		return false;
	}
})());

// --- the degradation contract: a broken registry is "no top-level row" ------
// §10.1.5 降级优先: the uiConversation face is a newer public surface, so a shell
// whose registry refuses the definition (or lacks the service entirely) must
// cost the top-level card and NOTHING else — apply() must still complete, and
// the trace is one browser-console line (never a session-log event, §10.3).
/** Apply the bundle again against a fresh context and report what happened. */
function applyWith(overrides) {
	const fresh = [];
	const warnings = [];
	const context = {
		effect(fn) { const disposer = fn(); return typeof disposer === "function" ? disposer : () => {}; },
		locale: { register(_namespace, lang, dict) { localeDicts.set(lang, dict); return () => {}; }, bind() { return (key) => key; } },
		slots: {
			inject(_name, register) { return register(); },
			register(options, component) { fresh.push({ options, component }); return () => {}; },
			entries() { return []; },
		},
		sessions: { list: { getSnapshot() { return { byId: {} }; } }, open() {} },
		...overrides,
	};
	const realWarn = console.warn;
	console.warn = (...args) => warnings.push(args.map((value) => String(value)).join(" "));
	// The style tag is module-scope and already installed: keep the "injected
	// once" invariant true for these extra applies too.
	const realQuery = documentStub.querySelector;
	documentStub.querySelector = () => ({});
	let thrown = null;
	try {
		moduleExports.apply(context);
	} catch (error) {
		thrown = error;
	} finally {
		documentStub.querySelector = realQuery;
		console.warn = realWarn;
	}
	return { fresh, warnings, thrown, registered: registeredDefinition };
}

const refusing = applyWith({ inject(_specs, callback) { return callback({ uiConversation: { events: { register() { throw new Error("registry refused"); } } } }); } });
check("U15: a registry that REFUSES the definition does not throw out of apply()", refusing.thrown === null);
check("U15: ... it costs only the top-level card, and says so once in the browser console", refusing.warnings.length === 1 && refusing.warnings[0].includes("uiConversation.events.register") && refusing.warnings[0].includes("top-level message card stays off"));
check("U15: ... while every other registration still lands (the header strip, the tool row, both chat rows)", refusing.fresh.length === 4 && refusing.fresh.filter((entry) => entry.options.name === "conversation.chat.node").length === 2 && refusing.fresh.some((entry) => entry.options.name === "tool.call.toolview" && entry.options.key === "team_link_send"));
const serviceless = applyWith({ inject(_specs, callback) { return callback({}); } });
check("U15: a shell without the uiConversation service degrades silently — an older shell is not a failure", serviceless.thrown === null && serviceless.warnings.length === 0 && serviceless.fresh.length === 4);
const injectless = applyWith({ inject: undefined });
check("U15: a client context that cannot inject at all is still applied to completion", injectless.thrown === null && injectless.warnings.length === 0 && injectless.fresh.length === 4);
check("U15: the definition D's registry face is only reached through inject — the plugin never writes an event of its own", moduleExports.inject.join(",") === "slots,sessions,locale,uiConversation");

console.log("");
if (failures === 0) console.log("ALL PASS");
else console.log(`${failures} FAILURE(S)`);
console.log(`assertion total: ${assertions} (failed: ${failures})`);
process.exitCode = failures === 0 ? 0 : 1;