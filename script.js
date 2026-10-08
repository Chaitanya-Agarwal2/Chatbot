function renderMarkdown(text) {
  const html = marked.parse(text, { breaks: true });
  // Block anything that makes the browser fetch a URL by itself (images, media,
  // inline styles). A malicious web page could otherwise trick the model into
  // writing an image link that carries chat data out to an attacker's server.
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["img", "picture", "source", "video", "audio", "iframe", "object", "embed", "svg", "style"],
    FORBID_ATTR: ["style", "srcset", "src"],
  });
}

// ---------- File cards ----------
// The model writes files as:  [[FILE: name.ext]] ...content... [[/FILE]]
const FILE_RE = /\[\[FILE:\s*([^\]\n]+?)\s*\]\]\r?\n?([\s\S]*?)(?:\r?\n?\[\[\/FILE\]\]|$)/g;

// Strip folders and odd characters so a file can never be saved somewhere unexpected
function cleanFileName(raw) {
  const name = raw.split(/[\\/]/).pop().replace(/[^\w.\- ]+/g, "_").trim().replace(/^\.+/, "");
  return (name || "file.txt").slice(0, 80);
}

function downloadFile(name, content) {
  // text/plain means the browser saves it and never runs it
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildFileCard(rawName, rawContent) {
  const name = cleanFileName(rawName);
  const content = rawContent.replace(/\s+$/, "") + "\n";
  const ext = name.includes(".") ? name.split(".").pop().toUpperCase() : "TXT";
  const lines = content.split("\n").length - 1;

  const card = document.createElement("div");
  card.className = "file-card";

  const icon = document.createElement("span");
  icon.className = "file-icon";
  icon.setAttribute("aria-hidden", "true");

  const info = document.createElement("div");
  info.className = "file-info";
  const title = document.createElement("div");
  title.className = "file-name";
  title.textContent = name;
  const meta = document.createElement("div");
  meta.className = "file-meta";
  meta.textContent = ext + " \u00b7 " + lines + (lines === 1 ? " line" : " lines");
  info.append(title, meta);

  const actions = document.createElement("div");
  actions.className = "file-actions";

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "ghost";
  copy.textContent = "Copy";
  let timer;
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(content);
      copy.textContent = "Copied";
    } catch (e) {
      copy.textContent = "Failed";
    }
    clearTimeout(timer);
    timer = setTimeout(() => { copy.textContent = "Copy"; }, 1500);
  });

  const download = document.createElement("button");
  download.type = "button";
  download.textContent = "Download";
  download.addEventListener("click", () => downloadFile(name, content));

  actions.append(copy, download);
  card.append(icon, info, actions);
  return card;
}

// Fills a bot message: normal text becomes sanitized Markdown, file blocks become cards
function renderReply(container, text) {
  container.textContent = "";

  const addText = (chunk) => {
    if (!chunk.trim()) return;
    const tpl = document.createElement("template");
    tpl.innerHTML = renderMarkdown(chunk);   // sanitized by DOMPurify
    container.appendChild(tpl.content);
  };

  let last = 0;
  let m;
  FILE_RE.lastIndex = 0;
  while ((m = FILE_RE.exec(text)) !== null) {
    addText(text.slice(last, m.index));
    container.appendChild(buildFileCard(m[1], m[2]));
    last = m.index + m[0].length;
    if (m[0].length === 0) FILE_RE.lastIndex++;
  }
  addText(text.slice(last));
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
const limitsDiv = document.getElementById("limits");

// Shows what's left of Groq's free limits, using numbers the server read from Groq's headers
function showLimits(l) {
  if (!l) return;
  const parts = [];
  if (l.tokens_left != null && l.tokens_limit) {
    let t = "Tokens left this minute: " + l.tokens_left.toLocaleString() + " / " + l.tokens_limit.toLocaleString();
    if (l.tokens_reset) t += " (resets in " + l.tokens_reset + ")";
    parts.push(t);
  }
  if (l.requests_left != null) parts.push("Requests left today: " + l.requests_left.toLocaleString());
  if (l.used != null) parts.push("Last reply used " + l.used.toLocaleString() + " tokens");
  if (!parts.length) return;
  limitsDiv.textContent = parts.join(" \u00b7 ");
  limitsDiv.hidden = false;
  limitsDiv.classList.toggle("low", !!(l.tokens_limit && l.tokens_left != null && l.tokens_left / l.tokens_limit < 0.15));
}

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

    showLimits(data.limits);

    if (response.ok && data.reply) {
      thinking.classList.remove("pending");
      renderReply(thinking, data.reply);
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
