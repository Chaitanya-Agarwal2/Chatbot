function renderMarkdown(text) {
  const html = marked.parse(text, { breaks: true });
  return DOMPurify.sanitize(html);
}

// Wraps each <pre> in a header bar with a language label and a Copy button.
// Runs after DOMPurify, so it never touches unsanitized HTML.
function enhanceCodeBlocks(container) {
  container.querySelectorAll("pre").forEach((pre) => {
    if (pre.parentElement.classList.contains("code-block")) return;

    const code = pre.querySelector("code");
    const match = code && /language-([\w+#-]+)/.exec(code.className);

    const wrapper = document.createElement("div");
    wrapper.className = "code-block";

    const head = document.createElement("div");
    head.className = "code-head";

    const lang = document.createElement("span");
    lang.textContent = match ? match[1] : "code";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ghost copy-btn";
    btn.textContent = "Copy";

    let timer;
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText((code || pre).textContent);
        btn.textContent = "Copied";
      } catch (e) {
        btn.textContent = "Failed";
      }
      clearTimeout(timer);
      timer = setTimeout(() => { btn.textContent = "Copy"; }, 1500);
    });

    head.append(lang, btn);
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.append(head, pre);
  });
}

const messagesDiv = document.getElementById("messages");
const form = document.getElementById("chat-form");
const input = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");

// The conversation so far, in the format app.py expects
let history = [];

function addMessage(text, type) {
  const row = document.createElement("div");
  row.className = "row " + type.split(" ")[0];

  const avatar = document.createElement("span");
  avatar.className = "avatar";
  avatar.setAttribute("aria-hidden", "true");

  const div = document.createElement("div");
  div.className = "msg " + type;
  div.textContent = text;          // textContent is safe: it never runs HTML

  row.append(avatar, div);
  messagesDiv.appendChild(row);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
  return div;
}

// Adds a collapsible "Sources" list under a bot reply
function addSources(msgDiv, sources) {
  const safe = (sources || []).filter((s) => /^https?:\/\//i.test(s.url));
  if (!safe.length) return;

  const details = document.createElement("details");
  details.className = "sources";

  const summary = document.createElement("summary");
  summary.textContent = "Sources (" + safe.length + ")";

  const list = document.createElement("ol");
  safe.forEach((s) => {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = s.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = s.title || s.url;
    li.appendChild(a);
    list.appendChild(li);
  });

  details.append(summary, list);
  msgDiv.appendChild(details);
}

// Grow the message box as the user types (CSS max-height caps it, then it scrolls)
function autoResize() {
  input.style.height = "auto";
  input.style.height = input.scrollHeight + 2 + "px";
}
input.addEventListener("input", autoResize);

// Enter sends, Shift+Enter adds a new line
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});

// Press "/" anywhere on the page to jump into the message box
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  e.preventDefault();
  input.focus();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();          // stop the page from reloading

  const text = input.value.trim();
  if (!text) return;

  addMessage(text, "user");
  history.push({ role: "user", text: text });
  input.value = "";
  autoResize();
  sendBtn.disabled = true;
  input.disabled = true;

  const thinking = addMessage("", "bot pending");
  thinking.innerHTML =
    '<span class="typing" role="status" aria-label="Assistant is typing"><i></i><i></i><i></i></span>';

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
      thinking.classList.remove("pending");
      thinking.innerHTML = renderMarkdown(data.reply);
      enhanceCodeBlocks(thinking);
      addSources(thinking, data.sources);
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
