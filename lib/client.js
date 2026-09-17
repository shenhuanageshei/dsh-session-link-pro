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
//     host half's /team-link/export web route.
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
				".dshsl-relay-foot{margin-top:6px;font-size:11px;color:var(--dsw-alias-label-tertiary)}"
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
					relayReply: "Reply with the team_link_send tool"
				});
				const disposeZh = ctx.locale.register("dsh-team-link", "zh", {
					copyLink: "复制会话链接",
					copied: "已复制链接",
					exportSession: "导出会话（markdown）",
					relayTitle: "跨会话消息",
					relayEmpty: "（空）",
					relayReply: "可调用 team_link_send 工具回复"
				});
				return () => {
					disposeEn();
					disposeZh();
				};
			}, "dsh-team-link: locale dictionaries");
			ctx.slots.inject("conversation.session.header.actions", () =>
				ctx.slots.register({
					name: "conversation.session.header.actions",
					id: "dsh-team-link.header-actions",
					order: 500,
					locale: "dsh-team-link"
				}, HeaderActions));
			ctx.slots.inject("conversation.chat.node", function () {
				return ctx.slots.register({
					name: "conversation.chat.node",
					key: "context",
					priority: -100,
					locale: "dsh-team-link"
				}, makeRelayCardView(ctx));
			});
			openDeepLinkedSession(ctx);
		}

		module.exports = { name: "dsh-team-link", inject: ["slots", "sessions", "locale"], apply };
		return module.exports;
	}
});
