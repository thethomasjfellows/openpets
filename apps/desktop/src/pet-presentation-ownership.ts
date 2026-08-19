const activeConversationLeases = new Set<number>();
let nextConversationLeaseId = 0;

/**
 * Gives a live voice conversation temporary ownership of the default pet's
 * transient presentation. Background agent reactions may resume after every
 * acquired lease is released.
 */
export function acquireDefaultPetConversationPresentation(): () => void {
  const leaseId = ++nextConversationLeaseId;
  activeConversationLeases.add(leaseId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeConversationLeases.delete(leaseId);
  };
}

export function isDefaultPetConversationPresentationActive(): boolean {
  return activeConversationLeases.size > 0;
}
