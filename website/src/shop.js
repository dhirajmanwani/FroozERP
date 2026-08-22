// The storefront page.
//
// Framework-free on purpose. The brief asks for this to work on a mid-range Android
// on mobile data, and a framework would be most of the byte budget before a single
// price had rendered.
//
// All the logic worth testing lives in basket.js and availability.js, which have
// their own suites. This file is the wiring: fetch, render, listen.

import {
  AVAILABILITY,
  CLAMP_REASON,
  canOrder,
  clampToAvailable,
  describeFreshness,
  resolveAvailability,
} from "./availability.js";
import {
  addLine,
  basketRows,
  basketTotals,
  createBasket,
  describeLineRejection,
  formatKg,
  formatRatePerKg,
  formatRupees,
  setLineQuantity,
} from "./basket.js";

const CATALOGUE_URL = "./data/catalogue.sample.json";
const STEP_KG = 0.5;
const DEFAULT_KG = 1;

const el = (id) => document.getElementById(id);

const state = {
  catalogue: null,
  basket: createBasket(),
  quantities: new Map(), // productId -> kg the stepper is currently showing
};

// --- Rendering ---------------------------------------------------------------

// The shop is in Jodhpur, so a date the shop stamped is read in the shop's own
// time. Formatted in the viewer's timezone instead, a rate set on the 22nd shows as
// the 21st to anyone west of India - and "yesterday's rates" is exactly the thing
// this line exists to rule out.
const SHOP_TIME_ZONE = "Asia/Kolkata";

function shopDate(isoDate) {
  const date = new Date(`${isoDate}T00:00:00+05:30`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function renderRateLine(catalogue) {
  const date = shopDate(catalogue.ratesSetOn);
  el("rate-date").textContent = date
    ? `Rates set ${date.toLocaleDateString("en-IN", {
        timeZone: SHOP_TIME_ZONE, weekday: "long", day: "numeric", month: "long",
      })}`
    : "Today's rates";
}

function renderShop(shop) {
  el("shop-open").textContent = shop.openText || "";
  el("shop-address").textContent = `${shop.name} - ${shop.branch}, ${shop.address}`;
}

function renderReorder(catalogue) {
  const last = catalogue.lastOrder;
  if (!last || !Array.isArray(last.lines) || last.lines.length === 0) return;

  const placed = shopDate(last.placedOn);
  el("reorder-when").textContent = placed
    ? `Your last order, ${placed.toLocaleDateString("en-IN", {
        timeZone: SHOP_TIME_ZONE, day: "numeric", month: "long",
      })}`
    : "Your last order";

  el("reorder-lines").textContent = last.lines
    .map((line) => `${line.name} ${formatKg(line.quantityKg)}`)
    .join("  ·  ");

  el("reorder-button").addEventListener("click", () => {
    let added = 0;
    for (const line of last.lines) {
      const product = findProduct(line.productId);
      if (!product) continue;
      const availability = resolveAvailability(product);
      if (!canOrder(availability.state)) continue;
      const quantity = clampQuantity(line.quantityKg, availability);
      if (quantity <= 0) continue;
      state.basket = addLine(state.basket, {
        productId: product.id,
        name: product.name,
        ratePerKg: product.ratePerKg,
        quantityKg: quantity,
      });
      added += 1;
    }
    // Never silently do nothing. If none of last time's items can be reordered,
    // say why rather than leaving the button looking broken.
    const button = el("reorder-button");
    button.textContent = added === 0
      ? "None of those are available today"
      : `Added ${added} item${added === 1 ? "" : "s"}`;
    button.disabled = true;
    renderBasket();
  });

  el("reorder-section").hidden = false;
}

function chipFor(availability) {
  if (availability.state === AVAILABILITY.LIMITED) {
    return `<span class="chip chip-warn">Only ${formatKg(availability.availableKg)} left</span>`;
  }
  if (availability.state === AVAILABILITY.SOLD_OUT) {
    return `<span class="chip chip-out">Sold out today</span>`;
  }
  if (availability.state === AVAILABILITY.UNKNOWN) {
    // The whole reason availability.js exists. This must never look like "0 left".
    return `<span class="chip chip-unknown">Stock not confirmed</span>`;
  }
  // In stock needs no chip. A badge on every row is noise; its absence is the message.
  return "";
}

// The button has to say the true thing, and "Unavailable" is not it when the state
// is UNKNOWN - we did not fail to find the fruit, we failed to read the number. A
// customer told an item is unavailable does not ask again; a customer invited to ask
// often gets it, because the shop can see the shelf even when this page cannot.
function actionButton(product, availability, orderable) {
  if (orderable) {
    return `<button class="add-button" type="button" data-add>Add</button>`;
  }
  if (availability.state === AVAILABILITY.UNKNOWN) {
    return `<button class="ghost-button" type="button" data-ask>Ask the shop</button>`;
  }
  return `<button class="add-button" type="button" data-add disabled>Sold out</button>`;
}

function productCard(product, nowMs) {
  const availability = resolveAvailability(product);
  const orderable = canOrder(availability.state);
  const fresh = describeFreshness(product, nowMs);
  const quantity = state.quantities.get(product.id) ?? DEFAULT_KG;
  const tint = typeof product.tint === "string" ? product.tint : "";

  return `
    <article class="produce${orderable ? "" : " is-out"}" data-product="${escapeAttr(product.id)}">
      <div class="produce-photo"${tint ? ` style="background:${escapeAttr(tint)}"` : ""}>
        <span aria-hidden="true">${escapeHtml(product.initial || product.name.slice(0, 1))}</span>
      </div>
      <div class="produce-body">
        <div class="produce-name">${escapeHtml(product.name)}</div>
        ${product.variety ? `<div class="produce-variety">${escapeHtml(product.variety)}</div>` : ""}
        <div class="produce-price">${escapeHtml(formatRupees(product.ratePerKg))}<small> / kg</small></div>
        ${fresh ? `<div class="produce-fresh">${escapeHtml(fresh)}</div>` : ""}
        ${chipFor(availability)}
        ${availability.state === AVAILABILITY.UNKNOWN
          ? `<p class="small muted">${escapeHtml(availability.message)}</p>`
          : ""}
        <div class="produce-actions">
          <div class="stepper">
            <button type="button" data-step="-1" aria-label="Less ${escapeAttr(product.name)}"${orderable ? "" : " disabled"}>&minus;</button>
            <output class="num">${escapeHtml(formatKg(quantity))}</output>
            <button type="button" data-step="1" aria-label="More ${escapeAttr(product.name)}"${orderable ? "" : " disabled"}>+</button>
          </div>
          ${actionButton(product, availability, orderable)}
        </div>
      </div>
    </article>`;
}

function renderProduce() {
  const nowMs = Date.now();
  const products = state.catalogue.products || [];
  el("produce-count").textContent = `${products.length} today`;
  el("produce-region").innerHTML = `<div class="produce-list">${products
    .map((product) => productCard(product, nowMs))
    .join("")}</div>`;
}

function renderBasket() {
  const totals = basketTotals(state.basket);
  const bar = el("basket-bar");
  const hasLines = totals.lineCount > 0;

  bar.classList.toggle("is-visible", hasLines);
  bar.setAttribute("aria-hidden", hasLines ? "false" : "true");
  el("basket-total").textContent = formatRupees(totals.subtotal);
  el("basket-count").textContent = hasLines
    ? `${totals.lineCount} item${totals.lineCount === 1 ? "" : "s"} · ${formatKg(totals.totalKg)}`
    : "Basket is empty";

  // Line totals come from the module, already rounded, so a customer who adds the
  // printed lines up by hand gets the printed total.
  el("sheet-lines").innerHTML = basketRows(state.basket)
    .map(
      (row) => `
        <div class="basket-line">
          <div>
            <div class="basket-line-name">${escapeHtml(row.name)}</div>
            <div class="basket-line-meta">${escapeHtml(formatKg(row.quantityKg))} at ${escapeHtml(formatRatePerKg(row.ratePerKg))}</div>
          </div>
          <div class="basket-line-total">${escapeHtml(formatRupees(row.total))}</div>
          <button class="ghost-button" type="button" data-remove="${escapeAttr(row.productId)}">Remove</button>
        </div>`,
    )
    .join("");

  el("sheet-weight").textContent = formatKg(totals.totalKg);
  el("sheet-total").textContent = formatRupees(totals.subtotal);
}

// --- Failure states ----------------------------------------------------------
// A shop that could not be reached is not an empty shop, and must never look like
// one. This is the same rule as the app's: an error never renders as zero.

function renderLoadFailure(detail) {
  el("produce-region").innerHTML = `
    <div class="state state-error">
      <h3>We could not load today's stock</h3>
      <p>This is a problem at our end, not yours - the shop is open and the fruit is there. Please try again in a moment, or call the shop and we will take the order over the phone.</p>
      <p class="small">${escapeHtml(detail)}</p>
    </div>`;
}

// --- Events ------------------------------------------------------------------

function findProduct(productId) {
  const wanted = String(productId).trim();
  return (state.catalogue?.products || []).find((product) => String(product.id).trim() === wanted) || null;
}

// clampToAvailable deliberately returns a record rather than a number, because a
// zero from "nothing left" and a zero from "we could not check" are the same figure
// and completely different things to tell a customer. The page never reads the
// quantity without also reading why it is what it is.
function clampQuantity(requestedKg, availability) {
  const clamped = clampToAvailable(requestedKg, availability);
  return clamped.reason === CLAMP_REASON.UNKNOWN_STOCK ? 0 : clamped.quantityKg;
}

function onProduceClick(event) {
  const card = event.target.closest("[data-product]");
  if (!card) return;
  const product = findProduct(card.dataset.product);
  if (!product) return;

  const stepButton = event.target.closest("[data-step]");
  const addButton = event.target.closest("[data-add]");
  const askButton = event.target.closest("[data-ask]");

  if (askButton) {
    openWhatsApp(`Hello, do you have ${product.name} today? The website could not confirm the stock.`);
    return;
  }
  if (!stepButton && !addButton) return;

  const availability = resolveAvailability(product);
  const current = state.quantities.get(product.id) ?? DEFAULT_KG;

  if (stepButton) {
    const next = current + Number(stepButton.dataset.step) * STEP_KG;
    const bounded = Math.max(STEP_KG, clampQuantity(next, availability));
    state.quantities.set(product.id, bounded);
    card.querySelector("output").textContent = formatKg(bounded);
    return;
  }

  const quantity = clampQuantity(current, availability);
  if (quantity <= 0) return;

  const line = {
    productId: product.id,
    name: product.name,
    ratePerKg: product.ratePerKg,
    quantityKg: quantity,
  };
  // basket.js refuses a line whose rate did not load rather than pricing it at zero.
  // Say so, otherwise the button appears to do nothing at all.
  const rejection = describeLineRejection(line);
  if (rejection) {
    addButton.textContent = "Ask us for today's rate";
    addButton.disabled = true;
    const note = document.createElement("p");
    note.className = "small muted";
    note.textContent = rejection;
    addButton.closest(".produce-body").append(note);
    return;
  }

  state.basket = addLine(state.basket, line);
  addButton.textContent = "Added";
  addButton.classList.add("is-added");
  window.setTimeout(() => {
    addButton.textContent = "Add";
    addButton.classList.remove("is-added");
  }, 1400);
  renderBasket();
}

// WhatsApp is the channel, not email. The site's job is to hand off to it rather
// than build a second inbox nobody checks.
function openWhatsApp(message) {
  const phone = String(state.catalogue?.shop?.phone || "").replace(/[^0-9]/g, "");
  window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, "_blank", "noopener");
}

function openSheet(open) {
  el("sheet").classList.toggle("is-open", open);
  el("sheet").setAttribute("aria-hidden", open ? "false" : "true");
  el("sheet-scrim").classList.toggle("is-open", open);
  document.body.style.overflow = open ? "hidden" : "";
}

function wireEvents() {
  el("produce-region").addEventListener("click", onProduceClick);
  el("basket-open").addEventListener("click", () => openSheet(true));
  el("sheet-close").addEventListener("click", () => openSheet(false));
  el("sheet-scrim").addEventListener("click", () => openSheet(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") openSheet(false);
  });

  el("sheet-lines").addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove]");
    if (!remove) return;
    state.basket = setLineQuantity(state.basket, remove.dataset.remove, 0);
    renderBasket();
    if (basketTotals(state.basket).lineCount === 0) openSheet(false);
  });

  el("sheet-action").addEventListener("click", () => {
    const totals = basketTotals(state.basket);
    const lines = basketRows(state.basket)
      .map((row) => `${row.name} - ${formatKg(row.quantityKg)} - ${formatRupees(row.total)}`)
      .join("\n");
    openWhatsApp(
      `Frooz order\n\n${lines}\n\nTotal about ${formatRupees(totals.subtotal)}\n\nPlease confirm the weight and final bill.`,
    );
  });
}

// --- Escaping ----------------------------------------------------------------
// Everything below comes from a catalogue feed, which is data and not markup.

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

const escapeAttr = escapeHtml;

// --- Boot --------------------------------------------------------------------

async function boot() {
  wireEvents();
  try {
    const response = await fetch(CATALOGUE_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`The catalogue request came back ${response.status}.`);
    const catalogue = await response.json();
    if (!catalogue || !Array.isArray(catalogue.products)) {
      throw new Error("The catalogue came back without a product list.");
    }
    state.catalogue = catalogue;
    renderRateLine(catalogue);
    renderShop(catalogue.shop || {});
    renderProduce();
    renderReorder(catalogue);
    renderBasket();
  } catch (error) {
    renderLoadFailure(error?.message || String(error));
  }
}

boot();
