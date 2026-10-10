// Motion for the calculations site. Loaded in <head> on every page.
// Each chart animates once, when it first scrolls into view. The CSS for
// every state lives in style.css; this file only decides *when*.
(function () {
  "use strict";

  var root = document.documentElement;
  root.classList.add("js");

  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var GROUPS = "svg.diagram, .bars, .flow, table.heat, [data-anim-group]";

  function countUp(el) {
    var target = el.getAttribute("data-count");
    var end = parseFloat(target);
    if (!isFinite(end)) return;
    var decimals = (target.split(".")[1] || "").length;
    var prefix = el.getAttribute("data-prefix") || "";
    var suffix = el.getAttribute("data-suffix") || "";
    var show = function (v) { el.textContent = prefix + v.toFixed(decimals) + suffix; };
    if (reduce) { show(end); return; }
    var start = performance.now();
    var duration = 900;
    show(0);
    var tick = function (now) {
      var t = Math.min(1, (now - start) / duration);
      var eased = 1 - Math.pow(1 - t, 4);
      show(end * eased);
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function enter(group) {
    group.setAttribute("data-in", "");
    var counters = group.matches("[data-count]") ? [group] : group.querySelectorAll("[data-count]");
    Array.prototype.forEach.call(counters, countUp);
    group.dispatchEvent(new CustomEvent("enter"));
  }

  function prepare(group) {
    if (group.matches("svg.diagram") && !group.querySelector("[data-anim]")) {
      group.classList.add("wipe");
    }
    group.querySelectorAll('[data-anim="draw"]').forEach(function (el) {
      el.setAttribute("pathLength", "1");
    });
    if (group.matches(".bars")) {
      group.querySelectorAll(".bar-fill").forEach(function (el, i) { el.style.setProperty("--i", i); });
    }
    if (group.matches(".flow")) {
      Array.prototype.forEach.call(group.children, function (el, i) { el.style.setProperty("--i", i); });
    }
    if (group.matches("table.heat")) {
      group.querySelectorAll("tr").forEach(function (row, r) {
        row.querySelectorAll("td.num").forEach(function (cell, c) { cell.style.setProperty("--i", r + c); });
      });
    }
  }

  function init() {
    var bar = document.createElement("div");
    bar.className = "progress";
    bar.setAttribute("aria-hidden", "true");
    document.body.appendChild(bar);

    var groups = document.querySelectorAll(GROUPS + ", [data-count]");
    groups.forEach(prepare);

    if (!("IntersectionObserver" in window)) {
      groups.forEach(enter);
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        io.unobserve(entry.target);
        enter(entry.target);
      });
    }, {
      // the huge top margin counts anything already scrolled past as seen,
      // so a fast scroll or an anchor jump never leaves a chart hidden
      rootMargin: "100000px 0px -12% 0px",
      threshold: 0.2
    });
    groups.forEach(function (g) {
      // a counter inside a group starts with its group
      if (g.matches("[data-count]") && g.parentElement && g.parentElement.closest(GROUPS)) return;
      io.observe(g);
    });

    // replay buttons: <button data-replay="#id">
    document.querySelectorAll("[data-replay]").forEach(function (button) {
      button.addEventListener("click", function () {
        var target = document.querySelector(button.getAttribute("data-replay"));
        if (!target) return;
        // jump back to the start without playing the reverse
        target.classList.add("reset");
        target.removeAttribute("data-in");
        void target.getBoundingClientRect();
        target.classList.remove("reset");
        requestAnimationFrame(function () { enter(target); });
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
