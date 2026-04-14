const generateBtn = document.getElementById("generateBtn");
const statusText = document.getElementById("statusText");
const topicText = document.getElementById("topicText");
const postText = document.getElementById("postText");
const terminalPanel = document.getElementById("terminalPanel");
const logs = document.getElementById("logs");
let previousRunning = false;
let lastFailureSignature = "";
let lastSuccessSignature = "";

generateBtn.addEventListener("click", async () => {
  generateBtn.disabled = true;
  const response = await fetch("/generate", { method: "POST" });
  const json = await response.json();
  if (!response.ok) {
    alert(json.message || "Could not start generation.");
    generateBtn.disabled = false;
    return;
  }
  await refreshStatus();
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
  terminalPanel.hidden = !status.running;
  generateBtn.disabled = status.running;

  if (previousRunning && !status.running) {
    if (status.success) {
      const successSignature = `${status.finishedAt || ""}|${status.lastOutput?.latestWordPressLink || status.lastOutput?.latestHtmlFile || ""}`;
      if (successSignature && successSignature !== lastSuccessSignature) {
        lastSuccessSignature = successSignature;
        alert(status.lastOutput?.latestWordPressLink
          ? `Post published successfully:\n${status.lastOutput.latestWordPressLink}`
          : "Post generation completed successfully.");
      }
    } else if (status.success === false) {
      const errorText = (status.logs || []).slice(-20).join("\n");
      const failureSignature = `${status.finishedAt || ""}|${errorText}`;
      if (failureSignature && failureSignature !== lastFailureSignature) {
        lastFailureSignature = failureSignature;
        showErrorPopup(errorText || "Generation failed.");
      }
    }
  }

  previousRunning = status.running;
}

setInterval(refreshStatus, 2500);
refreshStatus();

function showErrorPopup(errorText) {
  const shouldCopy = confirm(
    `Generation failed.\n\nPress OK to copy the error.\nPress Cancel to dismiss.\n\n${truncate(errorText, 900)}`
  );

  if (shouldCopy) {
    navigator.clipboard.writeText(errorText).then(() => {
      alert("Error copied.");
    }).catch(() => {
      alert("Could not copy automatically. Error:\n\n" + errorText);
    });
  }
}

function truncate(value, maxLength) {
  if (!value || value.length <= maxLength) return value;
  return value.slice(0, maxLength) + "\n\n...";
}
