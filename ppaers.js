// ==UserScript==
// @name         autopdf: one-click paper download
// @namespace    idea-map
// @version      2.0
// @description  "Get PDF" button on publisher article pages and a "PDF" link beside Google / Google Scholar results. Saves the PDF if you have access; otherwise signs in through the University of St Andrews first.
// @match        https://www.sciencedirect.com/*
// @match        https://onlinelibrary.wiley.com/*
// @match        https://www.jstor.org/*
// @match        https://academic.oup.com/*
// @match        https://www.tandfonline.com/*
// @match        https://link.springer.com/*
// @match        https://www.cambridge.org/*
// @match        https://www.journals.uchicago.edu/*
// @match        https://journals.sagepub.com/*
// @match        https://www.emerald.com/*
// @match        https://www.mdpi.com/*
// @match        https://www.google.com/search*
// @match        https://www.google.co.uk/search*
// @match        https://scholar.google.com/*
// @match        https://scholar.google.co.uk/*
// @match        https://wayf.springernature.com/*
// @match        https://id.elsevier.com/*
// @match        https://auth.elsevier.com/*
// @match        https://wayf.ukfederation.org.uk/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

// How it works
// - Publisher article page: a "Get PDF" button appears bottom right. Clicking it:
//   1. asks the site for the PDF itself; if a PDF comes back, it is saved straight to
//      Downloads (named by DOI), whatever Chrome's PDF viewer setting is;
//   2. if not (no access yet), it goes through the site's institutional sign-in and picks
//      University of St Andrews; if you are signed in at St Andrews you come straight
//      back and step 1 runs again;
//   3. sites where the PDF lives on another server (ScienceDirect) or behind a button
//      (JSTOR): it clicks the site's own PDF button in this tab.
// - Google and Google Scholar: a "PDF" link beside results from these publishers opens
//   the article and runs the same steps without a second click.
// - Tabs opened by fetch_papers.py end in #autopdf and work the same way. The flag is kept
//   in sessionStorage because some sites redirect and drop the #.
// - It never types passwords, ticks "verify you are human" boxes, accepts cookies or
//   terms: if one appears, do it yourself and the script carries on afterwards.
// - The button text says what is happening: Checking..., Signing in..., Saved, or No
//   access (then sign in by hand).

(function () {
  "use strict";
  const FLAG = "autopdf";
  const LOGINS = "autopdf-logins"; // sign-in clicks used in this tab (max 8, so no loops)
  const SSO = "autopdf-sso";       // time of the last direct jump to a sign-in page
  const host = location.hostname;
  const ss = {
    get: (k) => { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del: (k) => { try { sessionStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  // ---------- page helpers (they also look inside web components, as JSTOR uses) ----------
  const deepAll = (root = document, out = []) => {
    for (const e of root.querySelectorAll("*")) {
      out.push(e);
      if (e.shadowRoot) deepAll(e.shadowRoot, out);
    }
    return out;
  };
  const visible = (e) => e && e.getClientRects().length > 0;
  const text = (e) => (e.textContent || e.value || "").replace(/\s+/g, " ").trim();
  const meta = (n) => document.querySelector(`meta[name='${n}']`)?.content || "";
  const doi = () => {
    const m = meta("citation_doi") || meta("dc.identifier") || meta("DC.Identifier") ||
      (location.pathname.match(/\/doi\/(?:abs\/|full\/|epdf\/|pdf\/)?(10\.\d{4,9}\/[^?#]+)/) || [])[1] || "";
    return decodeURIComponent(m.replace(/^doi:/i, "").replace(/^https?:\/\/doi\.org\//, ""));
  };
  // Click the element, or the real button inside a web component.
  const press = (el) => {
    const inner = el.shadowRoot && el.shadowRoot.querySelector("a,button");
    const t = inner || el;
    // PDF links often open a new tab, which Chrome blocks when a script opens it late.
    if (t.tagName === "A") t.removeAttribute("target");
    console.log("[autopdf] clicking", t);
    t.click();
  };

  // ---------- where the PDF is ----------
  // {url}: ask for this address and save it if a PDF comes back.
  // {el}: click this element (PDF on another server, or behind the site's own button).
  const atyponPdf = () => (doi() ? { url: `/doi/pdf/${doi()}?download=true` } : null);
  const metaPdf = () => (meta("citation_pdf_url") ? { url: meta("citation_pdf_url") } : null);
  const PUBLISHERS = {
    // ScienceDirect: the PDF comes from another server; clicking "View PDF" works.
    // Match this article's own PII, not the "recommended articles" links.
    "www.sciencedirect.com": () => {
      const pii = (location.pathname.match(/\/pii\/(\w+)/) || [])[1];
      const a = pii && document.querySelector(`a[href*='/pii/${pii}/pdfft']`);
      return a ? { el: a } : null;
    },
    // Wiley: /doi/pdf/ opens the reader; pdfdirect gives the file (403 without access).
    "onlinelibrary.wiley.com": () => (doi() ? { url: `/doi/pdfdirect/${doi()}?download=true` } : null),
    // JSTOR: the Download button only shows when you have access.
    "www.jstor.org": () => {
      const b = document.querySelector("mfe-download-pharos-button[data-qa='download-pdf']");
      return b ? { el: b } : null;
    },
    "academic.oup.com": metaPdf,
    "www.tandfonline.com": atyponPdf,
    "link.springer.com": metaPdf,
    "www.cambridge.org": metaPdf,
    "www.journals.uchicago.edu": atyponPdf,
    "journals.sagepub.com": atyponPdf,
    "www.emerald.com": metaPdf,
    "www.mdpi.com": metaPdf,
  };
  // Sites whose institutional sign-in page can be opened directly (even when its link is
  // hidden in a menu).
  const LOGIN_URL = {
    atypon: () => `/action/ssostart?redirectUri=${encodeURIComponent(location.pathname + location.search)}`,
    "www.sciencedirect.com": () => `/user/institution/login?targetURL=${encodeURIComponent(location.pathname)}`,
  };
  for (const h of ["onlinelibrary.wiley.com", "www.tandfonline.com", "www.journals.uchicago.edu", "journals.sagepub.com"]) {
    LOGIN_URL[h] = LOGIN_URL.atypon;
  }
  const AUTH_HOSTS = ["wayf.springernature.com", "id.elsevier.com", "auth.elsevier.com", "wayf.ukfederation.org.uk"];

  // ---------- institutional sign-in (St Andrews) ----------
  const CLICKABLE = "a,button,li,[role=option],[role=button],[data-pharos-component]";
  const VIA_ANDREWS = /^(access|sign in|log ?in) (through|via|with) (the )?University of St\.? Andrews/i;
  const ANDREWS = /^(the )?University of St\.? Andrews(?! ?Alumni)/i;
  const INST = /^((access|sign in|log ?in|login) (through|via|with) (your |an |the )?(institution|organi[sz]ation|university|library|school)|institution(al)? (login|log in|sign in|access))/i;
  const GENERIC = /^(get access|check access)/i;
  const clicked = new WeakSet();
  let typed = null;

  // Visible, not clicked before; skipChrome also skips header/footer, where a signed-in
  // site shows "University of St Andrews" as a plain link.
  const findEl = (all, re, skipChrome = false, maxLen = 90) =>
    all.find((e) => {
      if (!e.matches || !e.matches(CLICKABLE) || clicked.has(e)) return false;
      const t = text(e);
      return t.length <= maxLen && re.test(t) && visible(e) &&
        !(skipChrome && e.closest("header, nav, footer, [role=banner], [role=contentinfo]"));
    });
  const findBox = (all, anyText) =>
    all.find((i) => {
      if (i.tagName !== "INPUT" || !/^(text|search|)$/.test(i.type) || i.value || !visible(i)) return false;
      if (/pass|mail|user/i.test(`${i.type} ${i.name} ${i.id} ${i.autocomplete}`)) return false; // never login fields
      const words = `${i.placeholder} ${i.getAttribute("aria-label")} ${i.name} ${i.id} ` +
        [...(i.labels || [])].map(text).join(" ") + " " + (i.getRootNode().host?.getAttribute("label") || "");
      return anyText || /institution|organi[sz]ation|university|library/i.test(words);
    });

  // One sign-in step, or null if there is nothing to do on this page.
  const loginStep = () => {
    const used = +(ss.get(LOGINS) || 0);
    if (used >= 8) return null;
    const onAuth = AUTH_HOSTS.includes(host);
    const inLogin = used > 0 || onAuth;
    const all = deepAll();
    const count = () => ss.set(LOGINS, used + 1);
    const clickStep = (el) => el && (() => { clicked.add(el); count(); press(el); });

    const via = findEl(all, VIA_ANDREWS);
    if (via) return clickStep(via);
    if (inLogin) {
      const pick = findEl(all, ANDREWS, true);
      if (pick) return clickStep(pick);
      const box = findBox(all, onAuth);
      if (box) return () => {
        count();
        typed = box;
        box.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(box, "University of St Andrews");
        for (const ev of ["input", "change"]) box.dispatchEvent(new Event(ev, { bubbles: true, composed: true }));
        box.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, composed: true, key: "s" }));
      };
    }
    // Before typing, a sign-in page's own submit button would send an empty search.
    const inst = findEl(all, INST);
    if (inst && !(inLogin && findBox(all, onAuth) && !typed)) return clickStep(inst);
    const gen = findEl(all, GENERIC);
    if (gen) return clickStep(gen);
    return null;
  };

  // ---------- saving ----------
  // Ask for the PDF. Returns "saved", "nopdf" (HTML, 403, 204: no access) or "other"
  // (another server, or the request failed: let the site handle it).
  const fetchPdf = async (url) => {
    let r;
    try {
      r = await fetch(url, { credentials: "include" });
    } catch (e) {
      return "other";
    }
    const type = r.headers.get("content-type") || "";
    if (!r.ok || !/pdf|octet-stream/i.test(type)) {
      if (r.body) r.body.cancel();
      return "nopdf";
    }
    const blob = await r.blob();
    const head = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
    if (String.fromCharCode(...head) !== "%PDF-") return "nopdf";
    const name = (doi() || document.title || "paper").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 120) + ".pdf";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 30000);
    console.log("[autopdf] saved", name);
    return "saved";
  };

  // ---------- page types ----------
  if (/(^|\.)google\./.test(host)) addSearchLinks();
  else if (AUTH_HOSTS.includes(host)) authPage();
  else publisherPage();

  // Institution chooser on another domain: St Andrews steps only.
  function authPage() {
    let n = 0;
    const t = setInterval(() => {
      const step = loginStep();
      if (step) step();
      if (++n > 40) clearInterval(t);
    }, 1500);
  }

  function publisherPage() {
    if (location.hash.includes(FLAG)) ss.set(FLAG, "1");
    const where = PUBLISHERS[host] || metaPdf;
    let busy = false;
    let probed = null; // result of asking for the PDF on this page

    const finish = (label) => {
      ss.del(FLAG);
      ss.del(LOGINS);
      ss.del(SSO);
      setLabel(label);
    };

    // One step of the whole job. Runs every 1.5 s while the job is on.
    const act = async () => {
      if (busy) return;
      busy = true;
      try {
        const w = where();
        if (w && w.el) { press(w.el); return finish("Opening PDF"); }
        if (w && w.url && probed === null) {
          setLabel("Checking...");
          probed = await fetchPdf(new URL(w.url, location.href).href);
          if (probed === "saved") return finish("Saved");
          if (probed === "other") { location.href = w.url; return finish("Opening PDF"); }
        }
        // No access yet: sign in.
        const step = loginStep();
        if (step) { setLabel("Signing in..."); return step(); }
        const jump = LOGIN_URL[host];
        const last = +(ss.get(SSO) || 0);
        if (jump && Date.now() - last > 120000 && +(ss.get(LOGINS) || 0) < 8) {
          ss.set(SSO, Date.now());
          ss.set(LOGINS, +(ss.get(LOGINS) || 0) + 1);
          setLabel("Signing in...");
          location.href = jump();
          return;
        }
        if (probed === "nopdf" || !w) {
          // Nothing left to try here: leave it to you.
          if (++stuck > 6) finish("No access: sign in by hand");
        }
      } finally {
        busy = false;
      }
    };
    let stuck = 0;

    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (ss.get(FLAG) === "1") act();
      else if (!document.getElementById("autopdf-btn") &&
               (where() || findEl(deepAll(), INST) || findEl(deepAll(), GENERIC))) {
        showButton(() => { ss.set(FLAG, "1"); ss.del(LOGINS); probed = null; stuck = 0; act(); });
      }
      if (tries > 120) clearInterval(timer);
    }, 1500);
  }

  function setLabel(s) {
    const b = document.getElementById("autopdf-btn");
    if (b) b.textContent = s;
    else if (s) console.log("[autopdf]", s);
  }

  function showButton(onClick) {
    if (document.getElementById("autopdf-btn")) return;
    const b = document.createElement("button");
    b.id = "autopdf-btn";
    b.textContent = "Get PDF";
    b.title = "autopdf: save the PDF, signing in through St Andrews if needed";
    Object.assign(b.style, {
      position: "fixed", right: "18px", bottom: "18px", zIndex: 2147483647,
      padding: "8px 14px", font: "600 13px/1.2 system-ui, sans-serif",
      color: "#fff", background: "#2f5d8a", border: "none", borderRadius: "6px",
      boxShadow: "0 2px 6px rgba(0,0,0,.25)", cursor: "pointer",
    });
    b.addEventListener("click", (e) => {
      e.preventDefault();
      onClick();
    });
    document.body.appendChild(b);
  }

  // ---------- Google / Google Scholar results ----------
  function addSearchLinks() {
    const supported = Object.keys(PUBLISHERS);
    // Google sometimes wraps links as /url?q=<target>.
    const realUrl = (a) => {
      try {
        const u = new URL(a.href, location.href);
        if (u.pathname === "/url") return new URL(u.searchParams.get("q") || u.searchParams.get("url"));
        return u;
      } catch (e) {
        return null;
      }
    };
    const scan = () => {
      // Google: result title anchors contain an h3. Scholar: h3.gs_rt > a.
      const anchors = [
        ...document.querySelectorAll("#search a:has(h3)"),
        ...document.querySelectorAll("h3.gs_rt > a"),
      ];
      for (const a of anchors) {
        if (a.dataset.autopdf) continue;
        a.dataset.autopdf = "1";
        const u = realUrl(a);
        if (!u || !supported.includes(u.hostname)) continue;
        u.hash = FLAG;
        const link = document.createElement("a");
        link.href = u.toString();
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "PDF";
        link.title = "autopdf: open and download the PDF";
        Object.assign(link.style, {
          display: "inline-block", marginLeft: "8px", padding: "1px 7px",
          font: "600 12px/1.5 system-ui, sans-serif", color: "#fff",
          background: "#2f5d8a", borderRadius: "4px", textDecoration: "none",
          verticalAlign: "middle",
        });
        // Put it after the title (Scholar: after the h3; Google: after the link),
        // so it is not inside the result's own link.
        const holder = a.closest("h3") || a;
        holder.parentElement.insertBefore(link, holder.nextSibling);
      }
    };
    scan();
    let pending = false; // Google loads more results as you scroll
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; scan(); }, 300);
    }).observe(document.body, { childList: true, subtree: true });
  }
})();
