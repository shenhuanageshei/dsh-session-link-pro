// Unit smoke test for the dsh-session-link-pro browser half: loads the client
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
function check(label, cond) {
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
check("client bundle registers its module definition", definition !== null && definition.id === "dsh-session-link-pro");
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
const ctx = {
	effect(fn) { const disposer = fn(); return typeof disposer === "function" ? disposer : () => {}; },
	locale: { register() { return () => {}; }, bind() { return (key) => key; } },
	slots: {
		inject(_name, register) { return register(); },
		register(options, component) { registrations.push({ options, component }); return () => {}; },
		entries() { return []; },
	},
	sessions: { list: { getSnapshot() { return { byId: {} }; } }, open() {} },
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
const FOOTER = "（如需回复，可让本会话调用 session_link_pro_send 工具发回）";
const relayBody = (sessionId, when, payload) => [BANNER + sessionId + (when === undefined ? "" : ` · ${when}`) + "]", "", payload, "", FOOTER].join("\n");

// 1. pre-0.1.5 history: the retired kind, with its `sentAt` provenance.
const legacyWhen = "2026-01-02T03:04:05.000Z";
const legacy = render({
	source: { kind: "session-link-pro", plugin: "dsh-session-link-pro", fromSession: "session-a", senderSessionId: "session-a", form: "relay", sentAt: legacyWhen },
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
const poisonedLegacy = render({ source: { kind: "session-link-pro", fromSession: "session-p", sentAt: legacyWhen }, content: textOf([relayBody("session-p", undefined, "断开的\uD83D 负载")]) }, "slp-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
check("a lone surrogate in a legacy row body is repaired", !LONE.test(bodyTextOf(poisonedLegacy)));
check("the repaired legacy body keeps its text", bodyTextOf(poisonedLegacy).includes("断开的") && bodyTextOf(poisonedLegacy).includes("负载"));
// A SHORT (unshortened, <= 26 code units) id is returned verbatim by the
// shortener, so the repair has to sit on the rendered value, not only on the cut.
const rawHalfId = "session-\uD83Dq";
const poisonedRawId = render({ source: { kind: "session-link-pro", fromSession: rawHalfId, sentAt: legacyWhen }, content: textOf([relayBody(rawHalfId, undefined, "短 id 带半截")]) }, "slp-cccccccc-cccc-cccc-cccc-cccccccccccc");
check("a short poisoned sender id is repaired", rawHalfId.length <= 26 && !LONE.test(spanText(headSpan(poisonedRawId, "dshsl-relay-sender"))));
// The delegation fallback renders OTHER plugins' context text — still this file's
// output, so it goes through the same repair.
const foreignHalf = render({ source: { kind: "plugin", plugin: "other-plugin", form: "notice" }, content: textOf(["外来的\uD83D 半截文本"]) }, "node-9");
check("a lone surrogate in delegated foreign context is repaired", isDelegated(foreignHalf) && !LONE.test(delegatedTextOf(foreignHalf)));
check("the delegated foreign text is otherwise untouched", delegatedTextOf(foreignHalf).includes("半截文本"));

console.log("");
if (failures === 0) console.log("ALL PASS");
else console.log(`${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
