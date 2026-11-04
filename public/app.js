const welcome = document.querySelector("#welcome");
const chatPanel = document.querySelector("#chat-panel");
const messages = document.querySelector("#messages");
const chatForm = document.querySelector("#chat-form");
const messageInput = document.querySelector("#message-input");
const sendButton = document.querySelector("#send-button");
const newChatButton = document.querySelector("#new-chat");
const logoutForm = document.querySelector("#logout-form");
const userBadge = document.querySelector("#user-badge");
const authError = document.querySelector("#auth-error");

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
    chatPanel.hidden = false;
    newChatButton.hidden = false;
    logoutForm.hidden = false;
    userBadge.hidden = false;
    userBadge.textContent = `${identity.name} · ${identity.role}`;
    messageInput.focus();
  } catch (error) {
    if (error.status !== 401 && error.status !== 403) {
      authError.textContent = error.message;
      authError.hidden = false;
    }
  }
}

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = messageInput.value.trim();
  if (!message || sendButton.disabled) return;

  addMessage("user", message);
  messageInput.value = "";
  sendButton.disabled = true;
  sendButton.querySelector("span:first-child").textContent = "Enviando";
  try {
    const result = await request("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message }),
    });
    addMessage("assistant", result.response, result.html);
  } catch (error) {
    if (error.status === 401) {
      window.location.assign("/auth/login");
      return;
    }
    showError(error.message);
  } finally {
    sendButton.disabled = false;
    sendButton.querySelector("span:first-child").textContent = "Enviar";
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
    messages.replaceChildren();
    addMessage(
      "assistant",
      "Hola. Soy Vitalis, tu asistente hospitalario. ¿En qué puedo ayudarte?",
    );
    messageInput.focus();
  } catch (error) {
    showError(error.message);
  } finally {
    newChatButton.disabled = false;
  }
});

loadIdentity();
