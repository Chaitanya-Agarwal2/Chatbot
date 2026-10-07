import os
from datetime import timedelta
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
    MAX_CONTENT_LENGTH=64 * 1024,
)

if ON_RENDER:
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1)

# ---------- 3. Rate limiter ----------
limiter = Limiter(get_remote_address, app=app, storage_uri="memory://")

# ---------- 4. Groq ----------
client = Groq(api_key=GROQ_API_KEY)
MODEL = "openai/gpt-oss-120b"  # if you get "model not found", check console.groq.com/docs/models
SYSTEM_PROMPT = "You are a friendly, helpful assistant. Keep answers clear and concise."

MAX_MESSAGES = 20
MAX_CHARS = 2000


# ---------- 5. Login protection ----------
def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get("logged_in"):
            if request.path == "/chat":
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
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for m in data["messages"][-MAX_MESSAGES:]:
        role = m.get("role")
        text = m.get("text")
        if role not in ("user", "model") or not isinstance(text, str):
            return jsonify(error="Bad request"), 400
        if not text.strip() or len(text) > MAX_CHARS:
            return jsonify(error="Message empty or too long"), 400
        messages.append({
            "role": "assistant" if role == "model" else "user",
            "content": text,
        })

    if messages[-1]["role"] != "user":
        return jsonify(error="Bad request"), 400

    try:
        response = client.chat.completions.create(model=MODEL, messages=messages)
        reply = response.choices[0].message.content
        return jsonify(reply=reply or "(no reply)")
    except Exception as e:
        print("Groq error:", e)
        return jsonify(error="The AI had a problem. Try again."), 502


if __name__ == "__main__":
    app.run(debug=False)