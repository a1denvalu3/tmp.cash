import { WebSocketServer } from "ws";
import { verifyEvent, type Event } from "nostr-tools/pure";
import { matchFilter } from "nostr-tools/filter";

/** A disposable NIP-01/42 relay; challenge and operation rejection deliberately race. */
export async function testRelay(authRequired = true) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing relay port");
  const url = `ws://127.0.0.1:${address.port}/`;
  const events = new Map<string, Event>();
  const auth: Event[] = [];
  const state = {
    rejectWrites: false,
    rejectAuth: false,
    dropNextAck: false,
    refused: 0,
  };
  server.on("connection", (socket) => {
    const challenge = crypto.randomUUID();
    let pubkey = "";
    // Sent after the first request too, to exercise auth-required retry paths.
    if (authRequired) socket.send(JSON.stringify(["AUTH", challenge]));
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      const send = (value: unknown) => socket.send(JSON.stringify(value));
      if (message[0] === "AUTH") {
        const event = message[1] as Event;
        const valid =
          !state.rejectAuth &&
          verifyEvent(event) &&
          event.kind === 22242 &&
          event.tags.some((t) => t[0] === "relay" && t[1] === url) &&
          event.tags.some((t) => t[0] === "challenge" && t[1] === challenge);
        auth.push(event);
        if (valid) pubkey = event.pubkey;
        send(["OK", event.id, valid, valid ? "" : "restricted: denied"]);
      }
      if (message[0] === "EVENT") {
        const event = message[1] as Event;
        if (authRequired && pubkey !== event.pubkey) {
          state.refused++;
          send(["OK", event.id, false, "auth-required: authenticate first"]);
          return;
        }
        if (state.rejectWrites || !verifyEvent(event)) {
          send(["OK", event.id, false, "restricted: write refused"]);
          return;
        }
        if (event.kind === 30078) {
          const d = event.tags.find((t) => t[0] === "d")?.[1];
          for (const previous of events.values())
            if (
              previous.kind === event.kind &&
              previous.pubkey === event.pubkey &&
              previous.tags.some((t) => t[0] === "d" && t[1] === d)
            ) {
              if (
                previous.created_at > event.created_at ||
                (previous.created_at === event.created_at &&
                  previous.id < event.id)
              ) {
                send(["OK", event.id, true, ""]);
                return;
              }
              events.delete(previous.id);
            }
        }
        events.set(event.id, event);
        if (state.dropNextAck) {
          state.dropNextAck = false;
          socket.close();
          return;
        }
        send(["OK", event.id, true, ""]);
      }
      if (message[0] === "REQ") {
        const [, id, filter] = message;
        if (authRequired && !pubkey) {
          state.refused++;
          send(["CLOSED", id, "auth-required: authenticate first"]);
          return;
        }
        const matches = [...events.values()]
          .filter(
            (e) =>
              matchFilter(filter, e) && (!authRequired || e.pubkey === pubkey),
          )
          .sort(
            (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
          )
          .slice(0, filter.limit ?? 1000);
        for (const event of matches) send(["EVENT", id, event]);
        send(["EOSE", id]);
      }
    });
  });
  return {
    url,
    events,
    auth,
    state,
    close: async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
