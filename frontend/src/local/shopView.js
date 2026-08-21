/**
 * Which shop the Owner is looking at, and what the screen must say about it.
 *
 * Viewing another shop replaces the session token with one minted for that shop, so **every screen
 * in the app silently changes meaning**. The Dashboard, the Report Center, the stock list — all of
 * them keep their titles and start showing somebody else's numbers. That is the whole feature, and
 * it is also the whole danger: an Owner who forgets which shop they picked will read another
 * branch's takings as their own.
 *
 * So the rule this module exists to enforce is that the app can never be *quietly* pointed
 * somewhere else. If `isViewingOther` is true there is always a banner, and it always names the
 * shop. The backend refuses writes in that state; this makes sure the person can tell why.
 */

export const SHOP_VIEW_STATUS = Object.freeze({
  HIDDEN: "hidden",
  LOADING: "loading",
  UNAVAILABLE: "unavailable",
  READY: "ready",
});

const asId = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

/**
 * @param {object} input
 * @param {string} input.loadState "idle" | "loading" | "loaded" | "error"
 * @param {string} input.loadError message from a failed request
 * @param {boolean} input.offline this device cannot reach the backend
 * @param {boolean} input.isOwner only the Owner may switch shops
 * @param {Array} input.branches [{ id, branch_name }]
 * @param {number} input.ownBranchId the shop this login actually belongs to
 * @param {number} input.viewingBranchId the shop currently being shown
 * @param {boolean} input.viewOnly the session cannot write
 */
export const resolveShopViewPresentation = ({
  loadState = "idle",
  loadError = "",
  offline = false,
  isOwner = false,
  branches = [],
  ownBranchId = null,
  viewingBranchId = null,
  viewOnly = false,
} = {}) => {
  const shops = (Array.isArray(branches) ? branches : [])
    .map((branch) => ({ id: asId(branch?.id), name: branch?.branch_name || `Shop ${branch?.id}` }))
    .filter((branch) => branch.id !== null);
  const own = asId(ownBranchId);
  const viewing = asId(viewingBranchId);
  const isViewingOther = Boolean(viewOnly) || (own !== null && viewing !== null && own !== viewing);
  const viewingShop = shops.find((shop) => shop.id === viewing) || null;
  const viewingName = viewingShop ? viewingShop.name : (viewing === null ? "" : `Shop ${viewing}`);

  // The banner is computed first and independently of every other state below. Whatever else is
  // unknown — the shop list failed to load, the device went offline mid-session — if the session is
  // pointed at another shop the person has to be told, because the screens around it will not.
  const banner = isViewingOther
    ? {
      shopName: viewingName || "another shop",
      text: `You are viewing ${viewingName || "another shop"}. Nothing can be saved while you are here.`,
      returnLabel: "Back to my shop",
      returnBranchId: own,
    }
    : null;

  if (!isOwner) {
    // Not a permission message. Staff have exactly one shop, so there is nothing here to offer and
    // nothing to explain — an explanation would only advertise a door they cannot open.
    return { status: SHOP_VIEW_STATUS.HIDDEN, shops: [], banner: null, isViewingOther: false, viewingBranchId: viewing, message: "" };
  }
  if (offline) {
    return {
      status: banner ? SHOP_VIEW_STATUS.UNAVAILABLE : SHOP_VIEW_STATUS.HIDDEN,
      shops: [],
      banner,
      isViewingOther,
      viewingBranchId: viewing,
      message: "Switching shops needs a connection.",
    };
  }
  if (loadState === "idle" || loadState === "loading") {
    return { status: SHOP_VIEW_STATUS.LOADING, shops: [], banner, isViewingOther, viewingBranchId: viewing, message: "" };
  }
  if (loadState === "error" || loadError) {
    return {
      status: SHOP_VIEW_STATUS.UNAVAILABLE,
      shops: [],
      banner,
      isViewingOther,
      viewingBranchId: viewing,
      message: loadError || "The shop list could not be loaded.",
    };
  }
  // One shop is the normal case for this business today, and a picker offering a single choice is
  // clutter that also implies the feature is broken. It appears when there is something to pick.
  if (shops.length < 2) {
    return { status: SHOP_VIEW_STATUS.HIDDEN, shops, banner, isViewingOther, viewingBranchId: viewing, message: "" };
  }
  return { status: SHOP_VIEW_STATUS.READY, shops, banner, isViewingOther, viewingBranchId: viewing, message: "" };
};

/** True when the picker itself should be on screen. */
export const shopPickerVisible = (presentation) =>
  Boolean(presentation && presentation.status === SHOP_VIEW_STATUS.READY);
