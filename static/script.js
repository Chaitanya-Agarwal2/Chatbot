function renderMarkdown(text) {
  const html = marked.parse(text, { breaks: true });
  // Block anything that makes the browser fetch a URL by itself (images, media, inline styles)
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["img", "picture", "source", "video", "audio", "iframe", "object", "embed", "svg", "style"],
    FORBID_ATTR: ["style", "srcset", "src"],
  });
}

const messagesDiv = document.getElementById("messages");
const form = document.getElementById("chat-form");
const input = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");
const chips = document.getElementById("faq-chips");

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

// Clicking a suggested question sends it like a normal message
document.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip || sendBtn.disabled) return;
  input.value = chip.textContent.trim();
  form.requestSubmit();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();          // stop the page from reloading

  const text = input.value.trim();
  if (!text) return;

  if (chips) chips.remove();       // suggestions disappear once the chat starts
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
      thinking.innerHTML = renderMarkdown(data.reply);   // sanitized by DOMPurify
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

// Double-click the logo to see the project's problem statement
const aboutDialog = document.getElementById("about-dialog");
document.querySelector(".brand .logo").addEventListener("dblclick", () => aboutDialog.showModal());
aboutDialog.addEventListener("click", (e) => {
  if (e.target === aboutDialog) aboutDialog.close();   // click outside the box closes it
});
