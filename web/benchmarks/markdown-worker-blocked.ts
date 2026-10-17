// Browser benchmark only: exercise terminate() after synchronous work started.
self.onmessage = () => {
  self.postMessage({ probe: "entered" });
  while (true) { /* A message-based cancellation cannot interrupt this loop. */ }
};
