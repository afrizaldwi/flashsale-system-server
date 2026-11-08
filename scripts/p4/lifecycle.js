"use strict";
async function observePrimaryUnavailable(docker, id, requestedAt, now = () => new Date().toISOString()) {
  const observedAt = now();
  const evidence = { id, requestedAt, observedAt, verified: false, events: [] };
  try {
    const raw = await docker.command(["events", "--since", requestedAt, "--until", observedAt,
      "--filter", `container=${id}`, "--filter", "event=die", "--format", "{{json .}}"]);
    // Docker encodes nanoseconds as a JSON integer larger than JS safe integers.
    evidence.events = raw.split(/\r?\n/).filter(Boolean).map(line =>
      JSON.parse(line.replace(/("timeNano"\s*:\s*)(\d+)/g, '$1"$2"')));
    let state;
    try {
      const [container] = JSON.parse(await docker.command(["inspect", "--type", "container", id]));
      state = container.State;
      evidence.containerState = state;
      if (container.Id !== id || state.Running !== false) throw new Error("Primary identity/state not fenced");
    } catch (error) {
      if (!/No such (object|container)/i.test(error.message)) throw error;
      evidence.containerAbsent = true;
    }
    const death = evidence.events.find(e => (e.Actor?.ID || e.id) === id && (e.Action || e.status) === "die");
    const eventMs = death?.timeNano ? Number(BigInt(death.timeNano) / 1000000n) : death?.time ? Number(death.time) * 1000 : NaN;
    const finishedMs = state?.FinishedAt ? Date.parse(state.FinishedAt) : NaN;
    const ms = Number.isFinite(eventMs) ? eventMs : finishedMs;
    if (!Number.isFinite(ms) || ms < Date.parse(requestedAt) || ms > Date.parse(observedAt))
      throw new Error("No reliable post-injection Docker death/finished timestamp");
    evidence.primaryUnavailableAt = new Date(ms).toISOString();
    evidence.timestampSource = Number.isFinite(eventMs) ? "docker-die-event" : "docker-inspect-finished";
    evidence.verified = true;
  } catch (error) { evidence.error = error.message; }
  return evidence;
}
module.exports = { observePrimaryUnavailable };
