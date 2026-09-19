// dsh-team-link — browser half (client bundle).
//
// Rendered in the web shell as a static client package (`dsh.client`
// declaration in package.json; served by dsh-client-modules at
// /plugins/dsh-team-link/client.js). Upstream affordances kept in
// full:
//  1. a "copy session link" button in the conversation header action strip,
//     copying `dsh://session/<sessionId>` — the same link the host half
//     understands when pasted into any conversation; and
//  2. the deep-link opener: when the page boots at `/s/<sessionId>`, select
//     that session once the session list has loaded.
// New in -pro:
//  3. an "export session" button in the same action strip, downloading the
//     readable markdown rendering of the current conversation through the
//     host half's /team-link/export web route; and
//  4. the relay card: cross-session messages this session RECEIVED, rendered as
//     a bordered card instead of a folded grey context line (keyed
//     `conversation.chat.node` on `key: "context"`, priority -100).
// New in the §10.1 A/D round (collab-enhancements design) — the SENDER's side:
//  5. A: `tool.call.toolview` keyed `team_link_send`, so this session's own tool
//     row renders the §10.1.2 receipt as the same card; without a receipt
//     (running / no meta / unreadable meta) it falls back to the model-visible
//     text. The audit record stays where it was, at the tool call itself.
//     A also reads the host half's `targetsTruncated: {shown,total}` mark: the
//     host caps `targets` at 24 rows as it writes the receipt, so counting the
//     rows here could never see a host-produced card as truncated — the mark is
//     what makes the cut visible on A, and `total` is the number the label owes.
//  6. D: a top-level node for the same call, produced by this plugin's own
//     `uiConversation.events` definition matching the EXISTING `tool/call` +
//     `tool/result` events, rendered by a same-kind `conversation.chat.node`
//     entry. No session-log event is written, and the model context is untouched:
//     visibility is added on the client only.
window.__ModuleLoader__.load({
	id: "dsh-team-link",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");

		// --- styles (module scope, mirroring compiled client bundles) ---
		const CSS_ID = "dsh-team-link/client.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_ID) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-team-link";
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = [
				".dshsl-copy{display:grid;place-items:center;width:28px;height:28px;flex:none;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:14px;line-height:1;padding:0}",
				".dshsl-copy:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
				".dshsl-copy:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}",
				".dshsl-copy[data-copied=\"true\"]{color:var(--dsw-alias-state-success-primary)}"
,
				".dshsl-relay{margin:8px 0;border:1px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-alias-state-business-primary);border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);padding:10px 12px}",
				".dshsl-relay-head{display:flex;align-items:center;gap:8px;min-width:0;font-size:12px;color:var(--dsw-alias-state-business-primary);font-weight:600}",
				".dshsl-relay-when{margin-left:auto;flex:none;color:var(--dsw-alias-label-tertiary);font-weight:400;font-size:11px}",
				".dshsl-relay-sender{color:var(--dsw-alias-label-secondary);font-weight:400;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;min-width:0;max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				".dshsl-relay-body{margin-top:8px;font-size:13px;line-height:1.65;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}",
				".dshsl-relay-foot{margin-top:6px;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
				// §10.1 sender-side cards: the same card, accent flipped to the
				// outbound side, plus the pieces only a receipt has.
				".dshsl-send{border-left-color:var(--dsw-alias-state-success-primary)}",
				".dshsl-send-env{margin-left:6px;color:var(--dsw-alias-label-tertiary);font-weight:400;font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}",
				".dshsl-send-trunc{color:var(--dsw-alias-label-tertiary);font-size:11px}",
				".dshsl-send-targets{margin-top:8px;display:flex;flex-direction:column;gap:3px}",
				".dshsl-send-rowhead{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
				".dshsl-send-target{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}",
				".dshsl-send-targetid{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:600;color:var(--dsw-alias-label-primary)}",
				".dshsl-send-outcome{flex:none;font-weight:600;color:var(--dsw-alias-label-primary)}",
				".dshsl-send-outcome[data-outcome=\"refused\"],.dshsl-send-outcome[data-outcome=\"no-agent\"],.dshsl-send-outcome[data-outcome=\"no-holder\"]{color:var(--dsw-alias-state-warn-primary)}",
				".dshsl-send-summary{margin-top:8px;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
				".dshsl-send-rows-trunc{margin-top:4px;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
				".dshsl-plain{margin:4px 0;padding:6px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);font-size:12px;color:var(--dsw-alias-label-secondary)}",
				".dshsl-plain-head{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:11px}",
				".dshsl-plain-body{margin-top:6px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}"
			].join("");
			document.head.appendChild(tag);
		}

		// --- link + route builders ---
		/** `dsh://` deep link for one session id — the format the copy button emits and
		 * the host half resolves when it is pasted back into any conversation. */
		function dshDeepLink(sessionId) {
			return "dsh://session/" + encodeURIComponent(sessionId);
		}
		/** Host-half export route for one session id (markdown download). */
		function exportUrl(sessionId) {
			return "/team-link/export?session=" + encodeURIComponent(sessionId) + "&format=md";
		}

		// --- copy fallback for non-secure contexts ---
		function fallbackCopy(text) {
			try {
				const ta = document.createElement("textarea");
				ta.value = text;
				ta.setAttribute("readonly", "");
				ta.style.position = "fixed";
				ta.style.opacity = "0";
				document.body.appendChild(ta);
				ta.select();
				document.execCommand("copy");
				document.body.removeChild(ta);
				return true;
			} catch {
				return false;
			}
		}

		// --- the copy button (upstream, unchanged behavior) ---
		function CopySessionLinkButton({ sessionId, t }) {
			const [copied, setCopied] = React.useState(false);
			const copy = React.useCallback(() => {
				const link = dshDeepLink(sessionId);
				const flash = () => {
					setCopied(true);
					window.setTimeout(() => setCopied(false), 1600);
				};
				if (navigator.clipboard !== void 0 && window.isSecureContext === true) {
					navigator.clipboard.writeText(link).then(flash, () => {
						if (fallbackCopy(link)) flash();
					});
				} else if (fallbackCopy(link)) flash();
			}, [sessionId]);
			const label = copied ? t("copied") : t("copyLink");
			return React.createElement("button", {
				type: "button",
				className: "dshsl-copy",
				"data-copied": copied ? "true" : "false",
				title: label,
				"aria-label": label,
				onClick: copy
			}, copied ? "\u2713" : "\uD83D\uDD17");
		}

		// --- the export button (new in -pro): markdown download via host route ---
		function ExportSessionButton({ sessionId, t }) {
			const label = t("exportSession");
			const download = React.useCallback(() => {
				try {
					const anchor = document.createElement("a");
					anchor.href = exportUrl(sessionId);
					anchor.rel = "noopener";
					document.body.appendChild(anchor);
					anchor.click();
					anchor.remove();
				} catch {
					window.open(exportUrl(sessionId), "_blank", "noopener");
				}
			}, [sessionId]);
			return React.createElement("button", {
				type: "button",
				className: "dshsl-copy",
				title: label,
				"aria-label": label,
				onClick: download
			}, "\u2B07");
		}

		// --- header action strip: copy + export side by side ---
		function HeaderActions({ sessionId, t }) {
			return React.createElement(React.Fragment, null,
				React.createElement(CopySessionLinkButton, { sessionId: sessionId, t: t }),
				React.createElement(ExportSessionButton, { sessionId: sessionId, t: t }));
		}

		// --- deep-link opener: /s/<sessionId> selects that session at boot ---
		function openDeepLinkedSession(ctx) {
			const match = window.location.pathname.match(/^\/s\/([^/]+)$/);
			if (match === null) return;
			let id;
			try {
				id = decodeURIComponent(match[1]);
			} catch {
				return;
			}
			if (typeof id !== "string" || id.length === 0) return;
			let tries = 0;
			const attempt = () => {
				if (tries >= 50) return;
				tries += 1;
				let snapshot = null;
				try {
					snapshot = ctx.sessions.list.getSnapshot();
				} catch {
					/* sessions service not ready yet — retry */
				}
				if (snapshot !== null && snapshot.byId !== void 0 && Object.prototype.hasOwnProperty.call(snapshot.byId, id)) {
					try {
						ctx.sessions.open(id);
					} catch {
						/* selection failed — leave the app on its default view */
					}
					return;
				}
				window.setTimeout(attempt, 200);
			};
			attempt();
		}

		// --- relay card (new in -pro): prominent rendering for cross-session messages ---
		// Registered on the keyed "conversation.chat.node" slot at priority -100 so it
		// shadows the chat package's default context renderer (lowest priority renders).
		// Non-relay context messages are delegated back to the shadowed chat renderer.

		var CHAT_NODE_SLOT = "conversation.chat.node";
		var RELAY_PRIORITY = -100;

		/**
		 * Lone-surrogate repair for anything this half puts on screen. `String.prototype.toWellFormed`
		 * is native on current browsers; the regex is the fallback. A DOM text node
		 * would repair a lone surrogate anyway (USVString conversion maps it to
		 * U+FFFD), but doing it here keeps the invariant true of what this file
		 * PRODUCES rather than of what the DOM silently fixes.
		 */
		var LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
		function wellFormed(value) {
			var text = typeof value === "string" ? value : String(value === null || value === undefined ? "" : value);
			return typeof text.toWellFormed === "function" ? text.toWellFormed() : text.replace(LONE_SURROGATE, "\uFFFD");
		}

		/**
		 * Short display form for a session id (keeps head and tail visible). Cuts on
		 * code-point boundaries only: `slice(0, 14)` can keep a trailing HIGH
		 * surrogate and `slice(-8)` can start on a LOW one when a pair straddles
		 * either index. This path is display-only — a DOM text node goes through the
		 * browser's USVString conversion, which maps a lone surrogate to U+FFFD, and
		 * the string never re-enters a model request — so the old form was
		 * cosmetically wrong rather than session-killing. Note the cheap
		 * `id.length` guard stays a code-unit check on purpose: it only decides
		 * whether to shorten at all, and the cut itself is what must be codepoint-safe.
		 */
		function shortSessionId(id) {
			if (typeof id !== "string" || id.length <= 26) return String(id);
			var chars = Array.from(id);
			return chars.slice(0, 14).join("") + "…" + chars.slice(-8).join("");
		}

		/** Drop the host-side banner wrapper lines the card already surfaces itself. */
		function stripRelayWrapper(text) {
			var out = typeof text === "string" ? text : "";
			if (out.indexOf("📨") === 0) {
				var nl = out.indexOf("\n");
				if (nl !== -1 && out.slice(0, nl).indexOf("[跨会话消息") !== -1) out = out.slice(nl + 1);
			}
			var at = out.lastIndexOf("（如需回复");
			if (at !== -1) out = out.slice(0, at);
			return out.trim();
		}

		/** True when a node carries this plugin's own relay banner (id-less fallback). */
		function hasRelayBanner(text) {
			if (typeof text !== "string" || text.indexOf("📨") !== 0) return false;
			var nl = text.indexOf("\n");
			return (nl === -1 ? text : text.slice(0, nl)).indexOf("[跨会话消息") !== -1;
		}

		/**
		 * Delivery time of one relay, as the host half wrote it into the banner head
		 * (`… · YYYY-MM-DD HH:mm:ss]`). `source` cannot carry it: the migration admits
		 * exactly `{kind, form, senderSessionId}`. The stamp is anchored to the end of
		 * the head line — a session title that happens to look like a date sits earlier
		 * on that line and must not win. Parsed field by field so the stamp keeps
		 * meaning the local time of the machine that sent it.
		 *
		 * R7 (M3 review): since 0.3.3 the head line may carry the §3.4 envelope AFTER
		 * the stamp (`… 23:42:05 · type=ruling pri=P0 ref=slp-a1b2]`), so the stamp is
		 * followed either by the closing bracket or by ` · <fields>` and then the
		 * bracket. It is NOT allowed to be followed by arbitrary text: the date-like
		 * title above still loses, which is what the anchoring buys.
		 */
		function relayStampOf(text) {
			if (typeof text !== "string") return "";
			var nl = text.indexOf("\n");
			var head = nl === -1 ? text : text.slice(0, nl);
			var match = /(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?: · [^\n\]]*)?\]\s*$/.exec(head);
			if (match === null) return "";
			var when = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
			return isNaN(when.valueOf()) ? "" : when.toLocaleString();
		}

		/** Render non-relay context nodes through the chat package's own renderer. */
		function delegateContextNode(ctx, props) {
			try {
				var entries = ctx.slots.entries(CHAT_NODE_SLOT);
				var fallback = null;
				for (var i = 0; i < entries.length; i += 1) {
					var entry = entries[i];
					var priority = (entry.options && entry.options.priority) || 0;
					if (entry.options && entry.options.key === "context" && priority > RELAY_PRIORITY) { fallback = entry; break; }
				}
				if (fallback !== null && fallback.component != null) {
					var chatT = ctx.locale && typeof ctx.locale.bind === "function" ? ctx.locale.bind("chat") : props.t;
					var forwarded = Object.assign({}, props, { t: chatT });
					return React.createElement(fallback.component, forwarded);
				}
			} catch (e) {
				/* fall through to the plain rendering below */
			}
			var data = props.node && props.node.data;
			var blocks = Array.isArray(data && data.content) ? data.content : [];
			var plain = blocks.filter(function (b) { return b && b.type === "text" && typeof b.text === "string"; }).map(function (b) { return b.text; }).join("\n");
			// Other plugins' context text is not ours, but this file still puts it on
			// screen — repaired for the same reason as the relay body below.
			return React.createElement("div", { style: { fontSize: "11px", opacity: 0.7, whiteSpace: "pre-wrap" } }, wellFormed(plain));
		}

		// --- §10.1 A: the sender's OWN tool row, rendered from the receipt ------
		// The receiver's card above renders a context message; this half renders
		// `team_link_send` itself, so the audit record stops being a grey
		// third-level line inside the collapsed tool tree. The card's data is the
		// §10.1.2 receipt the host half persists as `tool/result.meta` — never a
		// parse of the result text, so a wording change cannot break the render.

		/** ⚠ The slot key must be the WIRE TOOL NAME, verbatim: the dispatch is a
		 * plain keyed lookup and a typo silently falls back to the generic tool
		 * row — no error anywhere (slot contract: "a typo simply never renders").
		 * U14 pins this literal. */
		var SEND_TOOL_KEY = "team_link_send";
		/** §10.1.2 card discriminator, shared by the receipt reader and the D node. */
		var SEND_CARD_KIND = "team-link-send";
		/** §10.1.5 A draws ONE row per target, and that count is NOT bounded by the
		 * host's fan-out cap: `resolveTargetList` caps the INPUT expressions at 8,
		 * but a single `team:<name>/*` entry expands to every filled live role
		 * (`resolveTargets`) — so a legal broadcast can carry more rows than 8. The
		 * DISPLAY is therefore bounded here, at the size of the design's own
		 * per-team member cap (§10.2.4 每队成员总数 ≤24: one full-team broadcast
		 * still renders whole), and a receipt past it says so on the card instead of
		 * drawing unbounded rows (round-1 🔵 #2).
		 *
		 * This is the SECOND half of the §10.1.2 row contract, not the only one:
		 * the host half caps its own rows at this same 24 as it writes them and
		 * states the cut as `targetsTruncated: { shown, total }`, so a host-produced
		 * card arrives exactly AT this bound and a count of `card.targets` can never
		 * see it as truncated. What is left for this half is what the comments below
		 * call the defensive path: the receipt is core-opaque and persisted, so a
		 * hand-edited log or a heterogeneous implementation can carry any number of
		 * rows at all. Both halves meet in `SendCardView`, which raises the note for
		 * either source (A owns the rows, so A owns the note — §10.1.5). */
		var SEND_CARD_ROW_LIMIT = 24;

		/** Render `{name}` placeholders of a locale template (no plural rules are
		 * needed for the handful of numeric fields a receipt has). */
		function fillTemplate(template, values) {
			var out = String(template);
			for (var key in values) {
				if (Object.prototype.hasOwnProperty.call(values, key)) out = out.split("{" + key + "}").join(String(values[key]));
			}
			return out;
		}

		/** A counter of the receipt's `summary`, as a displayable number. */
		function countOf(value) {
			return typeof value === "number" && isFinite(value) ? value : 0;
		}

		/** §10.1.2 outcome → localized label; an unknown token is shown as-is
		 * rather than swallowed (a newer host may send a bucket this build does
		 * not know). */
		function outcomeLabel(t, outcome) {
			if (outcome === "delivered") return t("outcomeDelivered");
			if (outcome === "refused") return t("outcomeRefused");
			if (outcome === "no-agent") return t("outcomeNoAgent");
			if (outcome === "no-holder") return t("outcomeNoHolder");
			return wellFormed(String(outcome));
		}

		/**
		 * The host half's row-cut mark of §10.1.2 (`targetsTruncated: {shown,total}`),
		 * normalized — or `undefined` when there is nothing readable to read.
		 *
		 * The host half caps `targets` at `SEND_CARD_ROW_LIMIT` ROWS before it writes
		 * the receipt, and that cut is invisible to a client that only counts rows
		 * (the rows arrive exactly at the bound). The mark is the fact that survives
		 * it: `total` is how many targets the delivery really had, `shown` is how
		 * many of them the receipt carries. Without this read a host-produced card
		 * for a 30-target broadcast would state 24 targets and draw no truncation
		 * note at all (the cross-round gap U14 pins).
		 *
		 * It is an OPTIONAL member of a core-opaque, persisted payload, so it gets
		 * the same treatment as `meta` in the reader below — an unreadable shape is
		 * DROPPED rather than allowed to reject the whole card (the card still
		 * renders from its rows, and `SendCardView` still bounds them). Both members
		 * are display facts, so a non-finite one makes the mark unreadable: nothing
		 * else in this reader coerces either, and a coerced number would be a number
		 * the receipt never stated.
		 */
		function readTargetsTruncated(value) {
			if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return undefined;
			if (typeof value.shown !== "number" || !isFinite(value.shown)) return undefined;
			if (typeof value.total !== "number" || !isFinite(value.total)) return undefined;
			return { shown: value.shown, total: value.total };
		}

		/**
		 * Shape reader for the §10.1.2 receipt. Returns `null` — never a partial
		 * card — the moment anything does not match, so every degradation lands on
		 * the same plain fallback. `meta` is core-opaque: it may come from another
		 * tool, an older or newer build, or a hand-edited log, so nothing in it is
		 * trusted. The read is total: a hostile getter cannot make it throw. The
		 * number of rows the receipt may DRAW is a separate, render-time concern
		 * (`SEND_CARD_ROW_LIMIT`): the reader keeps the receipt whole so the label's
		 * target count stays the honest total — and keeps the host's own
		 * `targetsTruncated` mark for the same reason, since a receipt the host half
		 * already cut must still be able to say so.
		 */
		function readSendCard(value) {
			try {
				if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
				if (value.kind !== SEND_CARD_KIND || value.v !== 1) return null;
				if (typeof value.at !== "number" || !isFinite(value.at)) return null;
				if (typeof value.senderSessionId !== "string" || value.senderSessionId === "") return null;
				var message = value.message;
				if (message === null || typeof message !== "object") return null;
				if (typeof message.text !== "string" || typeof message.chars !== "number") return null;
				if (!Array.isArray(value.targets)) return null;
				var targets = [];
				for (var i = 0; i < value.targets.length; i += 1) {
					var row = value.targets[i];
					if (row === null || typeof row !== "object" || Array.isArray(row)) return null;
					if (typeof row.outcome !== "string" || typeof row.detail !== "string") return null;
					if (row.sessionId !== null && typeof row.sessionId !== "string") return null;
					targets.push(row);
				}
				var summary = value.summary;
				if (summary === null || typeof summary !== "object") return null;
				return {
					kind: SEND_CARD_KIND,
					v: 1,
					at: value.at,
					senderSessionId: value.senderSessionId,
					meta: value.meta !== null && typeof value.meta === "object" && !Array.isArray(value.meta) ? value.meta : undefined,
					message: { text: message.text, truncated: message.truncated === true, chars: message.chars },
					targets: targets,
					targetsTruncated: readTargetsTruncated(value.targetsTruncated),
					summary: summary,
					fanout: value.fanout === true
				};
			} catch (e) {
				return null;
			}
		}

		/** The §3.4 envelope of the card, as the banner's compact `k=v` fields. */
		function envelopeFields(meta) {
			if (meta === null || meta === undefined) return "";
			var parts = [];
			if (typeof meta.type === "string") parts.push("type=" + meta.type);
			if (typeof meta.pri === "string") parts.push("pri=" + meta.pri);
			if (typeof meta.ref === "string") parts.push("ref=" + meta.ref);
			return parts.join(" ");
		}

		/** One target's §10.1.2 busy prediction, or null when it has none. */
		function busyNote(target, t) {
			var busy = target.busy;
			if (busy === null || typeof busy !== "object" || busy.running !== true) return null;
			return typeof busy.minutes === "number" && isFinite(busy.minutes)
				? fillTemplate(t("sendBusyMinutes"), { minutes: busy.minutes })
				: t("sendBusyUnknown");
		}

		/** Head line of D (`dshsl-send` top face): title, sender, delivery time. */
		function sendCardHead(card, t) {
			var when = new Date(card.at);
			var whenText = isNaN(when.valueOf()) ? "" : when.toLocaleString();
			var envelope = envelopeFields(card.meta);
			return React.createElement("div", { className: "dshsl-relay-head" },
				"\uD83D\uDCE4 ",
				t("sendTitle"),
				React.createElement("span", { className: "dshsl-relay-sender", title: wellFormed(card.senderSessionId) }, wellFormed(shortSessionId(card.senderSessionId))),
				envelope !== "" ? React.createElement("span", { className: "dshsl-send-env" }, envelope) : null,
				whenText !== "" ? React.createElement("span", { className: "dshsl-relay-when" }, whenText) : null);
		}

		/** D's body, with the §10.1.2 truncation stated on the card. */
		function sendCardBody(card, t) {
			return React.createElement("div", { className: "dshsl-relay-body" },
				wellFormed(card.message.text) || t("relayEmpty"),
				card.message.truncated === true
					? React.createElement("span", { className: "dshsl-send-trunc" }, " " + fillTemplate(t("sendTruncated"), { chars: countOf(card.message.chars) }))
					: null);
		}

		/** D's summary line: the counts every receipt carries, plus dedupe when > 0. */
		function sendCardSummary(card, t) {
			var summary = card.summary || {};
			var text = fillTemplate(t("sendSummary"), {
				delivered: countOf(summary.delivered),
				refused: countOf(summary.refused),
				noAgent: countOf(summary.noAgent),
				noHolder: countOf(summary.noHolder)
			});
			if (countOf(summary.deduped) > 0) text = text + " · " + fillTemplate(t("sendDeduped"), { deduped: countOf(summary.deduped) });
			return text;
		}

		/**
		 * The number of targets A's label states (§10.1.2 「标签显示真值总数」): the
		 * delivery's real row count, NEVER the number of rows drawn.
		 *
		 * Which one that is depends on who cut the rows:
		 *   - a receipt from this plugin's host half carries the host's
		 *     `targetsTruncated` mark when — and only when — the host cut it, and
		 *     `total` is then how many targets the delivery really had (the host
		 *     counts every resolved target before it cuts the rows, `lib/index.js`
		 *     `buildSendCard`). Counting `card.targets` here would print 24 for a
		 *     30-target broadcast;
		 *   - a receipt WITHOUT the mark carries every row it knows about (that
		 *     includes a hand-edited log whose rows are over the limit), so its
		 *     length IS the total — the render-time row bound below is a bound on
		 *     what is DRAWN, and must not turn into a wrong number in the label.
		 */
		function sendCardTargetTotal(card) {
			var mark = card.targetsTruncated;
			return mark === undefined ? card.targets.length : mark.total;
		}

		/** A's minimal label (§10.1.5 A): the wire tool name and the target count —
		 * no title, no time, no body, no summary. Those are D's, and each of them
		 * is rendered on exactly ONE of the two faces. The count is the TRUE total
		 * (`sendCardTargetTotal`), not the number of rows drawn. */
		function sendCardRowLabel(card, toolName, t) {
			return React.createElement("div", { className: "dshsl-send-rowhead" },
				"\u2726 ",
				t("sendPlainTitle"),
				" · ",
				wellFormed(toolName === undefined || toolName === null ? SEND_TOOL_KEY : String(toolName)),
				" · ",
				fillTemplate(t("sendRowTargets"), { count: sendCardTargetTotal(card) }));
		}

		/** One target as A's row names it (§10.1.5: 「目标（`expr` 或短 id）」): the
		 * id in its short display form, plus the addressing expression it came from
		 * when that is something else — the shape the host half's report line
		 * builds (`targetLabel`), with the id shortened the way the receiver's card
		 * shortens a sender. A `no-holder` row has no id, so its expression IS the
		 * target. */
		function targetIdentity(target) {
			if (target.sessionId !== null && target.sessionId !== undefined) {
				var id = wellFormed(shortSessionId(target.sessionId));
				return target.expr !== undefined ? id + "（via " + wellFormed(target.expr) + "）" : id;
			}
			return target.expr !== undefined ? wellFormed(target.expr) : "\u2014";
		}

		/**
		 * §10.1 sender-side card, in the two shapes §10.1.5 splits ("每一块信息
		 * 只准出现一次"). The faces carry DISJOINT blocks, not the same blocks
		 * twice:
		 *   - `detail === true` is A, the tool row: the minimal label (tool name +
		 *     TRUE target count) plus one row per target (target + outcome +
		 *     detail + §3.5 busy) — and nothing else; the rows are capped at
		 *     `SEND_CARD_ROW_LIMIT`, and a receipt that is over the cap — the
		 *     host's own `targetsTruncated` mark, or a foreign/hand-edited one the
		 *     render-time bound catches — states the truncation on A (the face that
		 *     owns the rows);
		 *   - `detail === false` is D, the top-level node: title + sender/time +
		 *     body + summary counts — and no per-target row.
		 * U14/U15 assert the split structurally and assert that no statement of
		 * one face occurs anywhere in the other.
		 */
		function SendCardView(props) {
			var card = props.card;
			var detail = props.detail === true;
			var t = typeof props.t === "function" ? props.t : function (key) { return key; };
			if (detail) {
				// The rows are bounded HERE as well as on the host half, and the note
				// is raised for either source (§10.1.5 A owns the per-target rows, so
				// the note lives on A and nowhere else):
				//  - `meta` is core-opaque and persisted, so a hand-edited log or a
				//    heterogeneous implementation can carry any number of rows at all
				//    — this is the defence for those (round-1 🔵 #2);
				//  - a receipt from THIS plugin's host half arrives already cut, at
				//    exactly this same limit, so counting the rows can never see it
				//    as truncated. Its `targetsTruncated` mark is the only carrier of
				//    that fact, and without it a 30-target broadcast would show no
				//    truncation at all (the cross-round gap U14 pins).
				// The number in 「仅显示前 N 行」 is what is DRAWN, never a count the
				// mark merely asserts: the sentence has to stay true of the card it
				// is on even when the mark was hand-edited.
				var overflow = card.targets.length > SEND_CARD_ROW_LIMIT;
				var shown = overflow ? card.targets.slice(0, SEND_CARD_ROW_LIMIT) : card.targets;
				var rows = shown.map(function (target, index) {
					var note = busyNote(target, t);
					return React.createElement("div", { className: "dshsl-send-target", key: "target-" + index },
						React.createElement("span", { className: "dshsl-send-targetid" }, targetIdentity(target)),
						" ",
						React.createElement("span", { className: "dshsl-send-outcome", "data-outcome": target.outcome }, outcomeLabel(t, target.outcome)),
						" ",
						wellFormed(target.detail),
						note !== null ? React.createElement("span", { className: "dshsl-send-trunc" }, " " + note) : null);
				});
				var truncated = overflow || card.targetsTruncated !== undefined;
				return React.createElement("div", { className: "dshsl-relay dshsl-send", "data-slp-send": "row" },
					sendCardRowLabel(card, props.toolName, t),
					React.createElement("div", { className: "dshsl-send-targets" }, rows),
					truncated ? React.createElement("div", { className: "dshsl-send-rows-trunc" }, fillTemplate(t("sendRowsTruncated"), { shown: shown.length })) : null);
			}
			return React.createElement("div", { className: "dshsl-relay dshsl-send", "data-slp-send": "top" },
				sendCardHead(card, t),
				sendCardBody(card, t),
				React.createElement("div", { className: "dshsl-send-summary" }, sendCardSummary(card, t)));
		}

		/** Model-visible text of a settled tool block (what the fallback shows). */
		function blockText(block) {
			var content = block !== null && block !== undefined && Array.isArray(block.content) ? block.content : [];
			return content
				.filter(function (part) { return part !== null && part !== undefined && part.type === "text" && typeof part.text === "string"; })
				.map(function (part) { return part.text; })
				.join("\n");
		}

		/**
		 * Degradation shape of A (§10.1.1): the row the sender sees when there is
		 * no receipt to draw a card from — an in-flight call, a call whose result
		 * carries no `meta` (every log written before §10.1), or a `meta` this
		 * build cannot read. It states the call and shows the model-visible result
		 * verbatim, so the fallback is the generic row's information, never a
		 * half-drawn card.
		 */
		function PlainSendRow(props) {
			var t = typeof props.t === "function" ? props.t : function (key) { return key; };
			var block = props.block;
			var settled = block !== null && block !== undefined && block.kind === "tool-result";
			var text = settled ? blockText(block) : "";
			return React.createElement("div", { className: "dshsl-plain", "data-slp-send": "plain" },
				React.createElement("div", { className: "dshsl-plain-head" },
					"\u2726 ",
					t("sendPlainTitle"),
					" · ",
					wellFormed(String(props.toolName === undefined ? SEND_TOOL_KEY : props.toolName)),
					" · ",
					settled ? t("sendPlainSettled") : t("sendPlainRunning")),
				text !== "" ? React.createElement("div", { className: "dshsl-plain-body" }, wellFormed(text)) : null);
		}

		/**
		 * §10.1.1 A. The receipt is read from the settled block's `meta`; anything
		 * else — running, no meta, an unreadable meta, a foreign shape — renders
		 * the plain row. This function never throws: a renderer that dies takes
		 * the whole transcript down with it (§10.1.5 降级优先).
		 */
		function SendToolCallView(props) {
			var card = null;
			try {
				var block = props.block;
				if (block !== null && block !== undefined && block.kind === "tool-result") card = readSendCard(block.meta);
			} catch (e) {
				card = null;
			}
			return card === null
				? React.createElement(PlainSendRow, props)
				: React.createElement(SendCardView, { card: card, detail: true, toolName: props.toolName, t: props.t });
		}

		// --- §10.1.3 D: the same send as a TOP-LEVEL conversation node ---------
		// A: the audit record at the tool call itself; D: a top-level node so the
		// send is visible without expanding the tool tree. D adds NO session-log
		// event (a new event type is forbidden, §10.3): it is a client-side
		// `uiConversation` definition matching the EXISTING `tool/call` and
		// `tool/result` events, plus a same-kind `conversation.chat.node` entry.
		//
		// H2 (design §10.5) — resolved from source: the chat package's
		// `chatNode` / `contextLocation` helpers are MODULE-LOCAL
		// (`dsh-client-ui-chat/lib/client.js` defines them at 4158/4170 and exports
		// only {EMPTY_CHAT_SNAPSHOT, apply, inject, isRunningTool, isSettledTool} at
		// 8398-8402), and the conversation service documents that cross-plugin value
		// imports are forbidden in client bundles. So the helpers are unreachable and
		// this takes the design's documented fallback: the node literal is built by
		// hand against the PUBLIC shape of ChatConversationViewNode
		// (`{key, kind, id, target, anchorSeq, location, visibility, data}`), with
		// `location`/`anchorSeq` derived exactly the way `chatNode` derives them.
		// The second half of H2 (does `events.register` accept an EXTERNAL
		// definition?) is answered by the registry source: it keys definitions by
		// `definition.kind` alone and throws only on a duplicate kind — no package
		// restriction — and `team-link-send` is claimed by nobody in the shipped
		// packages.

		/** Sequenced number of an event, or 0 when the log carries none. */
		function eventSeq(event) {
			return event !== null && event !== undefined && typeof event.seq === "number" && isFinite(event.seq) ? event.seq : 0;
		}
		/** Unix ms of an event, or 0. */
		function eventTime(event) {
			return event !== null && event !== undefined && typeof event.time === "number" && isFinite(event.time) ? event.time : 0;
		}
		/** The `data` of an event, or null. */
		function eventData(event) {
			return event !== null && event !== undefined && event.data !== null && typeof event.data === "object" ? event.data : null;
		}
		/** Call id of a `tool/result` event — the same field the chat package pairs
		 * its own tool tree on (`data.message.source.callId`). */
		function toolResultCallId(event) {
			const data = eventData(event);
			const message = data === null ? null : data.message;
			const source = message === null || message === undefined ? null : message.source;
			const callId = source === null || source === undefined ? undefined : source.callId;
			return typeof callId === "string" && callId !== "" ? callId : null;
		}

		/** The receipt carried by a `tool/result` event, or null. */
		function resultCardOf(event) {
			const data = eventData(event);
			return data === null ? null : readSendCard(data.meta);
		}

		/**
		 * Window-truncation fallback (design §10.1.5): `tool/call` scrolled out of
		 * the loaded history, so only `tool/result` events remain. The receipt IS the
		 * identification then — and it is the ONLY one available: a result's `source`
		 * is exactly `{kind, callId}` (`dsh-llm` message.d.ts), so the wire carries no
		 * tool name to attribute an orphaned result by. A result whose `meta` is not
		 * our card is therefore not ours.
		 */
		function sendStateFromMatches(context) {
			const matches = context !== null && context !== undefined && Array.isArray(context.matches) ? context.matches : [];
			for (let index = 0; index < matches.length; index += 1) {
				const event = matches[index] === null || matches[index] === undefined ? undefined : matches[index].event;
				if (event === null || event === undefined || event.type !== "tool/result") continue;
				const card = resultCardOf(event);
				if (card === null) continue;
				return { callId: toolResultCallId(event), seq: eventSeq(event), time: eventTime(event), card: card };
			}
			return null;
		}

		/**
		 * This plugin's Conversation business Definition (design §10.1.3).
		 *
		 * `match` claims ONLY existing event types: a `tool/call` whose wire name is
		 * this plugin's tool (as the start) and a `tool/result` carrying one of our
		 * receipts (as an update). Gating the result on the receipt rather than on
		 * its call id is deliberate: an unmatched result simply never becomes a node
		 * (a result without a receipt has nothing to draw), while matching every
		 * tool result would create an engine Context for every tool call in every
		 * session. A result whose `tool/call` fell outside the window still creates
		 * its Context here — that is the rebuild path above.
		 */
		var sendNodeDefinition = {
			kind: SEND_CARD_KIND,
			target: "chat",
			match: function (event) {
				try {
					if (event === null || typeof event !== "object") return null;
					if (event.type === "tool/call") {
						const data = eventData(event);
						if (data === null || data.name !== SEND_TOOL_KEY) return null;
						return typeof data.callId === "string" && data.callId !== "" ? { id: data.callId, role: "start" } : null;
					}
					if (event.type === "tool/result") {
						if (resultCardOf(event) === null) return null;
						const callId = toolResultCallId(event);
						return callId === null ? null : { id: callId, role: "update" };
					}
					// Everything else — including every event type this plugin has
					// nothing to say about — is not claimed.
					return null;
				} catch (e) {
					return null;
				}
			},
			start: function (_context, match) {
				const event = match === null || match === undefined ? undefined : match.event;
				const data = eventData(event);
				return {
					callId: data === null ? undefined : data.callId,
					seq: eventSeq(event),
					time: eventTime(event),
					card: null
				};
			},
			update: function (context, match) {
				const event = match === null || match === undefined ? undefined : match.event;
				const card = resultCardOf(event);
				if (card === null) return context.state;
				return { callId: toolResultCallId(event), seq: eventSeq(event), time: eventTime(event), card: card };
			},
			buildViewNode: function (context) {
				// A definition that throws (or returns a malformed node) must never
				// reach further than "this row does not render" (§10.1.5).
				try {
					const state = context !== null && context !== undefined && context.state !== null && typeof context.state === "object" ? context.state : sendStateFromMatches(context);
					if (state === null || state === undefined) return null;
					const card = readSendCard(state.card);
					if (card === null) return null;
					const start = context.start === null || context.start === undefined ? null : context.start;
					const startEvent = start === null ? null : start.event;
					const first = Array.isArray(context.matches) && context.matches.length > 0 ? context.matches[0] : undefined;
					const anchor = startEvent !== null ? eventSeq(startEvent) : state.seq !== undefined ? state.seq : first !== undefined && first !== null ? eventSeq(first.event) : 0;
					const location = start !== null && start.location !== undefined ? start.location : first !== undefined && first !== null && first.location !== undefined ? first.location : { kind: "unresolved" };
					// The literal `chatNode` builds (see the H2 note above).
					return {
						key: context.key,
						kind: SEND_CARD_KIND,
						id: context.id,
						target: "chat",
						anchorSeq: anchor,
						location: location,
						visibility: "visible",
						data: { kind: SEND_CARD_KIND, callId: state.callId, at: state.time, card: card }
					};
				} catch (e) {
					return null;
				}
			}
		};

		/**
		 * §10.1.3 D's renderer. It draws the SUMMARY face of the card — the title,
		 * the sender and the time, the body and the result counts — while the tool
		 * row carries the per-target rows (§10.1.5: 每一块信息只准出现一次, so the
		 * recipients are NOT restated here — A's rows own the target identities).
		 * A node with no readable receipt renders NOTHING (`null`) instead of
		 * throwing.
		 */
		function TopLevelSendCard(props) {
			var card = null;
			try {
				var node = props.node;
				var data = node === null || node === undefined ? undefined : node.data;
				card = data === null || data === undefined ? null : readSendCard(data.card);
			} catch (e) {
				card = null;
			}
			if (card === null) return null;
			return React.createElement(SendCardView, { card: card, detail: false, t: props.t });
		}

		/**
		 * One console line for a client-side degradation (§10.1.5 降级优先). The
		 * browser console is not the session log, so nothing here writes an event
		 * of any kind (§10.3); it exists so a degraded face is diagnosable instead
		 * of silently missing.
		 */
		function reportDegrade(where, consequence, error) {
			try {
				if (typeof console !== "undefined" && console !== null && typeof console.warn === "function") {
					console.warn("[dsh-team-link] " + where + " failed — " + consequence + ":", error);
				}
			} catch (e) {
				/* a console that itself throws must not matter either */
			}
		}

		/**
		 * Register one slot entry so that a refusal costs THAT row alone, never the
		 * registrations after it (差异审计 B3). Both halves can throw —
		 * `slots.inject` on an undeclared slot name, `slots.register` on a key
		 * another entry already holds — and all of this plugin's registrations share
		 * one `apply()`, so an unguarded throw aborts everything after it: the tool
		 * row and the receiver's card would disappear together with the failure of
		 * whatever threw first.
		 *
		 * @param name - the SLOT name, passed to `slots.inject` verbatim.
		 * @param label - how the console line names this entry; two entries share
		 *   the `conversation.chat.node` slot, so the key has to be in it for the
		 *   line to say which row was lost.
		 */
		function guardedSlot(ctx, name, label, register) {
			const consequence = "that row falls back to the generic renderer (the other slots are unaffected)";
			try {
				ctx.slots.inject(name, function () {
					try {
						return register();
					} catch (error) {
						reportDegrade(label, consequence, error);
						return undefined;
					}
				});
			} catch (error) {
				reportDegrade(label, consequence, error);
			}
		}

		/**
		 * Register D's Definition through the `uiConversation` face — DYNAMICALLY,
		 * with `ctx.inject`, so the service is not a hard dependency of this half
		 * (差异审计 F3). The client context does have cordis's `ctx.inject`
		 * (`cordis/lib/index.js:743` mixes the `registry` mixin — `inject`/`plugin`
		 * — into every Context, so it is not itself an injected service; and
		 * `Context.inject(deps, callback)` at `:1599` starts the callback as a
		 * nested plugin whose `inject` map gates it: with the service absent the
		 * callback simply never runs, and nothing throws). First-party client
		 * plugins use exactly this shape for an optional service
		 * (`dsh-client-ui-conversation/lib/client.js:16794`,
		 * `ctx.inject(["commandUi"], (scope) => …)`), while `uiConversation` itself
		 * stays a MODULE-level dependency in the packages that cannot render
		 * without it (`dsh-client-ui-plan`, `…-deliverables`, `…-goal`,
		 * `…-workflow-run`). Three failure modes are all "no top-level row", never
		 * a broken session (§10.1.5 降级优先): the service is absent (an older
		 * shell), the registry rejects the definition, or the context cannot inject
		 * at all. The trace is one console line — the browser console is not the
		 * session log, so no event of any kind is written.
		 *
		 * With the service already provided, `ctx.inject` runs this callback
		 * synchronously (`Fiber` constructor → `_refresh()` → `_setEpoch` →
		 * `_updateState`, `cordis/lib/index.js:1097-1099`), which is why the caller
		 * can still rely on "the definition is registered before its view": the
		 * `conversation.chat.node` entry for D is registered after this call
		 * returns.
		 */
		function registerSendNode(ctx) {
			const consequence = "the top-level message card stays off (the tool row is unaffected)";
			try {
				if (typeof ctx.inject !== "function") return;
				ctx.inject(["uiConversation"], function (scoped) {
					try {
						var service = scoped === null || scoped === undefined ? undefined : scoped.uiConversation;
						var events = service === null || service === undefined ? undefined : service.events;
						if (events === undefined || typeof events.register !== "function") return undefined;
						return events.register(sendNodeDefinition);
					} catch (error) {
						reportDegrade("uiConversation.events.register", consequence, error);
						return undefined;
					}
				});
			} catch (error) {
				reportDegrade("uiConversation injection", consequence, error);
			}
		}

		/** Build the relay card renderer bound to one plugin context. */
		function makeRelayCardView(ctx) {
			return function RelayCardView(props) {
				var node = props.node;
				var data = node && node.data;
				var source = data && data.source;
				var blocks = Array.isArray(data && data.content) ? data.content : [];
				var text = blocks.filter(function (b) { return b && b.type === "text" && typeof b.text === "string"; }).map(function (b) { return b.text; }).join("\n");
				// The durable message id lives on the chat node itself (`node.id`); the
				// context node's `data` carries seq/time/content/source and no id.
				var relayId = node !== null && node !== undefined && typeof node.id === "string" ? node.id
					: data !== null && data !== undefined && typeof data.id === "string" ? data.id : undefined;
				// Cross-session relays are published as `{kind: "agent-message", form: "relay",
				// senderSessionId}` — the only shape the DSH 0.1.5 session-format migration
				// admits. Upstream emits that SAME shape for adjacent-agent messages (bare-UUID
				// ids, body `Agent <id> sent a message: …`), so kind + form alone would dress
				// foreign messages as our cards. Two signals identify our own deliveries — the
				// `slp-` id the host half mints, and the banner it writes — and either one
				// suffices, so an id-less (or unusually-ided) render path still gets its card.
				// The legacy `kind: "team-link"` stays recognized: history written
				// before the change carries it, together with the `sentAt` the card reads.
				var isOwnRelay = (relayId !== undefined && relayId.indexOf("slp-") === 0) || hasRelayBanner(text);
				var isPublishedRelay = source !== undefined && source !== null &&
					source.kind === "agent-message" && source.form === "relay" && isOwnRelay;
				var isRelaySource = source !== undefined && source !== null &&
					(source.kind === "team-link" || isPublishedRelay);
				if (!isRelaySource) {
					return delegateContextNode(ctx, props);
				}
				var t = typeof props.t === "function" ? props.t : function (key) { return key; };
				var senderId = typeof source.senderSessionId === "string" && source.senderSessionId !== "" ? source.senderSessionId : source.fromSession;
				// Old rows carried `sentAt`; the published shape has no room for it, so the
				// card falls back to the durable event time the context node already has,
				// and finally to the stamp the host half writes into the banner.
				var legacy = typeof source.sentAt === "string" ? new Date(source.sentAt) : null;
				var stamped = data !== null && data !== undefined && typeof data.time === "number" && isFinite(data.time) ? new Date(data.time) : null;
				var whenText = legacy !== null && !isNaN(legacy.valueOf()) ? legacy.toLocaleString()
					: stamped !== null && !isNaN(stamped.valueOf()) ? stamped.toLocaleString()
						: relayStampOf(text);
				return React.createElement("div", { className: "dshsl-relay", "data-slp-relay": "true" },
					React.createElement("div", { className: "dshsl-relay-head" },
						"📡 ",
						t("relayTitle"),
						senderId !== undefined && senderId !== null ? React.createElement("span", { className: "dshsl-relay-sender", title: wellFormed(String(senderId)) }, "来自 " + wellFormed(shortSessionId(senderId))) : null,
						whenText !== "" ? React.createElement("span", { className: "dshsl-relay-when" }, whenText) : null),
					React.createElement("div", { className: "dshsl-relay-body" }, wellFormed(stripRelayWrapper(text)) || t("relayEmpty")),
					React.createElement("div", { className: "dshsl-relay-foot" }, t("relayReply")));
			};
		}
		// --- plugin ---
		function apply(ctx) {
			ctx.effect(() => {
				const disposeEn = ctx.locale.register("dsh-team-link", "en", {
					copyLink: "Copy session link",
					copied: "Link copied",
					exportSession: "Export session (markdown)",
					relayTitle: "Cross-session message",
					relayEmpty: "(empty)",
					relayReply: "Reply with the team_link_send tool",
					sendTitle: "Sent cross-session message",
					sendTruncated: "(body truncated, {chars} code points originally)",
					sendRowTargets: "{count} targets",
					sendRowsTruncated: "(truncated — showing the first {shown} rows)",
					sendSummary: "Summary: {delivered} delivered / {refused} refused / {noAgent} no agent / {noHolder} vacant",
					sendDeduped: "{deduped} duplicates dropped",
					sendBusyMinutes: "(target turn running {minutes} min — steered into it)",
					sendBusyUnknown: "(target turn running — start time unreadable)",
					outcomeDelivered: "delivered",
					outcomeRefused: "refused",
					outcomeNoAgent: "no agent",
					outcomeNoHolder: "vacant",
					sendPlainTitle: "Tool call",
					sendPlainRunning: "running…",
					sendPlainSettled: "no structured receipt — showing the model-visible result"
				});
				const disposeZh = ctx.locale.register("dsh-team-link", "zh", {
					copyLink: "复制会话链接",
					copied: "已复制链接",
					exportSession: "导出会话（markdown）",
					relayTitle: "跨会话消息",
					relayEmpty: "（空）",
					relayReply: "可调用 team_link_send 工具回复",
					sendTitle: "已发出跨会话消息",
					sendTruncated: "（正文已截断，原文 {chars} 码点）",
					sendRowTargets: "{count} 个目标",
					sendRowsTruncated: "（已截断——仅显示前 {shown} 行）",
					sendSummary: "汇总：{delivered} 投递 / {refused} 拒绝 / {noAgent} 无活动代理 / {noHolder} 空缺目标",
					sendDeduped: "{deduped} 个重复目标已去重",
					sendBusyMinutes: "（目标回合已运行 {minutes} 分钟——steer 注入当前回合）",
					sendBusyUnknown: "（目标回合运行中——起始时间不可读）",
					outcomeDelivered: "已投递",
					outcomeRefused: "被拒绝",
					outcomeNoAgent: "无活动代理",
					outcomeNoHolder: "空缺目标",
					sendPlainTitle: "工具调用",
					sendPlainRunning: "调用中…",
					sendPlainSettled: "无结构化回执——显示模型可见的返回文本"
				});
				return () => {
					disposeEn();
					disposeZh();
				};
			}, "dsh-team-link: locale dictionaries");
			// All four slot registrations below go through `guardedSlot`: they share
			// one `apply()`, so an unguarded throw in ANY of them aborts every
			// registration after it (差异审计 B3). The header strip is the FIRST of
			// the four and therefore the costliest one to leave open (round-1 🔵 #3):
			// losing it would take the tool row, both chat rows and the deep-link
			// opener with it.
			guardedSlot(ctx, "conversation.session.header.actions", "conversation.session.header.actions", () =>
				ctx.slots.register({
					name: "conversation.session.header.actions",
					id: "dsh-team-link.header-actions",
					order: 500,
					locale: "dsh-team-link"
				}, HeaderActions));
			// §10.1.1 A: claim this plugin's own tool name in the keyed tool view
			// slot. The key is the wire tool name (see SEND_TOOL_KEY) and no shipped
			// entry claims it, so this is additive — an unclaimed key falls back to
			// the generic tool row, which is also what a typo here would silently do.
			// Each of the three §10.1 registrations goes through the same
			// `guardedSlot` so a refusal costs that one row (差异审计 B3) instead of
			// aborting the registrations after it.
			guardedSlot(ctx, "tool.call.toolview", "tool.call.toolview (key " + JSON.stringify(SEND_TOOL_KEY) + ")", () =>
				ctx.slots.register({
					name: "tool.call.toolview",
					key: SEND_TOOL_KEY,
					locale: "dsh-team-link"
				}, SendToolCallView));
			guardedSlot(ctx, "conversation.chat.node", "conversation.chat.node (key \"context\")", function () {
				return ctx.slots.register({
					name: "conversation.chat.node",
					key: "context",
					priority: -100,
					locale: "dsh-team-link"
				}, makeRelayCardView(ctx));
			});
			// §10.1.3 D: the top-level node. A DIFFERENT kind from the receiver's
			// `key: "context"` entry above, so the two coexist (the slot is keyed)
			// and neither shadows the other. The definition rides the
			// `uiConversation` face and is registered before its view so a
			// node kind never exists without a renderer.
			registerSendNode(ctx);
			guardedSlot(ctx, "conversation.chat.node", "conversation.chat.node (key " + JSON.stringify(SEND_CARD_KIND) + ")", function () {
				return ctx.slots.register({
					name: "conversation.chat.node",
					key: SEND_CARD_KIND,
					priority: -90,
					locale: "dsh-team-link"
				}, TopLevelSendCard);
			});
			openDeepLinkedSession(ctx);
		}

		// `uiConversation` is deliberately NOT in this array (差异审计 F3): a
		// module-level dependency gates `apply()` itself, so a shell without the
		// service would lose the header strip, the export button, the deep-link
		// opener AND the receiver's card — everything — instead of only the
		// top-level card, which is what §10.1.5 promises. The dynamically injected
		// registration in `registerSendNode` is the whole contract: missing service
		// ⇒ no top-level card, every other face unaffected.
		module.exports = { name: "dsh-team-link", inject: ["slots", "sessions", "locale"], apply };
		return module.exports;
	}
});
