// The order tracking page.
//
// The brief calls this the screen that has to be right: it is the one a customer
// opens more than once, and the one that decides whether they order again.
//
// The four stages are the same four the app uses - received, packed, sent,
// delivered - on purpose. A customer and a shop describing the same parcel
// differently is how a support conversation starts.

import { addLine, basketRows, basketTotals, createBasket, formatKg, formatRupees } from "./basket.js";

const ORDER_URL = "./data/order.sample.json";
const el = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

// Stage times are the shop's times. Rendered in the viewer's timezone, a parcel
// packed at 10am in Jodhpur reads as 4:30am to anyone abroad, and the timeline stops
// making sense.
const SHOP_TIME_ZONE = "Asia/Kolkata";

function timeOf(iso) {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleString("en-IN", {
    timeZone: SHOP_TIME_ZONE,
    day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true,
  });
}

function renderStages(order) {
  const stages = Array.isArray(order.stages) ? order.stages : [];
  const currentIndex = stages.findIndex((stage) => stage.id === order.status);

  el("stages").innerHTML = stages
    .map((stage, index) => {
      const done = currentIndex >= 0 && index < currentIndex;
      const current = index === currentIndex;
      const when = timeOf(stage.at);
      // A stage with no timestamp has not happened. It says so plainly rather than
      // showing a blank line the customer has to interpret.
      const detail = when || (current ? "Happening now" : "Not yet");
      return `
        <li class="stage${done ? " is-done" : ""}${current ? " is-current" : ""}">
          <span class="stage-dot" aria-hidden="true">${done ? "&check;" : index + 1}</span>
          <div class="stage-body">
            <div class="stage-name">${escapeHtml(stage.name)}</div>
            <div class="stage-when">${escapeHtml(detail)}</div>
          </div>
        </li>`;
    })
    .join("");

  const currentStage = stages[currentIndex];
  el("order-headline").textContent = currentStage ? currentStage.name : "Order received";
  el("order-sub").textContent = currentIndex === stages.length - 1
    ? "This order is complete. Thank you."
    : "We will update this page as it moves. No need to refresh.";
}

function renderCarrier(order) {
  const carrier = order.carrier || {};
  el("carrier-rows").innerHTML = [
    ["Service", carrier.name],
    ["Rider", carrier.rider],
  ]
    .filter(([, value]) => value)
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("");

  const link = el("carrier-link");
  if (carrier.trackingUrl) {
    link.href = carrier.trackingUrl;
    link.hidden = false;
  } else {
    link.hidden = true;
  }
}

function renderLines(order) {
  const lines = Array.isArray(order.lines) ? order.lines : [];

  // Totals come from the same basket module the storefront uses, so the number here
  // and the number the customer saw when ordering are produced by one piece of code.
  let basket = createBasket();
  for (const line of lines) {
    basket = addLine(basket, {
      productId: line.productId,
      name: line.name,
      ratePerKg: line.ratePerKg,
      quantityKg: line.quantityKg,
    });
  }
  const totals = basketTotals(basket);

  el("order-lines").innerHTML = basketRows(basket)
    .map(
      (row) =>
        `<dt>${escapeHtml(row.name)} <span class="muted">${escapeHtml(formatKg(row.quantityKg))}</span></dt>` +
        `<dd>${escapeHtml(formatRupees(row.total))}</dd>`,
    )
    .join("");

  el("order-weight").textContent = formatKg(totals.totalKg);
  el("order-total").textContent = formatRupees(totals.subtotal);

  const payment = order.payment || {};
  el("payment-line").textContent = payment.state === "paid"
    ? `Paid${payment.method ? ` by ${payment.method}` : ""}.`
    : "To be paid on delivery.";
}

function renderFailure(detail) {
  el("order-headline").textContent = "We could not find that order";
  el("order-sub").textContent = "";
  el("order-failure").innerHTML = `
    <div class="state state-error">
      <h3>Nothing came back for this reference</h3>
      <p>The order may still exist - this page could not reach us to check. Message the shop with your order number and we will tell you exactly where it is.</p>
      <p class="small">${escapeHtml(detail)}</p>
    </div>`;
}

async function boot() {
  const reference = new URLSearchParams(window.location.search).get("ref");
  try {
    const response = await fetch(ORDER_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`The order request came back ${response.status}.`);
    const order = await response.json();
    if (!order || !Array.isArray(order.stages)) {
      throw new Error("The order came back without any stages on it.");
    }
    el("order-ref").textContent = `Order ${reference || order.reference || ""}`.trim();
    renderStages(order);
    renderCarrier(order);
    renderLines(order);
    el("order-body").hidden = false;
  } catch (error) {
    renderFailure(error?.message || String(error));
  }
}

boot();
