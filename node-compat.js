// Node 24's bundled undici (7.x) calls socket.setTypeOfService() on every HTTP/1.1
// write without a catch. On macOS, a socket whose peer has just reset makes that call
// throw EINVAL from inside an I/O callback, where no try/catch around fetch() can reach
// it, so the whole process exits (#140: a secondary died this way exactly when its
// primary went away, instead of taking the bridge port over). undici 8.8.0 ignores
// these errors (nodejs/undici#5547, Node 26.5.1+); Node 24 never got the fix.
// Swallowing only EINVAL leaves the request to fail the ordinary way, as a rejected
// fetch. Type of service is a QoS hint, so skipping it changes nothing else.
export function ignoreTypeOfServiceEinval(proto) {
  const original = proto.setTypeOfService;
  if (typeof original !== "function" || original.ignoresEinval) return;
  const wrapped = function (...args) {
    try {
      return original.apply(this, args);
    } catch (err) {
      if (err?.code === "EINVAL") return this;
      throw err;
    }
  };
  wrapped.ignoresEinval = true;
  proto.setTypeOfService = wrapped;
}
