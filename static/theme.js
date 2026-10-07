// Loaded in <head> on both pages, without defer, so the theme is set before first paint.
(function () {
  var root = document.documentElement;
  var saved = null;
  try { saved = localStorage.getItem("theme"); } catch (e) {}
  var theme = saved || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  root.setAttribute("data-theme", theme);

  function label() {
    var next = root.getAttribute("data-theme") === "dark" ? "Light" : "Dark";
    document.querySelectorAll("[data-theme-toggle]").forEach(function (b) {
      b.textContent = next;
    });
  }

  document.addEventListener("DOMContentLoaded", label);

  document.addEventListener("click", function (e) {
    if (!e.target.closest("[data-theme-toggle]")) return;
    var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("theme", next); } catch (err) {}
    label();
  });
})();
