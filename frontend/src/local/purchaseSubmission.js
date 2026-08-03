const defaultOperationId = () => globalThis.crypto?.randomUUID?.() ||
  `purchase-${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const createPurchaseSubmissionTracker = (createOperationId = defaultOperationId) => {
  let active = { fingerprint: "", operationId: "" };

  return {
    resolve(intent) {
      const fingerprint = JSON.stringify(intent);
      if (active.fingerprint !== fingerprint || !active.operationId) {
        active = { fingerprint, operationId: createOperationId() };
      }
      return active.operationId;
    },
    complete(operationId) {
      if (active.operationId === operationId) {
        active = { fingerprint: "", operationId: "" };
      }
    },
  };
};
