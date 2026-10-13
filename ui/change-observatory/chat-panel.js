import { node } from "./dom.js";
import { getLocale } from "./i18n.js";

// Chat view of the project channel: one room per story plus the general room.
// Read-only: it shows what `mpsf message` and the agents wrote. The text is
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
});

// Kept across refreshes of the panel.
const state = { room: null, showAuto: false, open: false };

function label(text) {
  return getLocale() === "it" ? ITALIAN[text] ?? text : text;
}

function roomName(id) {
  return id === GENERAL_ROOM ? label("General") : id;
}

function timeText(value) {
  const at = new Date(value ?? "");
  return Number.isFinite(at.getTime()) ? at.toLocaleString() : "";
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

function messageItem(message, byId) {
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
      node("time", { className: "now-meta", text: timeText(message.time), attrs: { datetime: message.time } }),
    ]),
    parent ? node("div", { className: "chat-quote", text: `${label("reply to")} ${parent.from}: ${splitAction(parent.text).body.split("\n")[0].slice(0, 120)}` }) : null,
    body ? node("div", { className: "chat-text", text: body }) : null,
    action ? node("div", { className: "chat-action", text: `${label("action")}: ${action}` }) : null,
  ]);
}

/** The chat block for the Now panel, or null when there is nothing to show. */
export function renderChat(chat) {
  const rooms = Array.isArray(chat?.rooms) ? chat.rooms : [];
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  if (!rooms.length) return null;
  state.room = defaultRoom(chat, state.room);
  const wrapper = node("details", { className: "chat-details", attrs: { open: state.open ? "" : null } });
  wrapper.addEventListener("toggle", () => {
    state.open = wrapper.open;
  });
  const byId = new Map(messages.map((message) => [message.id, message]));

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
      });
      return node("li", {}, [button]);
    }));
    const toggle = node("input", { attrs: { type: "checkbox", ...(state.showAuto ? { checked: "" } : {}) } });
    toggle.addEventListener("change", () => {
      state.showAuto = toggle.checked;
      draw();
    });
    const timeline = node("ol", { className: "chat-timeline" }, shown.length
      ? shown.map((message) => messageItem(message, byId))
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
        ]),
      ]),
    );
  }
  draw();
  return wrapper;
}
