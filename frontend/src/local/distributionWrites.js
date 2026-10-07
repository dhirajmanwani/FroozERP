/**
 * What the consignment board sends, as opposed to what it shows (`stockDistribution.js`).
 *
 * 1. **Ids go as given.** A counter names products and lots by its snapshot ids ("product-12", a
 *    lot's global id). The server resolves those within the company (`resolveEntityReference` in
 *    backend/operationalV3.js), so they are sent as opaque canonical strings — never `Number()`,
 *    which turned "product-12" into NaN.
 * 2. **Actions are posted to the server's own row id** (`serverId`), falling back to the described
 *    id only when the row carried none.
 * 3. **No button that can only fail.** "Receive part" and "Take back in" need a quantity per line
 *    (RECEIVED_QUANTITY_REQUIRED / RETURNED_QUANTITY_REQUIRED) and this screen has nowhere to type
 *    one, so pressing either always came back 422. They are not drawn; the board says so instead
 *    of leaving the cell looking as if there were nothing to do.
 */
import { canonicalInventoryId } from "./stockInventory.js";

export const transferItemsForSend = (lines = []) => (Array.isArray(lines) ? lines : []).map((line) => ({
  product_id: canonicalInventoryId(line?.product_id),
  source_lot_id: canonicalInventoryId(line?.source_lot_id),
  requested_quantity: line?.requested_quantity,
}));

export const transferItemsForRequest = (lines = []) => (Array.isArray(lines) ? lines : []).map((line) => ({
  product_id: canonicalInventoryId(line?.product_id),
  requested_quantity: line?.requested_quantity,
}));

export const crateAllocationsForApproval = (choices = []) => (Array.isArray(choices) ? choices : []).map((choice) => ({
  source_lot_id: canonicalInventoryId(choice?.source_lot_id),
  quantity: Number(choice?.quantity),
}));

export const transferActionId = (entry) => {
  const serverId = canonicalInventoryId(entry?.serverId);
  return serverId || canonicalInventoryId(entry?.id);
};

export const UNDRAWN_TRANSFER_ACTIONS = Object.freeze(["partial_receive", "source_receive"]);

export const UNDRAWN_TRANSFER_ACTION_NOTE =
  "Recording part of a delivery, or goods taken back in, needs a quantity for each line and cannot be done on this screen yet.";

/** The actions the board draws as buttons, and whether any were held back. */
export const drawableTransferActions = (actions = []) => {
  const all = Array.isArray(actions) ? actions : [];
  const drawn = all.filter((option) => !UNDRAWN_TRANSFER_ACTIONS.includes(option?.action));
  return { drawn, heldBack: drawn.length < all.length };
};
