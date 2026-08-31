const state = { actors: [], messages: [], activity: [], evaluationTools: [], evaluationMaxSteps: 2, latestEvaluation: null, replyToMessageId: undefined };
const elements = {
  actorSelect: document.querySelector("#actor-select"), actorRole: document.querySelector("#actor-role"),
  messages: document.querySelector("#messages"), composer: document.querySelector("#composer"),
  input: document.querySelector("#message-input"), sendButton: document.querySelector("#send-button"),
  sendStatus: document.querySelector("#send-status"), replyPreview: document.querySelector("#reply-preview"),
  replyAuthor: document.querySelector("#reply-author"), replyText: document.querySelector("#reply-text"),
  schedules: document.querySelector("#schedules"), obligations: document.querySelector("#obligations"),
  scheduleCount: document.querySelector("#schedule-count"), obligationCount: document.querySelector("#obligation-count"),
  clockLabel: document.querySelector("#clock-label"),
  operationsClock: document.querySelector("#operations-clock"), clockMode: document.querySelector("#clock-mode"),
  mockDateTime: document.querySelector("#mock-date-time"), clockStatus: document.querySelector("#clock-status"),
  activity: document.querySelector("#activity"),
  evaluationEnabled: document.querySelector("#evaluation-enabled"),
  evaluationFields: document.querySelector("#evaluation-fields"),
  evaluationMode: document.querySelector("#evaluation-mode"),
  evaluationTools: document.querySelector("#evaluation-tools"),
  evaluationMaxSteps: document.querySelector("#evaluation-max-steps"),
  evaluationHistory: document.querySelector("#evaluation-history"),
  evaluationExpectedTools: document.querySelector("#evaluation-expected-tools"),
  evaluationExpectedAnswer: document.querySelector("#evaluation-expected-answer"),
  evaluationResult: document.querySelector("#evaluation-result"),
};

async function loadState() {
  const response = await fetch("/api/state");
  if (!response.ok) throw new Error("Could not load staging state.");
  const next = await response.json();
  state.actors = next.actors;
  state.messages = next.messages;
  state.activity = next.activity || [];
  state.evaluationTools = next.evaluationTools || [];
  state.evaluationMaxSteps = next.evaluationSettings?.maxSteps || 2;
  state.latestEvaluation = next.latestEvaluation || null;
  renderActors(); renderMessages(); renderActivity(); renderOperations(next); renderClock(next);
  renderEvaluationTools(); renderEvaluationSettings(); renderEvaluationResult();
}

async function loadOperations() {
  const response = await fetch("/api/operations");
  if (!response.ok) throw new Error("Could not load runtime operations.");
  const next = await response.json();
  renderOperations(next);
  renderClock(next);
}

function renderActivity() {
  if (state.activity.length === 0) {
    elements.activity.innerHTML = '<div class="empty-data">No agent activity yet. Send a message to watch the flow.</div>';
    return;
  }

  let previousTurnId;
  const nodes = [];
  for (const event of state.activity) {
    if (event.turnId !== previousTurnId) {
      const divider = document.createElement("div");
      divider.className = "turn-divider";
      divider.textContent = `New turn | ${formatDateTime(event.occurredAt)}`;
      nodes.push(divider);
      previousTurnId = event.turnId;
    }
    nodes.push(renderActivityEvent(event));
  }
  elements.activity.replaceChildren(...nodes);
  elements.activity.scrollTop = elements.activity.scrollHeight;
}

function renderActivityEvent(event) {
  const item = document.createElement("article");
  item.className = `activity-item ${event.status}`;

  const marker = document.createElement("span");
  marker.className = "activity-marker";
  marker.setAttribute("aria-hidden", "true");

  const body = document.createElement("div");
  const heading = document.createElement("div");
  heading.className = "activity-heading";
  const title = document.createElement("strong");
  title.textContent = event.title;
  const meta = document.createElement("span");
  meta.textContent = `${readable(event.phase)}${event.step ? ` | Step ${event.step} of ${event.maxSteps}` : ""} | ${formatTime(event.occurredAt)}`;
  heading.append(title, meta);
  body.append(heading);

  if (event.detail) {
    const detail = document.createElement("p");
    detail.textContent = event.detail;
    body.append(detail);
  }
  if (event.plan?.length) {
    const plan = document.createElement("ol");
    plan.className = "agent-plan";
    for (const step of event.plan) {
      const entry = document.createElement("li");
      entry.textContent = step;
      plan.append(entry);
    }
    body.append(plan);
  }
  if (event.tool?.input && Object.keys(event.tool.input).length) {
    const input = document.createElement("dl");
    input.className = "tool-input";
    for (const [key, value] of Object.entries(event.tool.input)) {
      const term = document.createElement("dt");
      term.textContent = readable(key);
      const description = document.createElement("dd");
      description.textContent = formatActivityValue(value);
      input.append(term, description);
    }
    body.append(input);
  }
  item.append(marker, body);
  return item;
}

function renderActors() {
  const selected = elements.actorSelect.value;
  elements.actorSelect.replaceChildren(...state.actors.map((actor) => {
    const option = document.createElement("option");
    option.value = actor.id;
    option.textContent = `${actor.displayName}${actor.registered ? "" : " (new)"}`;
    return option;
  }));
  if (state.actors.some((actor) => actor.id === selected)) elements.actorSelect.value = selected;
  renderActorRole();
}

function renderActorRole() {
  const actor = state.actors.find((item) => item.id === elements.actorSelect.value);
  elements.actorRole.textContent = actor
    ? actor.registered ? actor.roles.join(" / ") : "Unregistered choir participant"
    : "No verified staging actors found";
  elements.sendButton.disabled = !actor;
}

function renderMessages() {
  if (state.messages.length === 0) {
    elements.messages.innerHTML = '<div class="empty-state"><div><strong>No messages yet</strong><p>Start a conversation to exercise the full Echo pipeline.</p></div></div>';
    return;
  }
  const byId = new Map(state.messages.map((message) => [message.id, message]));
  elements.messages.replaceChildren(...state.messages.map((message) => {
    const article = document.createElement("article");
    article.className = `message ${message.senderType === "echo" ? "echo" : ""}`;
    const quoted = message.replyToMessageId ? byId.get(message.replyToMessageId) : undefined;
    const body = document.createElement("div");
    body.innerHTML = `<div class="message-header"><strong>${escapeHtml(message.senderName)}</strong><time>${formatTime(message.createdAt)}</time></div>`;
    if (quoted) body.insertAdjacentHTML("beforeend", `<div class="quoted"><strong>${escapeHtml(quoted.senderName)}</strong><br>${escapeHtml(shorten(quoted.text, 140))}</div>`);
    const text = document.createElement("div");
    text.className = "message-body";
    text.textContent = message.text;
    body.append(text);
    const reply = document.createElement("button");
    reply.type = "button"; reply.className = "reply-button"; reply.textContent = "Reply";
    reply.addEventListener("click", () => selectReply(message));
    body.append(reply);
    const avatar = document.createElement("div");
    avatar.className = "avatar"; avatar.textContent = initials(message.senderName);
    article.append(avatar, body);
    return article;
  }));
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function renderOperations(next) {
  elements.scheduleCount.textContent = String(next.schedules.length);
  elements.obligationCount.textContent = String(next.obligations.length);
  renderDataList(elements.schedules, next.schedules, (job) => ({
    title: readable(job.jobId),
    detail: `${readable(job.category)} | ${job.runOnce ? "One time" : "Recurring"} | Next: ${formatDateTime(job.nextRunAt)}`,
  }), "No scheduled jobs");
  renderDataList(elements.obligations, next.obligations, (item) => ({
    title: readable(item.type),
    detail: `${readable(item.status)}${item.weekStart ? ` | Week of ${formatDate(item.weekStart)}` : ""}${item.dueAt ? ` | Due ${formatDateTime(item.dueAt)}` : ""}`,
  }), "No active obligations");
}

function renderDataList(container, items, mapper, emptyText) {
  if (!items.length) { container.innerHTML = `<div class="empty-data">${emptyText}</div>`; return; }
  container.replaceChildren(...items.map((item) => {
    const data = mapper(item); const element = document.createElement("article"); element.className = "data-item";
    const title = document.createElement("strong"); title.textContent = data.title;
    const detail = document.createElement("p"); detail.textContent = data.detail;
    element.append(title, detail); return element;
  }));
}

function renderClock(next) {
  elements.clockLabel.textContent = `${next.mockTime ? "Mock" : "Live"} time: ${formatDateTime(next.now)}`;
  elements.operationsClock.textContent = formatDateTime(next.now);
  elements.clockMode.textContent = next.mockTime ? "Mock" : "Live";
  elements.clockMode.classList.toggle("mock", next.mockTime);
  if (document.activeElement !== elements.mockDateTime) elements.mockDateTime.value = toDateTimeLocal(next.now);
}

async function updateClock(path, body) {
  const controls = document.querySelectorAll(".clock-action");
  controls.forEach((control) => { control.disabled = true; });
  elements.clockStatus.classList.remove("error-text");
  elements.clockStatus.textContent = "Updating time...";
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not update application time.");
    await loadState();
    // A submitted datetime input can remain focused, causing renderClock's
    // editing guard to skip it. A successful user action should always show the
    // normalized application time returned by the server.
    elements.mockDateTime.value = toDateTimeLocal(result.now);
    elements.clockStatus.textContent = result.timelineReset
      ? "Timeline reset. Schedules were rebuilt at the selected time."
      : "Time updated. Due scheduled work has finished.";
  } catch (error) {
    elements.clockStatus.textContent = error.message;
    elements.clockStatus.classList.add("error-text");
  } finally {
    controls.forEach((control) => { control.disabled = false; });
  }
}

function selectReply(message) {
  state.replyToMessageId = message.id;
  elements.replyAuthor.textContent = `Replying to ${message.senderName}`;
  elements.replyText.textContent = shorten(message.text, 150);
  elements.replyPreview.hidden = false;
  elements.input.focus();
}

function clearReply() { state.replyToMessageId = undefined; elements.replyPreview.hidden = true; }

async function sendMessage(event) {
  event.preventDefault();
  const text = elements.input.value.trim(); const actorId = elements.actorSelect.value;
  if (!text || !actorId) return;
  elements.sendButton.disabled = true; elements.sendStatus.textContent = "Echo is processing...";
  try {
    elements.sendStatus.classList.remove("error-text");
    const evaluation = buildEvaluationRequest();
    if (evaluation) {
      elements.evaluationResult.classList.remove("passed", "failed");
      elements.evaluationResult.textContent = "Running controlled test...";
    }
    const response = await fetch("/api/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actorId, text, replyToMessageId: state.replyToMessageId, evaluation }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Message failed.");
    elements.input.value = ""; clearReply(); await loadState();
    elements.sendStatus.textContent = "Enter to send, Shift+Enter for a new line";
  } catch (error) {
    elements.sendStatus.textContent = error.message; elements.sendStatus.classList.add("error-text");
    if (elements.evaluationEnabled.checked) {
      elements.evaluationResult.classList.add("failed");
      elements.evaluationResult.textContent = `Run failed | ${error.message}`;
    }
  }
  finally { elements.sendButton.disabled = !elements.actorSelect.value; }
}

function buildEvaluationRequest() {
  if (!elements.evaluationEnabled.checked) return undefined;
  const allowedTools = [...elements.evaluationTools.querySelectorAll("input[type=checkbox]:checked")].map((input) => input.value);
  if (allowedTools.length === 0) throw new Error("Select at least one available tool for the controlled run.");
  return {
    allowedTools,
    maxSteps: Number(elements.evaluationMaxSteps.value),
    includeRecentConversation: elements.evaluationHistory.checked,
    expectedTools: splitExpectation(elements.evaluationExpectedTools.value),
    expectedAnswerIncludes: splitExpectation(elements.evaluationExpectedAnswer.value),
  };
}

function renderEvaluationTools() {
  const currentNames = [...elements.evaluationTools.querySelectorAll("input")].map((input) => input.value);
  const nextNames = state.evaluationTools.map((tool) => tool.name);
  if (currentNames.join("|") === nextNames.join("|")) return;
  const selected = new Set(currentNames.length ? currentNames.filter((_, index) => elements.evaluationTools.querySelectorAll("input")[index]?.checked) : nextNames);
  elements.evaluationTools.replaceChildren(...state.evaluationTools.map((tool) => {
    const label = document.createElement("label");
    label.title = tool.description;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = tool.name;
    input.checked = selected.has(tool.name);
    const name = document.createElement("span");
    name.textContent = readable(tool.name);
    const capability = document.createElement("small");
    capability.textContent = readable(tool.capability);
    label.append(input, name, capability);
    return label;
  }));
}

function renderEvaluationSettings() {
  elements.evaluationMaxSteps.max = String(state.evaluationMaxSteps);
  if (!elements.evaluationMaxSteps.value || Number(elements.evaluationMaxSteps.value) > state.evaluationMaxSteps) {
    elements.evaluationMaxSteps.value = String(state.evaluationMaxSteps);
  }
}

function renderEvaluationResult() {
  const result = state.latestEvaluation;
  elements.evaluationResult.classList.remove("passed", "failed");
  if (!result) {
    elements.evaluationResult.textContent = "No controlled run yet.";
    return;
  }
  const status = result.passed === null ? "Observed" : result.passed ? "Passed" : "Failed";
  elements.evaluationResult.classList.add(result.passed === false ? "failed" : "passed");
  const tools = result.actualTools.length ? result.actualTools.join(" -> ") : "No tools selected";
  elements.evaluationResult.textContent = `${status} | ${tools}${result.issues.length ? ` | ${result.issues.join(" ")}` : ""}`;
}

function setEvaluationEnabled() {
  const enabled = elements.evaluationEnabled.checked;
  elements.evaluationFields.disabled = !enabled;
  elements.evaluationMode.textContent = enabled ? "On" : "Off";
}

function splitExpectation(value) {
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", async () => {
  document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === tab));
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `${tab.dataset.view}-view`));
  if (tab.dataset.view === "operations") await loadOperations();
}));
elements.composer.addEventListener("submit", sendMessage);
elements.input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); elements.composer.requestSubmit(); } });
elements.actorSelect.addEventListener("change", renderActorRole);
elements.evaluationEnabled.addEventListener("change", setEvaluationEnabled);
document.querySelector("#clear-reply").addEventListener("click", clearReply);
document.querySelector("#refresh-operations").addEventListener("click", loadOperations);
document.querySelector("#set-clock-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await updateClock("/api/clock/set", { dateTime: elements.mockDateTime.value });
});
document.querySelectorAll("[data-hours], [data-days]").forEach((button) => button.addEventListener("click", async () => {
  const body = {};
  if (button.dataset.hours) body.hours = Number(button.dataset.hours);
  if (button.dataset.days) body.days = Number(button.dataset.days);
  await updateClock("/api/clock/advance", body);
}));
document.querySelector("#clear-mock-time").addEventListener("click", () => updateClock("/api/clock/clear"));
document.querySelector("#refresh-actors").addEventListener("click", async () => { await fetch("/api/actors/refresh", { method: "POST" }); await loadState(); });
document.querySelector("#new-actor").addEventListener("click", () => {
  document.querySelector("#new-actor-form").hidden = false;
  document.querySelector("#new-actor-name").focus();
});
document.querySelector("#cancel-new-actor").addEventListener("click", () => { document.querySelector("#new-actor-form").hidden = true; });
document.querySelector("#new-actor-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.querySelector("#new-actor-name");
  const displayName = input.value.trim();
  if (!displayName) return;
  const response = await fetch("/api/actors", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName }) });
  const result = await response.json();
  if (!response.ok) { elements.actorRole.textContent = result.error || "Could not add participant."; return; }
  input.value = "";
  document.querySelector("#new-actor-form").hidden = true;
  await loadState();
  elements.actorSelect.value = result.actor.id;
  renderActorRole();
});

const events = new EventSource("/api/events");
events.onmessage = (event) => { const message = JSON.parse(event.data); if (!state.messages.some((item) => item.id === message.id)) { state.messages.push(message); renderMessages(); } };
events.onerror = () => { elements.clockLabel.textContent = "Reconnecting to local transport..."; };

const activityEvents = new EventSource("/api/activity-events");
activityEvents.onmessage = (event) => {
  const activity = JSON.parse(event.data);
  if (!state.activity.some((item) => item.id === activity.id)) {
    state.activity.push(activity);
    renderActivity();
  }
};

// Keep asynchronous scheduler and obligation transitions current without
// repeatedly loading chat history or actor data.
setInterval(() => {
  if (document.querySelector("#operations-view").classList.contains("active")) {
    void loadOperations().catch(() => undefined);
  }
}, 2000);

function initials(value) { return value.split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase(); }
function shorten(value, max) { return value.length > max ? `${value.slice(0, max - 3)}...` : value; }
function readable(value) { return String(value).replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dateParts(value) { const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/); return match ? { year: match[1], month: Number(match[2]), day: Number(match[3]), hour: match[4], minute: match[5] } : null; }
function formatTime(value) { const parts = dateParts(value); return parts?.hour ? `${parts.hour}:${parts.minute}` : ""; }
function formatDate(value) { const parts = dateParts(value); return parts ? `${parts.day} ${monthNames[parts.month - 1]} ${parts.year}` : String(value); }
function formatDateTime(value) { if (!value) return "Not set"; const parts = dateParts(value); return parts ? `${parts.day} ${monthNames[parts.month - 1]} ${parts.year}${parts.hour ? `, ${parts.hour}:${parts.minute}` : ""}` : String(value); }
function toDateTimeLocal(value) { const parts = dateParts(value); return parts?.hour ? `${parts.year}-${String(parts.month).padStart(2, "0")}-${parts.day}T${parts.hour}:${parts.minute}` : ""; }
function escapeHtml(value) { const node = document.createElement("div"); node.textContent = value; return node.innerHTML; }
function formatActivityValue(value) {
  if (value === null || value === undefined) return "Not set";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

loadState().catch((error) => { elements.messages.innerHTML = `<div class="empty-state error-text">${escapeHtml(error.message)}</div>`; });
