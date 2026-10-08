import json
import os
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse
from functools import wraps

import bcrypt
from dotenv import load_dotenv
from flask import Flask, request, session, jsonify, render_template, redirect, url_for
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from groq import Groq
from werkzeug.middleware.proxy_fix import ProxyFix

# ---------- 1. Load secrets ----------
load_dotenv()
GROQ_API_KEY = os.environ["GROQ_API_KEY"]
PASSWORD_HASH = os.environ["PASSWORD_HASH"].encode()
SECRET_KEY = os.environ["SECRET_KEY"]

ON_RENDER = os.environ.get("RENDER") is not None

# ---------- 2. App + cookie security ----------
app = Flask(__name__)
app.secret_key = SECRET_KEY
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=ON_RENDER,
    PERMANENT_SESSION_LIFETIME=timedelta(hours=1),
    MAX_CONTENT_LENGTH=16 * 1024 * 1024,  # raised so long chats aren't rejected
)

if ON_RENDER:
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1)

# ---------- 3. Rate limiter ----------
limiter = Limiter(get_remote_address, app=app, storage_uri="memory://")

# ---------- 4. Groq ----------
client = Groq(api_key=GROQ_API_KEY)
MODEL = "openai/gpt-oss-120b"  # if you get "model not found", check console.groq.com/docs/models
IST = timezone(timedelta(hours=5, minutes=30))  # India Standard Time (no daylight saving)


def build_system_prompt():
    """Rebuilt on every message so the model always knows the real date and time."""
    now = datetime.now(IST)
    stamp = now.strftime("%A, %d %B %Y, %I:%M %p")
    return (
        "You are a friendly, helpful assistant. Keep answers clear and concise.\n\n"
        f"The current date and time is {stamp} IST (India Standard Time). "
        "This is the true current date. Your training data is older than this, "
        "so never assume the year from memory.\n\n"
        "Rules for facts:\n"
        "- For the date or time, use the value above. Do not search for it. "
        "If asked for the time in another place, calculate it from the IST time above.\n"
        "- For news, prices, scores, weather, who currently holds a job or title, "
        "or anything recent, search the web before answering. Do not answer from memory.\n"
        "- When you search, include the current year or the word 'today' in your query, "
        "and prefer the newest results from reliable sources. Check the date of each result.\n"
        "- If sources disagree, or you cannot find a reliable answer, say so honestly "
        "instead of guessing."
    )

MAX_MESSAGES = 20



def collect_sources(message, limit=None):
    """Pull the pages the model looked at out of Groq's executed_tools data."""
    try:
        tools = message.model_dump().get("executed_tools") or []
    except Exception:
        return []

    found = {}  # url -> title

    def walk(obj):
        if isinstance(obj, dict):
            url = obj.get("url")
            if isinstance(url, str) and url.startswith(("http://", "https://")):
                found.setdefault(url, obj.get("title") or "")
            for key, value in obj.items():
                if key != "live_view_url":
                    walk(value)
        elif isinstance(obj, list):
            for item in obj:
                walk(item)

    walk(tools)

    # Fallback: scan the raw tool output text for links
    if not found and tools:
        for url in re.findall(r"https?://[^\s\"'<>)\]]+", json.dumps(tools)):
            found.setdefault(url.rstrip(".,"), "")

    if not found and tools:
        print("executed_tools had no URLs. Raw data:", json.dumps(tools)[:1500])

    sources = []
    for url, title in found.items():
        host = urlparse(url).netloc.removeprefix("www.")
        sources.append({"url": url, "title": title.strip() or host})
        if limit and len(sources) >= limit:
            break
    return sources


# ---------- 5. Login protection ----------
def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get("logged_in"):
            if request.path in ("/chat",):
                return jsonify(error="Not logged in"), 401
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return wrapper


@app.route("/login", methods=["GET", "POST"])
@limiter.limit("5 per 15 minutes", methods=["POST"])
def login():
    if request.method == "POST":
        password = request.form.get("password", "").encode()
        if bcrypt.checkpw(password, PASSWORD_HASH):
            session.clear()
            session["logged_in"] = True
            session.permanent = True
            return redirect(url_for("index"))
        return render_template("login.html", error="Wrong password."), 401
    return render_template("login.html")


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return redirect(url_for("login"))


# ---------- 6. Pages ----------
@app.route("/")
@login_required
def index():
    return render_template("chat.html")



# ---------- 7. Chat endpoint ----------
@app.route("/chat", methods=["POST"])
@login_required
@limiter.limit("20 per minute")
def chat():
    data = request.get_json(silent=True)
    if not data or not isinstance(data.get("messages"), list):
        return jsonify(error="Bad request"), 400

    # Groq uses the roles "system", "user" and "assistant"
    messages = [{"role": "system", "content": build_system_prompt()}]
    for m in data["messages"][-MAX_MESSAGES:]:
        role = m.get("role")
        text = m.get("text")
        if role not in ("user", "model") or not isinstance(text, str):
            return jsonify(error="Bad request"), 400
        if not text.strip():
            return jsonify(error="Message is empty"), 400
        messages.append({
            "role": "assistant" if role == "model" else "user",
            "content": text,
        })

    if messages[-1]["role"] != "user":
        return jsonify(error="Bad request"), 400

    try:
        raw = client.chat.completions.with_raw_response.create(
            model=MODEL,
            messages=messages,
            tools=[{"type": "browser_search"}],  # Groq's built-in web search
            tool_choice="auto",                  # the model searches only when it needs to
            reasoning_effort="medium",           # more careful searching and checking
        )
        response = raw.parse()
        reply = response.choices[0].message.content or ""
        # Search results add citation markers like 【2†L6-L10】; strip them
        reply = re.sub(r"【[^】]*】", "", reply).strip()

        sources = collect_sources(response.choices[0].message)
        return jsonify(reply=reply or "(no reply)", sources=sources)
    except Exception as e:
        print("Groq error:", e)
        return jsonify(error="The AI had a problem. Try again."), 502


if __name__ == "__main__":
    app.run(debug=False)