const welcome = document.querySelector("#welcome");
const chatPanel = document.querySelector("#chat-panel");
const messages = document.querySelector("#messages");
const emptyState = document.querySelector("#empty-state");
const chatForm = document.querySelector("#chat-form");
const messageInput = document.querySelector("#message-input");
const sendButton = document.querySelector("#send-button");
const newChatButton = document.querySelector("#new-chat");
const logoutForm = document.querySelector("#logout-form");
const userBadge = document.querySelector("#user-badge");
const userAvatar = document.querySelector("#user-avatar");
const userName = document.querySelector("#user-name");
const userRole = document.querySelector("#user-role");
const welcomeName = document.querySelector("#welcome-name");
const authError = document.querySelector("#auth-error");
const topbar = document.querySelector(".topbar");

let conversationHistory = [];
const MAX_HISTORY_MESSAGES = 40;
const MAX_HISTORY_MESSAGE_LENGTH = 8000;
const MAX_HISTORY_LENGTH = 48000;

function historyLength() {
  return conversationHistory.reduce((total, message) => total + message.content.length, 0);
}

function removeOldestTurn() {
  conversationHistory.splice(0, 2);
  messages.firstElementChild?.remove();
  messages.firstElementChild?.remove();
}

function prepareHistoryForUserMessage(content) {
  while (
    conversationHistory.length >= MAX_HISTORY_MESSAGES - 1 ||
    historyLength() + content.length + MAX_HISTORY_MESSAGE_LENGTH > MAX_HISTORY_LENGTH
  ) {
    if (conversationHistory.length < 2) break;
    removeOldestTurn();
  }
}

function addHistoryMessage(role, content) {
  conversationHistory.push({
    role,
    content: content.slice(0, MAX_HISTORY_MESSAGE_LENGTH),
  });
}

function updateConversationView() {
  const hasMessages = messages.childElementCount > 0;
  emptyState.hidden = hasMessages;
  messages.hidden = !hasMessages;
}

function initialsFor(name) {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => Array.from(part)[0].toLocaleUpperCase())
    .join("");
}

function addMessage(role, content, renderedHtml) {
  const article = document.createElement("article");
  article.className = `message message-${role}`;
  const label = document.createElement("span");
  label.className = "message-label";
  label.textContent = role === "user" ? "TÚ" : "VITALIS";
  const body = document.createElement("p");
  body.className = "message-content";
  if (role === "assistant" && typeof renderedHtml === "string") {
    body.innerHTML = renderedHtml;
  } else {
    body.textContent = content;
  }
  article.append(label, body);
  messages.append(article);
  updateConversationView();
  article.scrollIntoView({ behavior: "smooth", block: "end" });
}

function showError(message) {
  addMessage("assistant", message);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (response.status === 204) return undefined;
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || "La solicitud no pudo completarse.");
    error.status = response.status;
    throw error;
  }
  return result;
}

async function loadIdentity() {
  try {
    const identity = await request("/api/me");
    welcome.hidden = true;
    topbar.hidden = false;
    chatPanel.hidden = false;
    newChatButton.hidden = false;
    logoutForm.hidden = false;
    userBadge.hidden = false;
    const name = typeof identity.name === "string" ? identity.name.trim() : "";
    const role = typeof identity.role === "string" ? identity.role.trim() : "";
    userName.textContent = name || "Usuario";
    userRole.textContent = role || "Personal";
    userAvatar.textContent = initialsFor(name) || "U";
    welcomeName.textContent = name || "Usuario";
    updateConversationView();
    messageInput.focus();
  } catch (error) {
    if (error.status !== 401 && error.status !== 403) {
      authError.textContent = error.message;
      authError.hidden = false;
    }
  }
}

document.querySelectorAll(".quick-action").forEach((button) => {
  button.addEventListener("click", () => {
    messageInput.value = button.dataset.prompt || "";
    messageInput.dispatchEvent(new Event("input", { bubbles: true }));
    messageInput.focus();
  });
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = messageInput.value.trim();
  if (!message || sendButton.disabled) return;

  prepareHistoryForUserMessage(message);
  addHistoryMessage("user", message);
  addMessage("user", message);
  messageInput.value = "";
  sendButton.disabled = true;
  sendButton.setAttribute("aria-busy", "true");
  sendButton.setAttribute("aria-label", "Procesando mensaje");
  try {
    const result = await request("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message, messages: conversationHistory }),
    });
    addHistoryMessage("assistant", result.response);
    addMessage("assistant", result.response, result.html);
  } catch (error) {
    if (error.status === 401) {
      window.location.assign("/auth/login");
      return;
    }
    addHistoryMessage("assistant", error.message);
    showError(error.message);
  } finally {
    sendButton.disabled = false;
    sendButton.setAttribute("aria-busy", "false");
    sendButton.setAttribute("aria-label", "Enviar mensaje");
    messageInput.focus();
  }
});

messageInput.addEventListener("input", () => {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 180)}px`;
});

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

newChatButton.addEventListener("click", async () => {
  newChatButton.disabled = true;
  try {
    await request("/api/new-chat", { method: "POST" });
    conversationHistory = [];
    messages.replaceChildren();
    updateConversationView();
    messageInput.focus();
  } catch (error) {
    showError(error.message);
  } finally {
    newChatButton.disabled = false;
  }
});

loadIdentity();
