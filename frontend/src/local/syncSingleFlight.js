/**
 * One sync cycle at a time, and a forced request is never satisfied by a cycle that started
 * before it was made.
 *
 * `syncNow` used to hand every caller the cycle already running. That is right for the
 * background timer, but a forced sync (after saving a Stock Arrival) that landed mid-cycle got a
 * cycle whose push had already gone out -- so the purchase just saved waited for the next timer
 * tick. Now a forced request that finds a cycle running waits for it to finish and then runs one
 * more. Forced requests that arrive while that follow-up is still waiting share it rather than
 * queueing a cycle each.
 */
export function createSingleFlight() {
  let running = null;
  let followUp = null;

  const start = (task) => {
    const cycle = Promise.resolve().then(task);
    running = cycle;
    // Registered first, so it runs before anything that awaits this cycle.
    const clear = () => {
      if (running === cycle) running = null;
    };
    cycle.then(clear, clear);
    return cycle;
  };

  const run = (task, { force = false } = {}) => {
    if (!running) return start(task);
    if (!force) return running;
    if (!followUp) {
      const waitFor = running;
      followUp = waitFor
        .catch(() => null)
        .then(() => {
          followUp = null;
          // A cycle someone else started after the one waited on also started after this
          // request, so it is joined instead of running two back to back.
          return running || start(task);
        });
    }
    return followUp;
  };

  return {
    run,
    isRunning: () => running !== null,
  };
}
