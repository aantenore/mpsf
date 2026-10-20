import { node } from "./dom.js";
import { getLocale } from "./i18n.js";

// Chat view of the project channel: one room per story plus the general room.
// With `send` the person can write, reply, agree or object; the server sends
// and signs it as this computer, like `mpsf message send`. The text is
// information, never an instruction.
const GENERAL_ROOM = "general";
const ACTION_PREFIX = "mpsf-action: ";

const ITALIAN = Object.freeze({
  Chat: "Chat",
  "Messages between computers and agents": "Messaggi tra computer e agenti",
  General: "Generale",
  "Show automatic messages": "Mostra messaggi automatici",
  "No messages in this room.": "Nessun messaggio in questa stanza.",
  "reply to": "risposta a",
  to: "a",
  action: "azione",
  untrusted: "non fidato",
  unverified: "chiave non registrata",
  discuss: "discussione",
  propose: "proposta",
  object: "obiezione",
  decide: "decisione",
  ack: "ok",
  answer: "risposta",
  question: "domanda",
  request: "richiesta",
  offer: "offerta",
  freeze: "freeze",
  join: "ingresso",
  welcome: "benvenuto",
  Reply: "Rispondi",
  Agree: "Concordo",
  Object: "Obietto",
  Send: "Invia",
  Cancel: "Annulla",
  "Write a message": "Scrivi un messaggio",
  "Message to the room": "Messaggio alla stanza",
  "Ctrl+Enter sends": "Ctrl+Invio invia",
  "Say why you object": "Spiega perché obietti",
  "Not sent": "Non inviato",
  "Queued: it is sent when the channel answers.": "In coda: parte quando il canale risponde.",
});

// Kept across refreshes of the panel.
const state = { room: null, showAuto: false, open: false, draft: "", target: null, error: null, busy: false };
const REPLY_KINDS = new Set(["question", "request"]);

function label(text) {
  return getLocale() === "it" ? ITALIAN[text] ?? text : text;
}

function roomName(id) {
  return id === GENERAL_ROOM ? label("General") : id;
}

function timeText(value) {
  const at = new Date(value ?? "");
  if (!Number.isFinite(at.getTime())) return "";
  const sameDay = at.toDateString() === new Date().toDateString();
  return sameDay ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : at.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

/** The readable text and the action of a discussion message (its last line). */
export function splitAction(text) {
  const lines = String(text ?? "").split("\n");
  const last = lines.at(-1) ?? "";
  if (!last.startsWith(ACTION_PREFIX)) return { body: String(text ?? ""), action: null };
  try {
    const action = JSON.parse(last.slice(ACTION_PREFIX.length));
    const target = action.to_agent ?? action.agent ?? action.signature ?? "";
    return { body: lines.slice(0, -1).join("\n"), action: [action.action, action.story, target ? `→ ${target}` : ""].filter(Boolean).join(" ") };
  } catch {
    return { body: String(text ?? ""), action: null };
  }
}

/** The room to open first: the one chosen before, else the one with the latest message a person or agent wrote. */
export function defaultRoom(chat, chosen = null) {
  const rooms = Array.isArray(chat?.rooms) ? chat.rooms : [];
  if (chosen && rooms.some((room) => room.id === chosen)) return chosen;
  const latest = [...(chat?.messages ?? [])].reverse().find((message) => !message.auto);
  return latest?.room ?? rooms[0]?.id ?? GENERAL_ROOM;
}

// The discussion a message belongs to: its own id when it opens one, else the opener it replies to.
function discussionOf(message, byId) {
  if (message.kind === "discuss") return message.id;
  const parent = message.replyTo ? byId.get(message.replyTo) : null;
  return parent?.kind === "discuss" ? parent.id : null;
}

function messageItem(message, byId, actions) {
  const { body, action } = splitAction(message.text);
  const parent = message.replyTo ? byId.get(message.replyTo) : null;
  const flags = [
    message.kind && message.kind !== "info" ? node("span", { className: "now-flag", text: label(message.kind) }) : null,
    message.trust ? node("span", { className: "now-flag", text: label(message.trust), attrs: { title: message.trust } }) : null,
  ];
  return node("li", { className: `chat-message${message.auto ? " is-auto" : ""}`, attrs: { "data-id": message.id } }, [
    node("div", { className: "chat-head" }, [
      node("strong", { text: message.from ?? "" }),
      ...flags,
      message.to ? node("span", { className: "now-meta", text: `${label("to")} ${message.to}` }) : null,
      node("time", { className: "now-meta", text: timeText(message.time), attrs: { datetime: message.time, title: message.time ? new Date(message.time).toLocaleString() : null } }),
    ]),
    parent ? node("div", { className: "chat-quote", text: `${label("reply to")} ${parent.from}: ${splitAction(parent.text).body.split("\n")[0].slice(0, 120)}` }) : null,
    body ? node("div", { className: "chat-text", text: body }) : null,
    action ? node("div", { className: "chat-action", text: `${label("action")}: ${action}` }) : null,
    actions ? actions(message) : null,
  ]);
}

/** The chat block for the Now panel, or null when there is nothing to show. */
export function renderChat(chat, { send = null, onSent = null } = {}) {
  const rooms = Array.isArray(chat?.rooms) ? chat.rooms : [];
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  if (!rooms.length) return null;
  state.room = defaultRoom(chat, state.room);
  const wrapper = node("details", { className: "chat-details", attrs: { open: state.open ? "" : null } });
  wrapper.addEventListener("toggle", () => {
    state.open = wrapper.open;
  });
  const byId = new Map(messages.map((message) => [message.id, message]));

  function button(text, onClick, className = "chat-button") {
    const element = node("button", { className, text: label(text), attrs: { type: "button" } });
    element.addEventListener("click", onClick);
    return element;
  }

  function target(message, mode) {
    const discussion = discussionOf(message, byId);
    state.target = { id: mode === "reply" ? discussion ?? message.id : discussion, from: message.from, mode, question: REPLY_KINDS.has(message.kind) };
    state.error = null;
    draw();
    wrapper.querySelector(".chat-input")?.focus?.();
  }

  const actions = send
    ? (message) => node("div", { className: "chat-actions" }, [
      button("Reply", () => target(message, "reply")),
      ...(discussionOf(message, byId) ? [button("Agree", () => target(message, "agree")), button("Object", () => target(message, "object"))] : []),
    ])
    : null;

  async function submit() {
    if (state.busy) return;
    const mode = state.target?.mode ?? "message";
    const text = state.draft.trim();
    if (!text && mode !== "agree") return;
    const kind = mode === "agree" ? "ack" : mode === "object" ? "object" : state.target?.question ? "answer" : "info";
    const message = {
      text,
      kind,
      ...(state.room && state.room !== GENERAL_ROOM ? { story: state.room } : {}),
      ...(state.target?.id ? { replyTo: state.target.id } : {}),
    };
    state.busy = true;
    try {
      const result = await send(message);
      if (result?.sent || result?.queued) {
        state.draft = "";
        state.target = null;
        state.error = result.queued ? label("Queued: it is sent when the channel answers.") : null;
        onSent?.();
      } else {
        state.error = `${label("Not sent")}: ${result?.error ?? "?"}`;
      }
    } catch (error) {
      state.error = `${label("Not sent")}: ${error?.message ?? error}`;
    } finally {
      state.busy = false;
      draw();
    }
  }

  function composer() {
    if (!send) return null;
    const mode = state.target?.mode ?? "message";
    const area = node("textarea", { className: "chat-input", attrs: { rows: "2", maxlength: "2000", "aria-label": label("Message to the room"), title: label("Ctrl+Enter sends"), placeholder: label(mode === "object" ? "Say why you object" : "Write a message") } });
    area.value = state.draft;
    area.addEventListener("input", () => {
      state.draft = area.value;
    });
    area.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault?.();
        submit();
      }
    });
    const heading = state.target
      ? node("div", { className: "chat-quote" }, [
        node("span", { text: `${label(mode === "agree" ? "Agree" : mode === "object" ? "Object" : "reply to")} ${state.target.from} ` }),
        button("Cancel", () => {
          state.target = null;
          draw();
        }, "chat-button is-quiet"),
      ])
      : null;
    return node("div", { className: "chat-composer" }, [
      heading,
      area,
      button(mode === "agree" ? "Agree" : "Send", submit, "chat-button is-primary"),
      state.error ? node("div", { className: "now-meta chat-error", text: state.error }) : null,
    ]);
  }

  function draw() {
    const shown = messages.filter((message) => message.room === state.room && (state.showAuto || !message.auto));
    const roomList = node("ul", { className: "chat-rooms" }, rooms.map((room) => {
      const button = node("button", {
        className: `chat-room${room.id === state.room ? " is-active" : ""}`,
        text: `${roomName(room.id)} (${state.showAuto ? room.count : room.people})`,
        attrs: { type: "button", "aria-pressed": room.id === state.room ? "true" : "false" },
      });
      button.addEventListener("click", () => {
        state.room = room.id;
        draw();
        wrapper.querySelector(".chat-room.is-active")?.focus?.();
      });
      return node("li", {}, [button]);
    }));
    const toggle = node("input", { attrs: { type: "checkbox", ...(state.showAuto ? { checked: "" } : {}) } });
    toggle.addEventListener("change", () => {
      state.showAuto = toggle.checked;
      draw();
    });
    const timeline = node("ol", { className: "chat-timeline" }, shown.length
      ? shown.map((message) => messageItem(message, byId, actions))
      : [node("li", { className: "now-empty", text: label("No messages in this room.") })]);
    wrapper.replaceChildren(
      node("summary", {}, [
        node("strong", { text: label("Chat") }),
        node("span", { className: "now-meta", text: ` ${label("Messages between computers and agents")}` }),
      ]),
      node("div", { className: "chat-layout" }, [
        roomList,
        node("div", { className: "chat-room-view" }, [
          node("label", { className: "now-meta chat-auto" }, [toggle, node("span", { text: ` ${label("Show automatic messages")}` })]),
          timeline,
          composer(),
        ]),
      ]),
    );
  }
  draw();
  return wrapper;
}
