const generateBtn = document.getElementById("generateBtn");
const rotateTopicBtn = document.getElementById("rotateTopicBtn");
const useTypedTopicBtn = document.getElementById("useTypedTopicBtn");
const customTopicInput = document.getElementById("customTopicInput");
const selectedTopic = document.getElementById("selectedTopic");
const statusText = document.getElementById("statusText");
const topicText = document.getElementById("topicText");
const postText = document.getElementById("postText");
const statusPanel = document.getElementById("statusPanel");
const terminalPanel = document.getElementById("terminalPanel");
const terminalMode = document.getElementById("terminalMode");
const stageRow = document.getElementById("stageRow");
const logs = document.getElementById("logs");
const messageBox = document.getElementById("messageBox");
const messageLabel = document.getElementById("messageLabel");
const messageTitle = document.getElementById("messageTitle");
const messageMeta = document.getElementById("messageMeta");
const messageActions = document.getElementById("messageActions");
let previousRunning = false;
let availableTopics = [];
let currentTopicIndex = 0;
let lastHandledFinish = "";
let statusPollTimer = null;

generateBtn.addEventListener("click", async () => {
  generateBtn.disabled = true;
  clearMessage();
  terminalPanel.hidden = false;
  statusPanel.hidden = false;
  terminalMode.textContent = "live";
  logs.textContent = `$ boot publisher\n$ preparing topic: ${getSelectedTopic() || "next topic"}\n`;
  updateStages({ running: true, logs: ["Researching: " + (getSelectedTopic() || "")] });
  previousRunning = true;
  const response = await fetch("/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      topic: getSelectedTopic() || ""
    })
  });
  const json = await response.json();
  if (!response.ok) {
    showErrorBox(json.message || "Could not start generation.");
    generateBtn.disabled = false;
    return;
  }
  startStatusPolling();
  await refreshStatus();
});

rotateTopicBtn.addEventListener("click", async () => {
  if (!availableTopics.length) return;
  currentTopicIndex = Math.floor(Math.random() * availableTopics.length);
  customTopicInput.value = "";
  renderSelectedTopic();
});

useTypedTopicBtn.addEventListener("click", () => {
  const value = customTopicInput.value.trim();
  if (!value) return;
  selectedTopic.textContent = value;
});

customTopicInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    useTypedTopicBtn.click();
  }
});

async function refreshStatus() {
  const response = await fetch("/status");
  const status = await response.json();

  statusText.textContent = status.running
    ? `Running${status.startedAt ? ` since ${new Date(status.startedAt).toLocaleTimeString()}` : ""}`
    : status.success === true
      ? "Completed"
      : status.success === false
        ? "Failed"
        : "Idle";

  topicText.textContent = status.currentTopic || status.lastOutput?.latestProcessedTopic || "-";

  if (status.lastOutput?.latestWordPressLink) {
    postText.innerHTML = `<a href="${status.lastOutput.latestWordPressLink}" target="_blank" rel="noopener noreferrer">${status.lastOutput.latestWordPressLink}</a>`;
  } else if (status.lastOutput?.latestHtmlFile) {
    postText.textContent = status.lastOutput.latestHtmlFile;
  } else {
    postText.textContent = "-";
  }

  logs.textContent = (status.logs || []).join("\n");
  terminalMode.textContent = status.running ? "streaming" : status.success === false ? "error" : "idle";
  updateStages(status);
  terminalPanel.hidden = !(status.running || (status.success === false && (status.logs || []).length));
  statusPanel.hidden = !status.running;
  generateBtn.disabled = status.running;
  rotateTopicBtn.disabled = status.running;
  useTypedTopicBtn.disabled = status.running;
  customTopicInput.disabled = status.running;

  if (!status.running && status.finishedAt && status.finishedAt !== lastHandledFinish) {
    lastHandledFinish = status.finishedAt;
    stopStatusPolling();
    if (status.success) {
      terminalPanel.hidden = true;
      showSuccessBox(status);
    } else if (status.success === false) {
      terminalPanel.hidden = false;
      const errorText = (status.logs || []).slice(-30).join("\n");
      showErrorBox(errorText || "Generation failed.");
    }
  }

  previousRunning = status.running;
}

async function loadTopics() {
  const response = await fetch("/topics");
  const json = await response.json();
  availableTopics = json.topics || [];
  currentTopicIndex = 0;
  renderSelectedTopic();
}

function renderSelectedTopic() {
  selectedTopic.textContent = getSelectedTopic() || "No topics available";
}

loadTopics();
renderIdleState();

function clearMessage() {
  messageBox.hidden = true;
  messageBox.className = "message-box";
  messageLabel.textContent = "Status";
  messageTitle.textContent = "-";
  messageMeta.textContent = "";
  messageActions.innerHTML = "";
}

function renderIdleState() {
  statusPanel.hidden = true;
  terminalPanel.hidden = true;
  generateBtn.disabled = false;
  rotateTopicBtn.disabled = false;
  useTypedTopicBtn.disabled = false;
  customTopicInput.disabled = false;
  statusText.textContent = "Idle";
  topicText.textContent = "-";
  postText.textContent = "-";
  terminalMode.textContent = "idle";
  logs.textContent = "";
  updateStages({ running: false, success: null, logs: [] });
}

function startStatusPolling() {
  stopStatusPolling();
  statusPollTimer = setInterval(() => {
    refreshStatus().catch((error) => {
      stopStatusPolling();
      showErrorBox(error?.message || "Could not refresh job status.");
      generateBtn.disabled = false;
      rotateTopicBtn.disabled = false;
      useTypedTopicBtn.disabled = false;
      customTopicInput.disabled = false;
    });
  }, 2500);
}

function stopStatusPolling() {
  if (statusPollTimer) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }
}

function showSuccessBox(status) {
  messageBox.hidden = false;
  messageBox.className = "message-box success";
  messageLabel.textContent = "Published";
  messageTitle.textContent = status.currentTopic || status.lastOutput?.latestProcessedTopic || "Article published";
  messageMeta.innerHTML = status.lastOutput?.latestWordPressLink
    ? `Post published successfully. <a href="${status.lastOutput.latestWordPressLink}" target="_blank" rel="noopener noreferrer">Open post</a>`
    : "Article generation completed successfully.";
  messageActions.innerHTML = "";
  updateStages({ running: false, success: true, logs: status.logs || [] });
}

function showErrorBox(errorText) {
  messageBox.hidden = false;
  messageBox.className = "message-box error";
  messageLabel.textContent = "Error";
  messageTitle.textContent = "Generation failed";
  messageMeta.textContent = truncate(errorText, 900);
  messageActions.innerHTML = "";

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "copy-button";
  copyButton.textContent = "Copy error";
  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(errorText);
      copyButton.textContent = "Copied";
      setTimeout(() => {
        copyButton.textContent = "Copy error";
      }, 1600);
    } catch {
      copyButton.textContent = "Copy failed";
    }
  });
  messageActions.appendChild(copyButton);
}

function getSelectedTopic() {
  const typed = customTopicInput.value.trim();
  if (typed) return typed;
  return availableTopics[currentTopicIndex] || "";
}

function updateStages(status) {
  const text = (status.logs || []).join("\n").toLowerCase();
  const stageElements = [...stageRow.querySelectorAll(".stage")];

  const states = {
    topic: text.includes("researching:"),
    search: text.includes("trying search engine"),
    research: text.includes("reading source"),
    write: text.includes("ai model selected"),
    upload: text.includes("image skipped") || text.includes("media upload") || text.includes("upload"),
    publish: text.includes("wordpress post created") || text.includes("published successfully")
  };

  for (const element of stageElements) {
    const key = element.dataset.stage;
    element.classList.remove("active", "done");

    if (status.success && key) {
      element.classList.add("done");
      continue;
    }

    if (!key) continue;
    if (states[key]) {
      element.classList.add(status.running ? "active" : "done");
    }
  }
}

function truncate(value, maxLength) {
  if (!value || value.length <= maxLength) return value;
  return value.slice(0, maxLength) + "\n\n...";
}
