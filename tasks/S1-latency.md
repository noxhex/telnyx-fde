# S1. Latency and cold start

**Type** Spike · **Code by** OpenCode in the scratch project · **Hands-on** Thiago

## Goal

Measure the numbers that decide the call setup design. Those are a cold start after idle, a warm request, a KV write and read from inside a function, and an actor round trip. The result sets `dynamic_variables_webhook_timeout_ms` and confirms or changes the latency budget in `docs/ARCHITECTURE.md`.

This spike also adds request-body logging to the smoke function, which spike S2 needs. Both changes go out in one ship.

## Where

The throwaway function in `~/code/scratch/smoke`, outside the repo. It already has a counter actor, and the KV namespace `fde-smoke` exists (`be378fe6-fb1b-4d9e-bf65-540d5b97c2c9`).

## Steps

1. In `~/code/scratch/smoke`, run OpenCode with this prompt (`opencode run --model telnyx/moonshotai/Kimi-K3 "<prompt>"`).

   > Add a KV binding named CACHE to telnyx.toml for the namespace with id be378fe6-fb1b-4d9e-bf65-540d5b97c2c9, using a [storage.kv.CACHE] block with an id field, and run telnyx-edge types afterwards. In src/index.ts add a GET /timing route that measures with performance.now() one env.CACHE.put of a small value, one env.CACHE.get of the same key, and one call to the existing counter actor, and returns JSON with kv_put_ms, kv_get_ms, actor_ms and container_age_ms. container_age_ms is the time since a startedAt constant defined at module scope. Also, for every POST request on any path, log one line to stdout with the path and the raw request body, then return 200 with the JSON body {"ok":true}. Keep the existing GET behaviour unchanged. Do not ship.

2. Read the diff yourself, then ship with `time telnyx-edge ship`, and note the ship time.
3. **Warm series.** Call `/timing` 20 times, one second apart, and save the output.

   ```bash
   B=https://smoke-0be3d15b-5.telnyxcompute.com
   for i in $(seq 20); do curl -sS "$B/timing"; echo; sleep 1; done | tee warm.jsonl
   ```

4. **Cold starts.** Leave the function idle for at least 30 minutes, then call `/timing` once. A small `container_age_ms` confirms a cold start. Repeat after another idle period, so there are at least two cold samples.
5. Pull the matching server-side durations with `telnyx-edge logs smoke --type invocations --since 2h --json`.

## Done when

- A table in `DEBUGLOG.md` under "S1 measurements" shows warm and cold values for request duration, KV put, KV get and actor round trip, with min, median and max for the warm series.
- `docs/ARCHITECTURE.md` (latency budget) carries the measured column.
- The chosen `dynamic_variables_webhook_timeout_ms` is recorded with its reasoning. As a starting rule, take the slowest cold call setup estimate times 1.5, rounded up to 500 ms, and keep it at 4000 ms or below, since every second of webhook time is silence on the call.
