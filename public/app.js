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

function addMessage(role, content, renderedHtml, confirmationRequest, editable = false) {
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
  if (role === "user" && editable) {
    article.append(buildEditButton(article, body, content));
  }
  if (role === "assistant" && confirmationRequest) {
    article.append(buildConfirmation(confirmationRequest));
  }
  messages.append(article);
  updateConversationView();
  article.scrollIntoView({ behavior: "smooth", block: "end" });
}

function buildEditButton(article, body, original) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "edit-message";
  button.setAttribute("aria-label", "Editar mensaje");
  button.title = "Editar";
  button.textContent = "✎";
  button.addEventListener("click", () => {
    if (sendButton.disabled) return;
    startEdit(article, body, button, original);
  });
  return button;
}

function startEdit(article, body, editButton, original) {
  const index = Array.prototype.indexOf.call(messages.children, article);
  if (index < 0 || index % 2 !== 0 || conversationHistory[index]?.role !== "user") return;

  const editor = document.createElement("textarea");
  editor.className = "edit-textarea";
  editor.maxLength = MAX_HISTORY_MESSAGE_LENGTH;
  editor.rows = 3;
  editor.value = original;
  editor.setAttribute("aria-label", "Editar mensaje");
  const actions = document.createElement("div");
  actions.className = "confirmation-actions";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "button button-primary";
  save.textContent = "Guardar";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "button button-secondary";
  cancel.textContent = "Cancelar";
  actions.append(save, cancel);

  body.hidden = true;
  editButton.hidden = true;
  article.append(editor, actions);
  editor.focus();

  const close = () => {
    editor.remove();
    actions.remove();
    body.hidden = false;
    editButton.hidden = false;
  };
  cancel.addEventListener("click", close);
  save.addEventListener("click", async () => {
    const text = editor.value.trim();
    if (!text || sendButton.disabled) return;
    // Descarta este mensaje y todo lo que le siguió antes de reenviarlo corregido.
    conversationHistory = conversationHistory.slice(0, index);
    while (messages.children.length > index) messages.lastElementChild.remove();
    updateConversationView();
    await sendMessage(text);
  });
}

function buildConfirmation(confirmationRequest) {
  const container = document.createElement("div");
  const title = document.createElement("p");
  title.className = "confirmation-title";
  title.textContent = confirmationRequest.title;
  const actions = document.createElement("div");
  actions.className = "confirmation-actions";
  const confirmButton = document.createElement("button");
  confirmButton.type = "button";
  confirmButton.className = "button button-primary";
  confirmButton.textContent = `[ ${confirmationRequest.confirmLabel} ]`;
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "button button-secondary";
  cancelButton.textContent = `[ ${confirmationRequest.cancelLabel} ]`;
  const buttons = [confirmButton, cancelButton];

  confirmButton.addEventListener("click", async () => {
    buttons.forEach((button) => (button.disabled = true));
    setBusy(true);
    const userText = confirmationRequest.confirmLabel;
    prepareHistoryForUserMessage(userText);
    addHistoryMessage("user", userText);
    addMessage("user", userText);
    try {
      const result = await request("/api/chat", {
        method: "POST",
        body: JSON.stringify({ confirmation: confirmationRequest.actionPayload }),
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
      setBusy(false);
    }
  });

  cancelButton.addEventListener("click", () => {
    buttons.forEach((button) => (button.disabled = true));
    const reply = "Acción cancelada. No se realizó ningún cambio.";
    prepareHistoryForUserMessage(confirmationRequest.cancelLabel);
    addHistoryMessage("user", confirmationRequest.cancelLabel);
    addMessage("user", confirmationRequest.cancelLabel);
    addHistoryMessage("assistant", reply);
    addMessage("assistant", reply);
  });

  actions.append(...buttons);
  container.append(title, actions);
  return container;
}

function setBusy(busy) {
  sendButton.disabled = busy;
  sendButton.setAttribute("aria-busy", String(busy));
  sendButton.setAttribute("aria-label", busy ? "Procesando mensaje" : "Enviar mensaje");
  if (!busy) messageInput.focus();
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
    renderQuickActions(role);
    updateConversationView();
    messageInput.focus();
  } catch (error) {
    if (error.status !== 401 && error.status !== 403) {
      authError.textContent = error.message;
      authError.hidden = false;
    }
  }
}

const NSS_PLACEHOLDER = "[ingrese NSS]";

const QUICK_ACTIONS = {
  expediente: {
    icon: "📋",
    title: "Consultar Expediente",
    description: "Antecedentes del paciente",
    prompt: `Consultar el expediente del paciente con NSS: ${NSS_PLACEHOLDER}`,
  },
  poliza: {
    icon: "🛡️",
    title: "Validar Póliza / Cobertura",
    description: "Consultar cobertura de seguro",
    prompt: `Validar la póliza y cobertura del paciente con NSS: ${NSS_PLACEHOLDER}`,
  },
  atencion: {
    icon: "🩺",
    title: "Nota de Evolución / Atención médica",
    description: "Registrar atención médica",
    prompt: `Registrar nota de evolución del paciente con NSS: ${NSS_PLACEHOLDER}. Motivo y signos vitales: [ingrese datos]`,
  },
  farmacia: {
    icon: "💊",
    title: "Farmacia y Recetas",
    description: "Revisar recetas pendientes",
    prompt: `¿Qué recetas están pendientes de entrega en farmacia para el paciente con NSS: ${NSS_PLACEHOLDER}?`,
  },
  inventario: {
    icon: "📦",
    title: "Consultar Inventario",
    description: "Medicamentos con menor stock",
    prompt: "¿Cuáles son los medicamentos con menor stock?",
  },
  historicos: {
    icon: "🗂️",
    title: "Registrar / Consultar Antecedentes Clínicos",
    description: "Antecedentes del paciente",
    prompt: `Consultar o registrar antecedentes clínicos del paciente con NSS: ${NSS_PLACEHOLDER}`,
  },
  registrarPaciente: {
    icon: "➕",
    title: "Registrar Paciente",
    description: "Alta de un paciente nuevo",
    prompt: "Registrar un paciente nuevo. Datos: [ingrese nombre, NSS y contacto]",
  },
  consultarPaciente: {
    icon: "🔎",
    title: "Consultar Paciente",
    description: "Buscar por NSS o nombre",
    prompt: `Consultar al paciente con NSS: ${NSS_PLACEHOLDER}`,
  },
};

const QUICK_ACTIONS_BY_ROLE = {
  Admin: [
    "expediente",
    "poliza",
    "atencion",
    "farmacia",
    "inventario",
    "historicos",
    "registrarPaciente",
    "consultarPaciente",
  ],
  Farmacia: ["farmacia", "inventario"],
  Medico: ["expediente", "atencion"],
  Admision: ["registrarPaciente", "consultarPaciente"],
  Seguros: ["poliza"],
  Historicos: ["historicos"],
};

function renderQuickActions(role) {
  const container = document.querySelector("#quick-actions");
  container.replaceChildren();
  const keys = QUICK_ACTIONS_BY_ROLE[role] ?? [];
  container.hidden = keys.length === 0;
  for (const key of keys) {
    const action = QUICK_ACTIONS[key];
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quick-action";
    const icon = document.createElement("span");
    icon.className = "quick-action-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = action.icon;
    const title = document.createElement("span");
    title.className = "quick-action-title";
    title.textContent = action.title;
    const description = document.createElement("span");
    description.className = "quick-action-description";
    description.textContent = action.description;
    button.append(icon, title, description);
    button.addEventListener("click", () => {
      messageInput.value = action.prompt;
      messageInput.dispatchEvent(new Event("input", { bubbles: true }));
      messageInput.focus();
      const start = action.prompt.indexOf("[");
      if (start > -1) {
        messageInput.setSelectionRange(start, action.prompt.indexOf("]", start) + 1);
      }
    });
    container.append(button);
  }
}

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = messageInput.value.trim();
  if (!message || sendButton.disabled) return;
  messageInput.value = "";
  messageInput.style.height = "auto";
  await sendMessage(message);
});

async function sendMessage(message) {
  prepareHistoryForUserMessage(message);
  addHistoryMessage("user", message);
  addMessage("user", message, undefined, undefined, true);
  setBusy(true);
  try {
    const result = await request("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message, messages: conversationHistory }),
    });
    addHistoryMessage("assistant", result.response);
    addMessage("assistant", result.response, result.html, result.confirmationRequest);
  } catch (error) {
    if (error.status === 401) {
      window.location.assign("/auth/login");
      return;
    }
    addHistoryMessage("assistant", error.message);
    showError(error.message);
  } finally {
    setBusy(false);
  }
}

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

// Si el logotipo no está disponible, se conserva la marca textual.
document.querySelectorAll(".brand-logo, .login-logo").forEach((image) => {
  const useFallback = () => {
    const fallback = document.createElement("span");
    fallback.className = "brand-mark";
    fallback.textContent = "V";
    fallback.setAttribute("role", "img");
    fallback.setAttribute("aria-label", "Vitalis");
    image.replaceWith(fallback);
  };
  image.addEventListener("error", useFallback);
  if (image.complete && image.naturalWidth === 0) useFallback();
});

loadIdentity();
