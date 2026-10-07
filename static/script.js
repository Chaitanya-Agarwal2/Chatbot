function renderMarkdown(text) {
  const html = marked.parse(text, { breaks: true });
  return DOMPurify.sanitize(html);
}

const messagesDiv = document.getElementById("messages");
const form = document.getElementById("chat-form");
const input = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");

// The conversation so far, in the format app.py expects
let history = [];

function addMessage(text, type) {
  const div = document.createElement("div");
  div.className = "msg " + type;
  div.textContent = text;          // textContent is safe: it never runs HTML
  messagesDiv.appendChild(div);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
  return div;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();          // stop the page from reloading

  const text = input.value.trim();
  if (!text) return;

  addMessage(text, "user");
  history.push({ role: "user", text: text });
  input.value = "";
  sendBtn.disabled = true;
  input.disabled = true;

  const thinking = addMessage("Thinking...", "bot");

  try {
    const response = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history }),
    });

    if (response.status === 401) {
      window.location.href = "/login";   // session expired
      return;
    }

    let data = {};
    try {
      data = await response.json();
    } catch (e) {
      // the server sent something that isn't JSON (like the rate limit page)
    }

    if (response.ok && data.reply) {
      thinking.innerHTML = renderMarkdown(data.reply);
      history.push({ role: "model", text: data.reply });
    } else {
      throw new Error(
        response.status === 429
          ? "Too many messages. Wait a minute and try again."
          : data.error || "Something went wrong."
      );
    }
  } catch (err) {
    thinking.className = "msg error";
    thinking.textContent = err.message || "Could not reach the server.";
    history.pop();                 // remove the failed question so history stays valid
  } finally {
    sendBtn.disabled = false;
    input.disabled = false;
    input.focus();
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }
});